// Importing existing lines: from OpenStreetMap (Overpass API, the area in view) or from
// GeoJSON / KML files. Both return candidates:
//   { key, osm?, name, mode, color, segs, stations: [{lat, lng, name}], km }

import { distance, nearestOnSegs, segsLength, simplify, round5 } from './geo.js';
import { MODE_KEYS, PALETTE, LIMITS } from './model.js';

const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const SIMPLIFY_M = 12;

const NAMED_COLOURS = {
  red: '#e3051b', blue: '#0072bc', green: '#00a651', yellow: '#ffd500', orange: '#f39200', purple: '#8e44ad',
  pink: '#e5007e', brown: '#8b5a2b', grey: '#7f7f7f', gray: '#7f7f7f', black: '#222222', white: '#bbbbbb',
  cyan: '#00a0e3', magenta: '#e5007e', navy: '#1d3c8f', teal: '#009fa8', lime: '#9ab517', maroon: '#8b1a1a',
  darkgreen: '#006b3f', lightblue: '#5bc2e7', darkblue: '#1d3c8f', violet: '#8e44ad', gold: '#d4a017', olive: '#808000',
};

export function normColour(c, fallbackKey = '') {
  if (typeof c === 'string') {
    const s = c.trim().toLowerCase();
    if (/^#[0-9a-f]{6}$/.test(s)) return s;
    if (/^#[0-9a-f]{3}$/.test(s)) return '#' + [...s.slice(1)].map((x) => x + x).join('');
    if (/^[0-9a-f]{6}$/.test(s)) return '#' + s;
    if (NAMED_COLOURS[s.replace(/[\s_-]/g, '')]) return NAMED_COLOURS[s.replace(/[\s_-]/g, '')];
  }
  let h = 0;
  for (const ch of String(fallbackKey)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

function guessMode(route, tags) {
  const name = `${tags.name || ''} ${tags.network || ''} ${tags.ref || ''}`;
  switch (route) {
    case 'subway': return 'metro';
    case 'light_rail': case 'monorail': return 'lrt';
    case 'tram': return 'tram';
    case 'funicular': return 'fun';
    case 'aerialway': return 'cable';
    case 'ferry': return 'ferry';
    case 'bus': case 'trolleybus': return 'brt';
    case 'train': {
      // Some city lines are tagged as trains; their names give them away.
      if (/Metrobüs|Metrobus/i.test(name)) return 'brt';
      if (/Tramvay|\bTram\b/i.test(name)) return 'tram';
      if (/\bMetro\b/i.test(name)) return 'metro';
      const svc = tags.service || '';
      if (svc === 'high_speed' || /\bYHT\b|Yüksek Hızlı|High.?Speed/i.test(name)) return 'hsr';
      if (/commuter|suburban/.test(svc) || /Banliyö|Marmaray|İZBAN|IZBAN|Başkentray|Baskentray|Gaziray|commuter/i.test(name)) return 'sub';
      return 'reg';
    }
    default: return 'metro';
  }
}

const ARROWS = /\s*(?:=>|->|→|⇒|—>|–>|<=>|↔)\s*/g;
const ARROW_SPLIT = /\s*(?:=>|->|→|⇒|—>|–>|<=>|↔)\s*/;

function cleanName(tags) {
  const ref = (tags.ref || '').trim();
  let name = (tags['name'] || tags['name:tr'] || tags['name:en'] || '').trim().replace(ARROWS, ' – ');
  if (ref && name && !name.toLowerCase().startsWith(ref.toLowerCase())) name = `${ref} ${name}`;
  name = name.replace(/^([^:]{1,12}):\s*/, '$1 ');
  return (name || ref || 'OSM').slice(0, LIMITS.name);
}

// One line per service: the two directions of a route (and its variants) share a ref,
// or have the same words in their name ("Ankara – İstanbul" / "İstanbul – Ankara").
// Lines with the same key only merge when they are also in the same place, so two
// cities' "T1" stay apart.
function dedupeKey(route, tags) {
  const ref = (tags.ref || '').trim().toLocaleLowerCase('tr');
  if (ref) return `${route}|ref:${ref}`;
  const words = (tags.name || '').toLocaleLowerCase('tr').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean);
  return `${route}|${words.sort().join(' ')}`;
}

function extent(segs) {
  let s = 90, w = 180, n = -90, e = -180;
  for (const seg of segs) for (const [a, o] of seg) { s = Math.min(s, a); n = Math.max(n, a); w = Math.min(w, o); e = Math.max(e, o); }
  return [s, w, n, e];
}

const overlaps = (a, b) => a[0] <= b[2] + 0.02 && b[0] <= a[2] + 0.02 && a[1] <= b[3] + 0.02 && b[1] <= a[3] + 0.02;

const same = (a, b) => Math.abs(a[0] - b[0]) < 1e-7 && Math.abs(a[1] - b[1]) < 1e-7;

// Chains a relation's ways into as few continuous branches as their endpoints allow.
export function stitch(ways) {
  const segs = [];
  let cur = null, single = false;
  for (const w of ways) {
    if (w.length < 2) continue;
    if (!cur) { cur = w.slice(); single = true; continue; }
    const end = cur[cur.length - 1];
    if (same(w[0], end)) cur.push(...w.slice(1));
    else if (same(w[w.length - 1], end)) cur.push(...w.slice().reverse().slice(1));
    else if (single && same(w[0], cur[0])) { cur.reverse(); cur.push(...w.slice(1)); }
    else if (single && same(w[w.length - 1], cur[0])) { cur.reverse(); cur.push(...w.slice().reverse().slice(1)); }
    else { segs.push(cur); cur = w.slice(); single = true; continue; }
    single = false;
  }
  if (cur) segs.push(cur);
  return segs;
}

function dedupeStations(list) {
  const out = [];
  for (const s of list) {
    if (out.some((o) => (o.name && o.name === s.name && distance([o.lat, o.lng], [s.lat, s.lng]) < 400) || distance([o.lat, o.lng], [s.lat, s.lng]) < 30)) continue;
    out.push(s);
  }
  return out;
}

// Tries each server in turn; one that hangs is given up on after 100 s.
async function overpass(query, signal) {
  let last;
  for (const url of OVERPASS) {
    const timeout = AbortSignal.timeout?.(100000);
    const both = timeout && AbortSignal.any ? AbortSignal.any([signal, timeout].filter(Boolean)) : signal;
    try {
      const r = await fetch(url, { method: 'POST', body: new URLSearchParams({ data: query }), signal: both });
      if (r.ok) return await r.json();
      last = new Error(`Overpass HTTP ${r.status}`);
    } catch (e) {
      if (signal?.aborted) throw e;
      last = e;
    }
  }
  throw last;
}

// Existing routes inside [[south, west], [north, east]].
export async function fetchOSM([[s, w], [n, e]], signal) {
  const bbox = `${s.toFixed(4)},${w.toFixed(4)},${n.toFixed(4)},${e.toFixed(4)}`;
  const q = `[out:json][timeout:90];
(
  relation["type"="route"]["route"~"^(subway|light_rail|tram|train|monorail|funicular|ferry|aerialway)$"](${bbox});
  relation["type"="route"]["route"="bus"]["network"~"Metrob|BRT",i](${bbox});
  relation["type"="route"]["route"="bus"]["name"~"^(Metrob|BRT)",i](${bbox});
  relation["type"="route"]["route"="bus"]["bus"~"rapid",i](${bbox});
)->.r;
.r out geom;
node(r.r)["name"];
out tags;`;
  const data = await overpass(q, signal);
  const names = new Map();
  for (const el of data.elements) if (el.type === 'node') names.set(el.id, el.tags?.name || el.tags?.['name:tr'] || '');

  const best = new Map();
  for (const rel of data.elements) {
    if (rel.type !== 'relation') continue;
    const tags = rel.tags || {};
    const ways = [], stops = [], platforms = [];
    for (const m of rel.members || []) {
      if (m.type === 'way' && m.geometry && !/platform/.test(m.role)) ways.push(m.geometry.map((p) => [p.lat, p.lon]));
      else if (m.type === 'node' && m.lat != null) {
        const st = { lat: round5(m.lat), lng: round5(m.lon), name: (names.get(m.ref) || '').slice(0, 60) };
        if (/^stop/.test(m.role)) stops.push(st);
        else if (/platform/.test(m.role)) platforms.push(st);
      } else if (m.type === 'way' && m.geometry && /platform/.test(m.role)) {
        const g = m.geometry;
        platforms.push({ lat: round5(g.reduce((a, p) => a + p.lat, 0) / g.length), lng: round5(g.reduce((a, p) => a + p.lon, 0) / g.length), name: '' });
      }
    }
    const segs = stitch(ways).map((sg) => simplify(sg, SIMPLIFY_M)).filter((sg) => sg.length >= 2);
    if (!segs.length) continue;
    const stations = dedupeStations(stops.length ? stops : platforms);
    const cand = {
      key: `osm-r${rel.id}`,
      osm: `r${rel.id}`,
      name: cleanName(tags),
      mode: guessMode(tags.route, tags),
      color: normColour(tags.colour || tags.color, dedupeKey(tags.route, tags)),
      segs,
      stations,
      km: segsLength(segs) / 1000,
    };
    cand.box = extent(segs);
    const k = dedupeKey(tags.route, tags);
    const group = best.get(k) || [];
    const i = group.findIndex((o) => overlaps(o.box, cand.box));
    if (i < 0) group.push(cand);
    else if (cand.stations.length > group[i].stations.length || (cand.stations.length === group[i].stations.length && cand.km > group[i].km)) group[i] = cand;
    best.set(k, group);
  }
  return [...best.values()].flat()
    .sort((a, b) => MODE_KEYS.indexOf(a.mode) - MODE_KEYS.indexOf(b.mode) || a.name.localeCompare(b.name, 'tr', { numeric: true }));
}

// ---- files ---------------------------------------------------------------------

function propMode(p) {
  const v = String(p.mode || p.route || p.railway || p.type || '').toLowerCase();
  if (MODE_KEYS.includes(v)) return v;
  return guessMode(v, { name: p.name || '', service: p.service || '' });
}

// Named points become stations of the nearest imported line within 500 m.
function attachStations(cands, points) {
  for (const pt of points) {
    let best = null, bestD = 500;
    for (const c of cands) {
      const n = nearestOnSegs(c.segs, [pt.lat, pt.lng]);
      if (n && n.d < bestD) { best = c; bestD = n.d; }
    }
    if (best) best.stations.push(pt);
  }
}

function finish(cands, points, prefix) {
  attachStations(cands, points);
  return cands
    .map((c, i) => {
      const segs = c.segs.map((sg) => simplify(sg, 3)).filter((sg) => sg.length >= 2);
      return { ...c, key: `${prefix}${i}`, segs, stations: dedupeStations(c.stations), km: segsLength(segs) / 1000 };
    })
    .filter((c) => c.segs.length);
}

export function parseGeoJSON(text) {
  const gj = JSON.parse(text);
  const feats = gj.type === 'FeatureCollection' ? gj.features : gj.type === 'Feature' ? [gj] : [{ type: 'Feature', properties: {}, geometry: gj }];
  const cands = [], points = [];
  const toLL = (c) => [round5(+c[1]), round5(+c[0])];
  for (const f of feats || []) {
    const g = f?.geometry, p = f?.properties || {};
    if (!g) continue;
    const name = String(p.name || p.ref || p.title || `#${cands.length + 1}`).slice(0, LIMITS.name);
    if (g.type === 'LineString' || g.type === 'MultiLineString') {
      const segs = (g.type === 'LineString' ? [g.coordinates] : g.coordinates).map((s) => s.map(toLL));
      cands.push({ name, mode: propMode(p), color: normColour(p.colour || p.color || p.stroke, name), segs, stations: [], desc: String(p.description || '').slice(0, LIMITS.desc) });
    } else if (g.type === 'Point' && p.name) {
      const [lat, lng] = toLL(g.coordinates);
      points.push({ lat, lng, name: String(p.name).slice(0, 60) });
    } else if (g.type === 'GeometryCollection') {
      const segs = g.geometries.filter((x) => x.type === 'LineString').map((x) => x.coordinates.map(toLL));
      if (segs.length) cands.push({ name, mode: propMode(p), color: normColour(p.colour || p.color, name), segs, stations: [] });
    }
  }
  return finish(cands, points, 'gj');
}

export function parseKML(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('KML parse error');
  const cands = [], points = [];
  const coords = (el) => el.textContent.trim().split(/\s+/).map((t) => t.split(',')).filter((c) => c.length >= 2).map((c) => [round5(+c[1]), round5(+c[0])]);
  for (const pm of doc.getElementsByTagName('Placemark')) {
    const name = (pm.getElementsByTagName('name')[0]?.textContent || '').trim();
    const lines = [...pm.getElementsByTagName('LineString')];
    if (lines.length) {
      const segs = lines.map((ls) => coords(ls.getElementsByTagName('coordinates')[0] || ls));
      const nm = (name || `#${cands.length + 1}`).slice(0, LIMITS.name);
      cands.push({ name: nm, mode: propMode({ name: nm }), color: normColour(null, nm), segs, stations: [] });
      continue;
    }
    const pt = pm.getElementsByTagName('Point')[0];
    if (pt && name) {
      const c = coords(pt.getElementsByTagName('coordinates')[0] || pt)[0];
      if (c) points.push({ lat: c[0], lng: c[1], name: name.slice(0, 60) });
    }
  }
  return finish(cands, points, 'kml');
}

export function parseFile(name, text) {
  if (/\.kml$/i.test(name) || /^\s*<\?xml|<kml/i.test(text.slice(0, 200))) return parseKML(text);
  return parseGeoJSON(text);
}
