// Hat Meclisi: a shared transit map for Turkey. Anyone can draw a line, propose
// alternative alignments for it, vote, and import the lines that already exist.

import { createBackend, storageGet, storageSet } from './backend.js';
import { t, setLang, lang, fmt, ago, date } from './i18n.js';
import { EMPTY_CENTER, boundsOf, simplify } from './geo.js';
import { MODES, MODE_KEYS, PALETTE, LIMITS, parseLine, serializeLine, toDraft, corridors, stats, lineToGeoJSON, stationsToGeoJSON } from './model.js';
import { Editor } from './editor.js';
import { fetchOSM, parseFile } from './importers.js';

const MAX_BATCH = 40;
const STATION_ZOOM = 12;

const $ = (s, root = document) => root.querySelector(s);

function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'style') e.style.cssText = v;
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else if (k in e) e[k] = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k instanceof Node ? k : String(k));
  return e;
}

// replaceChildren() would print null as "null".
const fill = (node, ...kids) => node.replaceChildren(...kids.flat().filter((k) => k != null && k !== false));

// Leaflet tooltips take HTML; names come from other people, so pass text nodes.
const textEl = (s) => el('span', {}, s);

const S = {
  lines: new Map(),
  corr: new Map(),
  votes: new Map(),
  feed: [],
  selected: null,
  tab: storageGet('hm-tab') || 'props',
  view: 'win',
  showExisting: true,
  hideNegative: true,
  query: '',
  editing: null,
  importing: null,
  busy: false,
  cooldownUntil: 0,
  status: 'connecting',
  corridors: [],
};
let backend = null;

// ---- map -------------------------------------------------------------------------

setLang(lang);
const dark = matchMedia('(prefers-color-scheme: dark)').matches;

const map = L.map('map', {
  minZoom: 5,
  maxBounds: [[31, 19], [46.5, 51]],
  maxBoundsViscosity: 0.7,
  zoomSnap: 0.5,
}).setView(EMPTY_CENTER, 6);
// OpenStreetMap's own tiles (attribution required, no key); css/style.css mutes them so
// the transit lines stand out, and inverts them in dark mode.
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  className: 'hm-base',
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);
const ormLayer = L.tileLayer('https://{s}.tiles.openrailwaymap.org/standard/{z}/{x}/{y}.png', {
  subdomains: 'abc',
  maxZoom: 19,
  opacity: 0.7,
  attribution: '<a href="https://www.openrailwaymap.org/">OpenRailwayMap</a> (CC BY-SA)',
});

const pane = (name, z) => {
  map.createPane(name).style.zIndex = z;
  return L.canvas({ pane: name, padding: 0.4, tolerance: 7 });
};
const R = { existing: pane('hm-existing', 410), proposals: pane('hm-proposals', 420), stations: pane('hm-stations', 430), highlight: pane('hm-highlight', 440), preview: pane('hm-preview', 450) };
const G = {
  existing: L.layerGroup().addTo(map),
  proposals: L.layerGroup().addTo(map),
  stations: L.layerGroup().addTo(map),
  highlight: L.layerGroup().addTo(map),
  preview: L.layerGroup().addTo(map),
};

function visibleProposals() {
  const out = [];
  for (const c of S.corridors) {
    for (const l of c.lines) {
      const win = l === c.winner;
      if (S.view === 'win' && !win) continue;
      if (S.hideNegative && l.tally.score < 0) continue;
      if (S.editing?.id === l.id) continue;
      out.push({ l, win });
    }
  }
  return out;
}

function drawLines() {
  G.existing.clearLayers();
  G.proposals.clearLayers();
  if (S.showExisting) {
    for (const l of S.lines.values()) {
      if (l.kind !== 'e' || S.editing?.id === l.id) continue;
      const pl = L.polyline(l.segs, { renderer: R.existing, color: l.color, weight: MODES[l.mode].weight - 0.5, opacity: 0.6, bubblingMouseEvents: false });
      pl.on('click', () => select(l.id));
      pl.bindTooltip(textEl(l.name), { sticky: true, className: 'hm-tip' });
      pl.addTo(G.existing);
    }
  }
  for (const { l, win } of visibleProposals()) {
    const w = MODES[l.mode].weight;
    L.polyline(l.segs, { renderer: R.proposals, color: dark ? '#111' : '#fff', weight: w + 3, opacity: win ? 0.9 : 0.5, interactive: false }).addTo(G.proposals);
    const pl = L.polyline(l.segs, { renderer: R.proposals, color: l.color, weight: w, opacity: win ? 0.95 : 0.6, dashArray: win ? null : '8 7', bubblingMouseEvents: false });
    pl.on('click', () => select(l.id));
    pl.bindTooltip(textEl(l.name), { sticky: true, className: 'hm-tip' });
    pl.addTo(G.proposals);
  }
  drawStations();
  drawHighlight();
}

function drawStations() {
  G.stations.clearLayers();
  if (map.getZoom() < STATION_ZOOM) return;
  const view = map.getBounds().pad(0.1);
  const shown = [...(S.showExisting ? [...S.lines.values()].filter((l) => l.kind === 'e' && S.editing?.id !== l.id) : []), ...visibleProposals().map((x) => x.l)];
  for (const l of shown) {
    for (const s of l.stations) {
      if (!view.contains([s.lat, s.lng])) continue;
      L.circleMarker([s.lat, s.lng], { renderer: R.stations, radius: map.getZoom() >= 14 ? 5 : 4, color: l.color, weight: 2, fillColor: '#fff', fillOpacity: 1, bubblingMouseEvents: false })
        .bindTooltip(textEl(s.name || '—'), { direction: 'top', offset: [0, -4], className: 'hm-tip' })
        .on('click', () => select(l.id))
        .addTo(G.stations);
    }
  }
}

function drawHighlight() {
  G.highlight.clearLayers();
  const l = S.lines.get(S.selected);
  if (!l || S.editing) return;
  const w = MODES[l.mode].weight + 2;
  L.polyline(l.segs, { renderer: R.highlight, color: dark ? '#000' : '#fff', weight: w + 6, opacity: 0.95, interactive: false }).addTo(G.highlight);
  L.polyline(l.segs, { renderer: R.highlight, color: l.color, weight: w, opacity: 1, interactive: false }).addTo(G.highlight);
  const labels = map.getZoom() >= STATION_ZOOM;
  for (const s of l.stations) {
    const m = L.circleMarker([s.lat, s.lng], { renderer: R.highlight, radius: 5.5, color: l.color, weight: 3, fillColor: '#fff', fillOpacity: 1 }).addTo(G.highlight);
    if (s.name) m.bindTooltip(textEl(s.name), { permanent: labels, direction: 'right', offset: [6, 0], className: labels ? 'hm-st-label' : 'hm-tip' });
  }
}

map.on('zoomend moveend', () => { drawStations(); drawHighlight(); });
map.on('click', () => { if (!S.editing && !S.importing && S.selected) select(null); });

// ---- data ------------------------------------------------------------------------

let rebuildQueued = false;
function rebuild() {
  if (rebuildQueued) return;
  rebuildQueued = true;
  requestAnimationFrame(() => {
    rebuildQueued = false;
    S.corridors = corridors(S.lines, S.corr, S.votes, backend?.uid);
    drawLines();
    renderList();
    renderDetail();
  });
}

const handlers = {
  line(id, node) {
    const l = node ? parseLine(id, node) : null;
    if (l) S.lines.set(id, l);
    else S.lines.delete(id);
    if (!l && S.selected === id) S.selected = null;
    rebuild();
    if (pendingHash === id && l) { pendingHash = null; select(id, true); }
  },
  corr(id, node) {
    if (node) S.corr.set(id, node);
    else S.corr.delete(id);
    rebuild();
  },
  votes(id, node) {
    if (node) S.votes.set(id, node);
    else S.votes.delete(id);
    rebuild();
  },
  log(id, e, live) {
    if (!e || S.feed.some((f) => f.id === id)) return;
    S.feed.push({ id, ...e });
    S.feed.sort((a, b) => (a.id < b.id ? 1 : -1));
    if (S.feed.length > 80) S.feed.length = 80;
    if (S.tab === 'feed') renderList();
    if (live && e.u !== backend?.uid) toast(feedText(e), 3500);
  },
  status(kind) {
    S.status = kind;
    renderStatus();
  },
  cooldown(until) {
    S.cooldownUntil = until;
    tick();
  },
};

// ---- selection & detail card -----------------------------------------------------

let pendingHash = (location.hash.match(/^#l=(.+)$/) || [])[1] || null;
if (pendingHash) pendingHash = decodeURIComponent(pendingHash);

function select(id, fly = false) {
  S.selected = id;
  history.replaceState(null, '', id ? `#l=${encodeURIComponent(id)}` : location.pathname + location.search);
  const l = S.lines.get(id);
  if (l && fly) {
    const b = boundsOf(l.segs, l.stations);
    // Keep the line clear of the detail card (right side) or bottom sheet (phones).
    const narrow = innerWidth < 760;
    if (b) map.flyToBounds(b, { paddingTopLeft: [40, 40], paddingBottomRight: narrow ? [40, Math.round(innerHeight * 0.6)] : [400, 40], maxZoom: 14, duration: 0.6 });
  }
  drawHighlight();
  renderDetail();
  renderList();
  if (id && innerWidth < 760) $('#panel').classList.remove('open');
}

function modeName(m) { return t(`m_${m}`); }

function costText(million) {
  if (!million) return null;
  return million >= 1000 ? t('billion', { n: fmt(million / 1000) }) : t('million', { n: fmt(million, 0) });
}

function voteBox(l, compact = false) {
  const { up, down, score, mine } = l.tally || { up: 0, down: 0, score: 0, mine: 0 };
  return el('span', { class: `vote${compact ? ' compact' : ''}` },
    el('button', { class: `up${mine === 1 ? ' on' : ''}`, title: t('support'), 'aria-label': t('support'), onclick: (e) => { e.stopPropagation(); vote(l, mine === 1 ? 0 : 1); } }, '▲'),
    el('b', { title: t('votes', { u: up, d: down }) }, score > 0 ? `+${score}` : String(score)),
    el('button', { class: `down${mine === -1 ? ' on' : ''}`, title: t('oppose'), 'aria-label': t('oppose'), onclick: (e) => { e.stopPropagation(); vote(l, mine === -1 ? 0 : -1); } }, '▼'),
  );
}

async function vote(l, v) {
  if (!backend) return;
  const before = S.votes.get(l.id);
  const next = { ...(before || {}) };
  if (v) next[backend.uid] = v;
  else delete next[backend.uid];
  S.votes.set(l.id, next);
  rebuild();
  try {
    await backend.vote(l.id, v);
  } catch {
    if (before) S.votes.set(l.id, before);
    else S.votes.delete(l.id);
    rebuild();
    toast(t('voteFailed'));
  }
}

function renderDetail() {
  const box = $('#detail');
  const l = S.lines.get(S.selected);
  if (!l || S.editing || S.importing) { box.hidden = true; return; }
  box.hidden = false;
  const st = stats(l.segs, l.stations, l.mode);
  const corr = l.kind === 'p' ? S.corridors.find((c) => c.id === l.corridor) : null;
  const mine = backend && l.author === backend.uid;
  const rank = corr ? corr.lines.indexOf(l) + 1 : 0;
  fill(box,
    el('header', {},
      el('span', { class: 'sw big', style: `background:${l.color}` }),
      el('div', { class: 'grow' },
        el('h2', {}, l.name),
        el('div', { class: 'sub' },
          el('span', { class: `badge ${l.kind === 'e' ? 'built' : 'prop'}` }, l.kind === 'e' ? t('kindE') : t('kindP')),
          el('span', { class: 'badge' }, modeName(l.mode)),
          corr && corr.winner === l && corr.lines.length > 1 ? el('span', { class: 'badge win' }, t('leading')) : null,
        ),
      ),
      el('button', { class: 'icon close', 'aria-label': t('close'), onclick: () => select(null) }, '×'),
    ),
    l.kind === 'p' ? el('div', { class: 'votes-row' }, voteBox(l), el('small', {}, t('votes', { u: l.tally.up, d: l.tally.down }))) : null,
    corr && corr.lines.length > 1 ? el('p', { class: 'corr-line' },
      `${t('corridor')}: `, el('b', {}, corr.title), ` · ${t('rankOf', { r: rank, n: corr.lines.length })}`) : null,
    el('dl', { class: 'stats' },
      el('div', {}, el('dt', {}, t('length')), el('dd', {}, `${fmt(st.km)} km`)),
      el('div', {}, el('dt', {}, t('stations')), el('dd', {}, String(st.stations))),
      st.stations > 1 ? el('div', {}, el('dt', {}, t('spacing')), el('dd', {}, `${fmt(st.spacing, 2)} km`)) : null,
      l.kind === 'p' && costText(st.cost) ? el('div', { title: t('costNote') }, el('dt', {}, `${t('cost')}*`), el('dd', {}, costText(st.cost))) : null,
    ),
    l.desc ? el('p', { class: 'desc' }, l.desc) : null,
    el('p', { class: 'meta' }, t('by', { name: l.nick || t('someone'), date: date(l.created) }), l.osm ? [' · ', el('a', { href: `https://www.openstreetmap.org/relation/${l.osm.slice(1)}`, target: '_blank', rel: 'noopener' }, 'OSM')] : null),
    l.stations.length ? el('details', { class: 'st-list' },
      el('summary', {}, `${t('stationList')} (${l.stations.length})`),
      el('ol', {}, l.stations.map((s) => el('li', {}, s.name || '—'))),
    ) : null,
    el('div', { class: 'actions' },
      l.kind === 'p' ? el('button', { class: 'primary', onclick: () => openEditor('alt', l) }, t('proposeAlt')) : null,
      el('button', { onclick: () => openEditor('based', l) }, t('basedOn')),
      mine ? el('button', { onclick: () => openEditor('edit', l) }, t('edit')) : null,
      mine ? el('button', { class: 'danger', onclick: () => removeLine(l) }, t('delete')) : null,
      el('button', { class: 'ghost', onclick: () => download(l) }, t('exportGeo')),
      el('button', { class: 'ghost', onclick: () => copyLink(l) }, t('copyLink')),
    ),
    l.kind === 'p' && costText(st.cost) ? el('small', { class: 'foot' }, `* ${t('costNote')}`) : null,
  );
}

function download(l) {
  const gj = { type: 'FeatureCollection', features: [lineToGeoJSON(l), ...stationsToGeoJSON(l)] };
  const a = el('a', { href: URL.createObjectURL(new Blob([JSON.stringify(gj)], { type: 'application/geo+json' })), download: `${l.name.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'hat'}.geojson` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function copyLink(l) {
  const url = `${location.origin}${location.pathname}${location.search}#l=${encodeURIComponent(l.id)}`;
  try { await navigator.clipboard.writeText(url); toast(t('linkCopied')); } catch { prompt(t('copyLink'), url); }
}

// ---- side panel ------------------------------------------------------------------

function matches(...texts) {
  const q = S.query.trim().toLocaleLowerCase(lang);
  return !q || texts.some((x) => (x || '').toLocaleLowerCase(lang).includes(q));
}

function renderList() {
  document.querySelectorAll('.tabs [data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === S.tab)));
  $('.view-opts').hidden = S.tab === 'feed';
  $('#search').hidden = S.tab === 'feed';
  const list = $('#list');
  const items = [];
  if (S.tab === 'props') {
    let rank = 0;
    for (const c of S.corridors) {
      rank++;
      if (!matches(c.title, ...c.lines.map((l) => l.name))) continue;
      items.push(el('div', { class: 'corr' },
        el('div', { class: 'corr-title' }, el('span', { class: 'rank' }, String(rank)), el('span', { class: 'grow' }, c.title),
          c.lines.length > 1 ? el('small', {}, t('alternatives', { n: c.lines.length })) : null),
        c.lines.map((l) => el('div', {
          class: `aln${l === c.winner ? ' win' : ''}${l.id === S.selected ? ' sel' : ''}`,
          tabindex: 0,
          onclick: () => select(l.id, true),
          onkeydown: (e) => { if (e.key === 'Enter') select(l.id, true); },
        },
          el('span', { class: 'sw', style: `background:${l.color}` }),
          el('span', { class: 'aln-name' }, l.name, el('small', {}, `${modeName(l.mode)} · ${fmt(l.length / 1000)} km`)),
          voteBox(l, true),
        )),
      ));
    }
    if (!S.corridors.length) items.push(el('p', { class: 'empty' }, t('noProposals')));
  } else if (S.tab === 'exist') {
    const ex = [...S.lines.values()].filter((l) => l.kind === 'e')
      .sort((a, b) => MODE_KEYS.indexOf(a.mode) - MODE_KEYS.indexOf(b.mode) || a.name.localeCompare(b.name, lang, { numeric: true }));
    let lastMode = null;
    for (const l of ex) {
      if (!matches(l.name, ...l.stations.map((s) => s.name))) continue;
      if (l.mode !== lastMode) { items.push(el('h3', {}, modeName(l.mode))); lastMode = l.mode; }
      items.push(el('div', { class: `aln${l.id === S.selected ? ' sel' : ''}`, tabindex: 0, onclick: () => select(l.id, true), onkeydown: (e) => { if (e.key === 'Enter') select(l.id, true); } },
        el('span', { class: 'sw', style: `background:${l.color}` }),
        el('span', { class: 'aln-name' }, l.name, el('small', {}, `${fmt(l.length / 1000)} km · ${l.stations.length} ${t('stations').toLocaleLowerCase(lang)}`)),
      ));
    }
    if (!ex.length) items.push(el('p', { class: 'empty' }, t('noExisting')));
  } else {
    for (const e of S.feed) {
      const exists = S.lines.has(e.i);
      items.push(el('div', { class: `feed${exists ? ' link' : ''}`, onclick: exists ? () => select(e.i, true) : null },
        el('span', {}, feedText(e)), el('time', {}, ago(e.t))));
    }
    if (!S.feed.length) items.push(el('p', { class: 'empty' }, t('noFeed')));
  }
  fill(list, ...items);
}

function feedText(e) {
  return t(`a_${e.a}`, { w: e.w || t('someone'), s: e.s || '', c: e.c || '' });
}

function renderStatus() {
  const s = $('#status');
  const key = { demo: 'stDemo', online: 'stOnline', offline: 'stOffline', connecting: 'stConnecting', error: 'stError' }[S.status] || 'stConnecting';
  s.textContent = t(key);
  s.className = `status ${S.status}`;
}

// ---- editor ----------------------------------------------------------------------

const editor = new Editor(map, {
  t,
  otherStations: () => [...S.lines.values()].filter((l) => l.id !== S.editing?.id).flatMap((l) => l.stations),
  onChange: () => renderEditorStats(),
});

function nextColour() {
  const used = new Map(PALETTE.map((c) => [c, 0]));
  for (const l of S.lines.values()) if (used.has(l.color)) used.set(l.color, used.get(l.color) + 1);
  return [...used.entries()].sort((a, b) => a[1] - b[1])[0][0];
}

function openEditor(mode, src) {
  if (S.importing) closeImporter();
  let draft;
  if (mode === 'new') {
    draft = { name: '', kind: 'p', mode: 'metro', color: nextColour(), segs: [[]], stations: [], desc: '', corridor: null };
  } else if (mode === 'alt') {
    const corr = S.corridors.find((c) => c.id === src.corridor);
    draft = toDraft(src);
    draft.name = `${corr?.title || src.name} · ${String.fromCharCode(65 + (corr?.lines.length || 1))}`.slice(0, LIMITS.name);
    draft.desc = '';
    draft.fork = src.id;
  } else if (mode === 'based') {
    draft = toDraft(src);
    Object.assign(draft, { kind: 'p', corridor: null, fork: src.id, osm: null, desc: '' });
  } else {
    draft = toDraft(src);
  }
  S.editing = { mode, id: mode === 'edit' ? src.id : null, draft, corrTitle: mode === 'alt' ? (S.corridors.find((c) => c.id === src.corridor)?.title || src.name) : null };
  renderEditor();
  editor.start(draft);
  drawLines();
  renderDetail();
  $('#panel').classList.remove('open');
}

function closeEditor() {
  editor.stop();
  S.editing = null;
  $('#editor').hidden = true;
  drawLines();
  renderDetail();
}

function renderEditor() {
  const ed = S.editing, d = ed.draft;
  const box = $('#editor');
  box.hidden = false;
  const title = ed.mode === 'edit' ? t('editorEdit') : ed.mode === 'alt' ? t('editorAlt', { name: ed.corrTitle }) : t('editorNew');
  const toolBtn = (tool, label, icon) => el('button', { class: `tool${editor.tool === tool ? ' on' : ''}`, 'data-tool': tool, onclick: () => { editor.setTool(tool); renderEditorTools(); } }, el('span', { 'aria-hidden': 'true' }, icon), label);
  fill(box,
    el('header', {}, el('h2', { class: 'grow' }, title), el('button', { class: 'icon close', 'aria-label': t('cancel'), onclick: closeEditor }, '×')),
    el('div', { class: 'tools' },
      toolBtn('draw', t('toolDraw'), '✎'),
      toolBtn('station', t('toolStation'), '◉'),
      toolBtn('move', t('toolMove'), '✥'),
    ),
    el('div', { class: 'tools small' },
      el('button', { onclick: () => editor.newBranch() }, '⑂ ', t('branch')),
      el('button', { onclick: () => editor.reverse() }, '⇄ ', t('reverse')),
      el('button', { onclick: () => editor.deleteBranch() }, '✕ ', t('deleteBranch')),
      el('button', { onclick: () => editor.undo() }, '↶ ', t('undo')),
    ),
    el('p', { class: 'hint', id: 'ed-hint' }),
    el('label', { class: 'field' }, el('span', {}, t('name')),
      el('input', { value: d.name, maxLength: LIMITS.name, placeholder: ed.mode === 'alt' ? t('altNamePh') : t('namePh'), oninput: (e) => { d.name = e.target.value; } })),
    el('div', { class: 'row' },
      el('label', { class: 'field grow' }, el('span', {}, t('mode')),
        el('select', { onchange: (e) => { d.mode = e.target.value; renderEditorStats(); editor.render(); } },
          MODE_KEYS.map((m) => el('option', { value: m, selected: m === d.mode }, modeName(m))))),
      el('label', { class: 'field' }, el('span', {}, t('color')),
        el('input', { type: 'color', value: d.color, oninput: (e) => { d.color = e.target.value; editor.render(); } })),
    ),
    el('div', { class: 'swatches' }, PALETTE.map((c) => el('button', { class: 'sw-btn', style: `background:${c}`, 'aria-label': c, onclick: () => { d.color = c; box.querySelector('input[type=color]').value = c; editor.render(); } }))),
    ed.mode === 'new' ? el('label', { class: 'check' }, el('input', { type: 'checkbox', checked: d.kind === 'e', onchange: (e) => { d.kind = e.target.checked ? 'e' : 'p'; renderEditorStats(); } }), el('span', {}, t('alreadyBuilt'))) : null,
    el('label', { class: 'field' }, el('span', {}, t('desc')),
      el('textarea', { rows: 2, maxLength: LIMITS.desc, placeholder: t('descPh'), value: d.desc || '', oninput: (e) => { d.desc = e.target.value; } })),
    el('dl', { class: 'stats', id: 'ed-stats' }),
    el('div', { class: 'actions end' },
      el('button', { onclick: closeEditor }, t('cancel')),
      el('button', { class: 'primary', id: 'ed-save', onclick: save }, t('save')),
    ),
  );
  renderEditorTools();
  renderEditorStats();
  tick();
}

function renderEditorTools() {
  const box = $('#editor');
  box.querySelectorAll('.tool').forEach((b) => b.classList.toggle('on', b.dataset.tool === editor.tool));
  const hint = $('#ed-hint');
  if (hint) hint.textContent = t({ draw: 'hintDraw', station: 'hintStation', move: 'hintMove' }[editor.tool]);
}

function renderEditorStats(_, info) {
  if (!S.editing) return;
  if (info?.tool) renderEditorTools();
  const d = S.editing.draft;
  const st = stats(d.segs.filter((s) => s.length >= 2), d.stations, d.mode);
  const statsBox = $('#ed-stats');
  if (statsBox) fill(statsBox,
    el('div', {}, el('dt', {}, t('length')), el('dd', {}, `${fmt(st.km)} km`)),
    el('div', {}, el('dt', {}, t('stations')), el('dd', {}, String(st.stations))),
    st.stations > 1 ? el('div', {}, el('dt', {}, t('spacing')), el('dd', {}, `${fmt(st.spacing, 2)} km`)) : null,
    d.kind === 'p' && costText(st.cost) ? el('div', { title: t('costNote') }, el('dt', {}, t('cost')), el('dd', {}, costText(st.cost))) : null,
  );
}

function errorText(e) {
  return t({ cooldown: 'errCooldown', denied: 'errDenied' }[e?.code] || 'errNetwork');
}

async function save() {
  const ed = S.editing;
  if (!ed || S.busy) return;
  const d = ed.draft;
  const segs = d.segs.filter((s) => s.length >= 2);
  if (!segs.length) return toast(t('errNoPath'));
  if (!d.name.trim()) return toast(t('errNoName'));
  const nick = await ensureNick();
  if (!nick) return;
  const isNew = !ed.id;
  const id = ed.id || backend.newId();
  const draft = { ...d, segs };
  if (draft.kind === 'p' && !draft.corridor) draft.corridor = id;
  if (draft.kind === 'e') draft.corridor = null;
  const node = serializeLine(draft, backend.uid, nick);
  if (node.p.length > LIMITS.geom || node.s.length > LIMITS.stations) return toast(t('errTooBig'));
  if (!isNew) node.t0 = S.lines.get(id)?.created || 0;
  const name = node.n;
  const change = {
    lines: { [id]: node },
    created: new Set(isNew ? [id] : []),
    log: { a: isNew ? (ed.mode === 'alt' ? 'alt' : draft.kind === 'e' ? 'newe' : 'new') : 'edit', i: id, s: name },
  };
  // The corridor is titled after its first alignment; its author can rename it.
  if (draft.kind === 'p' && draft.corridor === id && (!S.corr.has(id) || S.corr.get(id).a === backend.uid)) {
    change.corr = { [id]: { n: name.slice(0, LIMITS.corridor) } };
  }
  S.busy = true;
  tick();
  try {
    await backend.commit(change, nick);
    closeEditor();
    toast(t('saved'));
    select(id);
  } catch (e) {
    toast(errorText(e));
  } finally {
    S.busy = false;
    tick();
  }
}

async function removeLine(l) {
  if (!confirm(t('confirmDelete', { name: l.name }))) return;
  const nick = await ensureNick();
  if (!nick) return;
  try {
    await backend.commit({ lines: { [l.id]: null }, dropVotes: S.votes.has(l.id) ? [l.id] : [], log: { a: 'del', i: l.id, s: l.name } }, nick);
    select(null);
    toast(t('deleted'));
  } catch (e) {
    toast(errorText(e));
  }
}

// Save buttons show the remaining cooldown.
function tick() {
  const left = Math.ceil((S.cooldownUntil - (backend?.now() ?? Date.now())) / 1000);
  for (const b of [$('#ed-save'), $('#imp-go')]) {
    if (!b) continue;
    b.disabled = S.busy || left > 0 || b.dataset.empty === '1';
    b.textContent = S.busy ? t('saving') : left > 0 ? t('wait', { s: left }) : b.dataset.label || t('save');
  }
}
setInterval(tick, 500);

// ---- importer --------------------------------------------------------------------

function openImporter() {
  if (S.editing) closeEditor();
  S.importing = { tab: 'osm', cands: [], kind: 'e', state: 'idle', abort: null };
  select(null);
  renderImporter();
  $('#panel').classList.remove('open');
}

function closeImporter() {
  S.importing?.abort?.abort();
  S.importing = null;
  G.preview.clearLayers();
  $('#importer').hidden = true;
  renderDetail();
}

function alreadyThere(c) {
  return c.osm && (S.lines.has(`osm-${c.osm}`) || [...S.lines.values()].some((l) => l.osm === c.osm));
}

function renderImporter() {
  const imp = S.importing;
  if (!imp) return;
  const box = $('#importer');
  box.hidden = false;
  const tab = (key, label) => el('button', { role: 'tab', 'aria-selected': String(imp.tab === key), onclick: () => { imp.abort?.abort(); Object.assign(imp, { tab: key, cands: [], state: 'idle', kind: key === 'osm' ? 'e' : imp.kind }); renderImporter(); } }, label);
  const selectable = imp.cands.filter((c) => !c.done);
  const picked = selectable.filter((c) => c.checked);
  const body = [];
  if (imp.tab === 'osm') {
    body.push(el('p', { class: 'hint' }, t('osmHelp')),
      el('button', { class: 'primary', disabled: imp.state === 'loading', onclick: loadOSM }, imp.state === 'loading' ? t('fetching') : t('fetch')));
  } else {
    body.push(el('p', { class: 'hint' }, t('fileHelp')),
      el('input', { type: 'file', accept: '.geojson,.json,.kml,application/geo+json,application/vnd.google-earth.kml+xml', onchange: loadFile }),
      el('div', { class: 'seg' }, el('span', {}, t('importAs')),
        ['e', 'p'].map((k) => el('label', {}, el('input', { type: 'radio', name: 'imp-kind', value: k, checked: imp.kind === k, onchange: () => { imp.kind = k; } }), el('span', {}, k === 'e' ? t('asExisting') : t('asProposal'))))));
  }
  if (imp.state === 'error') body.push(el('p', { class: 'error' }, imp.error));
  if (imp.state === 'done') body.push(el('p', { class: 'hint' }, imp.cands.length ? t('found', { n: imp.cands.length }) : t('none')));
  if (imp.cands.length) {
    body.push(el('div', { class: 'row' },
      el('button', { class: 'ghost', onclick: () => { selectable.forEach((c) => { c.checked = true; }); renderImporter(); } }, t('selectAll')),
      el('button', { class: 'ghost', onclick: () => { selectable.forEach((c) => { c.checked = false; }); renderImporter(); } }, t('selectNone'))));
    body.push(el('div', { class: 'list cands' }, imp.cands.map((c) => el('label', { class: `aln cand${c.done ? ' done' : ''}`, onmouseenter: () => previewOne(c), onmouseleave: () => previewOne(null) },
      el('input', { type: 'checkbox', checked: !!c.checked && !c.done, disabled: !!c.done, onchange: (e) => { c.checked = e.target.checked; renderImporter(); } }),
      el('span', { class: 'sw', style: `background:${c.color}` }),
      el('span', { class: 'aln-name' }, c.name, el('small', {}, `${modeName(c.mode)} · ${fmt(c.km)} km · ${c.stations.length} ${t('stations').toLocaleLowerCase(lang)}${c.done ? ` · ${t('already')}` : ''}`)),
    ))));
  }
  const go = el('button', { class: 'primary', id: 'imp-go', onclick: runImport });
  go.dataset.label = t('importN', { n: Math.min(picked.length, MAX_BATCH) });
  go.dataset.empty = picked.length ? '0' : '1';
  fill(box,
    el('header', {}, el('h2', { class: 'grow' }, t('importTitle')), el('button', { class: 'icon close', 'aria-label': t('close'), onclick: closeImporter }, '×')),
    el('nav', { class: 'tabs', role: 'tablist' }, tab('osm', t('fromOSM')), tab('file', t('fromFile'))),
    ...body,
    picked.length > MAX_BATCH ? el('p', { class: 'hint' }, t('maxBatch', { n: MAX_BATCH })) : null,
    imp.cands.length ? el('div', { class: 'actions end' }, el('button', { onclick: closeImporter }, t('close')), go) : null,
  );
  previewAll();
  tick();
}

function previewAll() {
  G.preview.clearLayers();
  for (const c of S.importing?.cands || []) {
    if (c.done) continue;
    L.polyline(c.segs, { renderer: R.preview, color: c.color, weight: c.checked ? 4 : 2, opacity: c.checked ? 0.9 : 0.45, dashArray: c.checked ? null : '4 5', interactive: false }).addTo(G.preview);
  }
}

let previewHi = null;
function previewOne(c) {
  previewHi?.remove();
  previewHi = c ? L.polyline(c.segs, { renderer: R.preview, color: c.color, weight: 8, opacity: 1, interactive: false }).addTo(G.preview) : null;
}

async function loadOSM() {
  const imp = S.importing;
  if (map.getZoom() < 8) { imp.state = 'error'; imp.error = t('zoomIn'); return renderImporter(); }
  const b = map.getBounds();
  imp.state = 'loading';
  imp.abort = new AbortController();
  renderImporter();
  try {
    const cands = await fetchOSM([[b.getSouth(), b.getWest()], [b.getNorth(), b.getEast()]], imp.abort.signal);
    if (S.importing !== imp) return;
    for (const c of cands) { c.done = alreadyThere(c); c.checked = !c.done; }
    Object.assign(imp, { cands, state: 'done' });
  } catch (e) {
    if (S.importing !== imp || e.name === 'AbortError') return;
    Object.assign(imp, { state: 'error', error: t('osmError') });
  }
  renderImporter();
}

async function loadFile(e) {
  const imp = S.importing;
  const f = e.target.files?.[0];
  if (!f) return;
  try {
    const cands = parseFile(f.name, await f.text());
    cands.forEach((c) => { c.checked = true; });
    Object.assign(imp, { cands, state: 'done' });
    const b = boundsOf(cands.flatMap((c) => c.segs));
    if (b) map.fitBounds(b, { padding: [40, 40], maxZoom: 13 });
  } catch {
    Object.assign(imp, { cands: [], state: 'error', error: t('fileError') });
  }
  renderImporter();
}

// Lines too detailed for one database node are simplified harder before giving up.
function fitNode(draft, uid, nick) {
  for (const tol of [0, 25, 60, 150]) {
    const d = tol ? { ...draft, segs: draft.segs.map((s) => simplify(s, tol)) } : draft;
    const node = serializeLine(d, uid, nick);
    if (node.p.length <= LIMITS.geom && node.s.length <= LIMITS.stations) return node;
  }
  return null;
}

async function runImport() {
  const imp = S.importing;
  if (!imp || S.busy) return;
  const picked = imp.cands.filter((c) => c.checked && !c.done).slice(0, MAX_BATCH);
  if (!picked.length) return;
  const nick = await ensureNick();
  if (!nick) return;
  const change = { lines: {}, created: new Set(), corr: {}, log: { a: 'imp', i: '', s: picked[0].name, c: picked.length } };
  const used = [];
  for (const c of picked) {
    const kind = imp.tab === 'osm' ? 'e' : imp.kind;
    const id = c.osm ? `osm-${c.osm}` : backend.newId();
    const node = fitNode({ name: c.name, kind, mode: c.mode, color: c.color, segs: c.segs, stations: c.stations, desc: c.desc || '', corridor: kind === 'p' ? id : null, osm: c.osm || null }, backend.uid, nick);
    if (!node) continue;
    change.lines[id] = node;
    change.created.add(id);
    if (kind === 'p') change.corr[id] = { n: node.n.slice(0, LIMITS.corridor) };
    if (!change.log.i) change.log.i = id;
    used.push(c);
  }
  if (!used.length) return toast(t('errTooBig'));
  S.busy = true;
  tick();
  try {
    await backend.commit(change, nick);
    used.forEach((c) => { c.done = true; c.checked = false; });
    toast(t('imported', { n: used.length }));
    renderImporter();
  } catch (e) {
    toast(errorText(e));
  } finally {
    S.busy = false;
    tick();
  }
}

// ---- nickname, toast, chrome -----------------------------------------------------

function nick() { return storageGet('hm-nick') || ''; }

function ensureNick(force = false) {
  if (nick() && !force) return Promise.resolve(nick());
  const dlg = $('#dlg-nick');
  const input = $('#nick-input');
  input.value = nick() || `${lang === 'tr' ? 'Yolcu' : 'Rider'} ${Math.floor(100 + Math.random() * 900)}`;
  return new Promise((resolve) => {
    dlg.onclose = () => {
      const v = input.value.trim().slice(0, LIMITS.nick);
      if (dlg.returnValue === 'ok' && v) {
        storageSet('hm-nick', v);
        renderNick();
        resolve(v);
      } else resolve(force ? nick() : null);
    };
    dlg.returnValue = '';
    dlg.showModal();
    input.select();
  });
}

function renderNick() {
  $('#btn-nick').replaceChildren('👤', el('span', { class: 'nick-name' }, ` ${nick() || t('nickname')}`));
}

let toastTimer = 0;
function toast(msg, ms = 2600) {
  const box = $('#toast');
  box.textContent = msg;
  box.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => box.classList.remove('show'), ms);
}

function applyI18n() {
  document.title = t('title');
  document.querySelectorAll('[data-i18n]').forEach((e) => { e.textContent = t(e.dataset.i18n); });
  document.querySelectorAll('[data-i18n-title]').forEach((e) => { e.title = t(e.dataset.i18nTitle); });
  document.querySelectorAll('[data-i18n-ph]').forEach((e) => { e.placeholder = t(e.dataset.i18nPh); });
  renderNick();
  renderStatus();
  renderList();
  renderDetail();
  if (S.editing) renderEditor();
  if (S.importing) renderImporter();
}

$('#btn-lang').addEventListener('click', () => { setLang(lang === 'tr' ? 'en' : 'tr'); applyI18n(); });
$('#btn-nick').addEventListener('click', () => ensureNick(true));
$('#btn-new').addEventListener('click', () => { select(null); openEditor('new'); });
$('#btn-import').addEventListener('click', openImporter);
$('#btn-panel').addEventListener('click', () => {
  const open = $('#panel').classList.toggle('open');
  $('#btn-panel').setAttribute('aria-expanded', String(open));
});
document.querySelectorAll('.tabs [data-tab]').forEach((b) => b.addEventListener('click', () => {
  S.tab = b.dataset.tab;
  storageSet('hm-tab', S.tab);
  renderList();
}));
document.querySelectorAll('input[name=view]').forEach((r) => r.addEventListener('change', () => { S.view = r.value; drawLines(); }));
$('#opt-existing').addEventListener('change', (e) => { S.showExisting = e.target.checked; drawLines(); });
$('#opt-negative').addEventListener('change', (e) => { S.hideNegative = e.target.checked; drawLines(); });
$('#opt-orm').addEventListener('change', (e) => { if (e.target.checked) ormLayer.addTo(map); else ormLayer.remove(); });
$('#search').addEventListener('input', (e) => { S.query = e.target.value; renderList(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !S.editing && !S.importing && S.selected && !e.target.closest('input, textarea')) select(null);
});
setInterval(() => { if (S.tab === 'feed') renderList(); }, 30000);

applyI18n();

// ?debug exposes the map and state in the console.
if (new URLSearchParams(location.search).has('debug')) window.hm = { map, S, select };

createBackend(handlers).then((b) => {
  backend = b;
  rebuild();
  if (pendingHash && S.lines.has(pendingHash)) { select(pendingHash, true); pendingHash = null; }
}).catch((e) => {
  console.error(e);
  handlers.status('error');
});
