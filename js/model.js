// Lines, corridors and votes: parsing the stored nodes, serialising drafts, and
// working out which alignment of each corridor is currently winning.
//
// Stored line node (database.rules.json validates every field):
//   n  name               k  'p' proposal | 'e' existing (built) line
//   m  mode (MODES key)   c  colour '#rrggbb'
//   p  branches, encoded polylines joined by ' '
//   s  stations, JSON [[lat·1e5, lng·1e5, name], …]
//   d  description        g  corridor id (proposals only)
//   f  forked from (line id, optional)   o  OpenStreetMap source, e.g. 'r1234'
//   a  author uid         w  author nickname
//   t0 created            t  last change (server timestamps)

import { decodeSegs, encodeSegs, segsLength, round5 } from './geo.js';

// Rough construction cost in million € per km, only for the "estimated cost" figure.
export const MODES = {
  metro: { weight: 5, cost: 150 },
  lrt: { weight: 4.5, cost: 70 },
  tram: { weight: 4, cost: 25 },
  sub: { weight: 4.5, cost: 30 },
  reg: { weight: 3.5, cost: 8 },
  hsr: { weight: 4.5, cost: 25 },
  brt: { weight: 4, cost: 6 },
  cable: { weight: 3, cost: 20 },
  fun: { weight: 3.5, cost: 40 },
  ferry: { weight: 3, cost: 0 },
};
export const MODE_KEYS = Object.keys(MODES);

export const PALETTE = ['#e3051b', '#0072bc', '#00a651', '#f39200', '#8e44ad', '#e5007e', '#009fa8', '#8b5a2b', '#5c6670', '#9ab517', '#1d3c8f', '#c8102e'];

export const LIMITS = { name: 60, desc: 600, nick: 24, geom: 60000, stations: 16000, corridor: 60 };

export const ID_RE = /^(-[-0-9A-Za-z_]{10,30}|osm-[rw][0-9]{1,12})$/;

export function parseLine(id, node) {
  if (!node || typeof node !== 'object') return null;
  let segs = [];
  try { segs = decodeSegs(String(node.p || '')); } catch { return null; }
  if (!segs.length) return null;
  let stations = [];
  try {
    const raw = JSON.parse(node.s || '[]');
    if (Array.isArray(raw)) {
      stations = raw
        .filter((s) => Array.isArray(s) && Number.isFinite(s[0]) && Number.isFinite(s[1]))
        .map((s) => ({ lat: s[0] / 1e5, lng: s[1] / 1e5, name: String(s[2] ?? '').slice(0, 60) }));
    }
  } catch { /* a broken station list just shows no stations */ }
  return {
    id,
    name: String(node.n || '?'),
    kind: node.k === 'e' ? 'e' : 'p',
    mode: MODES[node.m] ? node.m : 'metro',
    color: /^#[0-9a-f]{6}$/.test(node.c) ? node.c : PALETTE[0],
    segs,
    stations,
    desc: String(node.d || ''),
    corridor: node.k === 'p' ? String(node.g || id) : null,
    fork: node.f || null,
    osm: node.o || null,
    author: node.a || null,
    nick: String(node.w || ''),
    created: Number(node.t0) || Number(node.t) || 0,
    updated: Number(node.t) || 0,
    length: segsLength(segs),
    tally: { up: 0, down: 0, score: 0, mine: 0 },
  };
}

export function serializeLine(draft, uid, nick) {
  const node = {
    n: draft.name.trim().slice(0, LIMITS.name) || '?',
    k: draft.kind,
    m: draft.mode,
    c: draft.color,
    p: encodeSegs(draft.segs),
    s: JSON.stringify(draft.stations.map((s) => [Math.round(s.lat * 1e5), Math.round(s.lng * 1e5), s.name.trim().slice(0, 60)])),
    a: uid,
  };
  if (draft.desc && draft.desc.trim()) node.d = draft.desc.trim().slice(0, LIMITS.desc);
  if (draft.kind === 'p') node.g = draft.corridor;
  if (draft.fork) node.f = draft.fork;
  if (draft.osm) node.o = draft.osm;
  if (nick) node.w = String(nick).slice(0, LIMITS.nick);
  return node;
}

// A fresh editable copy (deep enough that edits never touch the shown line).
export function toDraft(line) {
  return {
    name: line.name,
    kind: line.kind,
    mode: line.mode,
    color: line.color,
    segs: line.segs.map((s) => s.map(([a, o]) => [a, o])),
    stations: line.stations.map((s) => ({ ...s })),
    desc: line.desc,
    corridor: line.corridor,
    fork: line.fork,
    osm: line.osm,
  };
}

export function tally(votes, uid) {
  let up = 0, down = 0, mine = 0;
  for (const [u, v] of Object.entries(votes || {})) {
    if (v === 1) up++;
    else if (v === -1) down++;
    if (u === uid) mine = v;
  }
  return { up, down, score: up - down, mine };
}

// Groups proposals into corridors, ranks alignments inside each (score, then age) and
// ranks corridors by their winner. Returns [{ id, title, lines: [line…], winner }].
export function corridors(lines, corrNodes, votes, uid) {
  const groups = new Map();
  for (const l of lines.values()) {
    if (l.kind !== 'p') continue;
    l.tally = tally(votes.get(l.id), uid);
    if (!groups.has(l.corridor)) groups.set(l.corridor, []);
    groups.get(l.corridor).push(l);
  }
  const out = [];
  for (const [id, ls] of groups) {
    ls.sort((a, b) => b.tally.score - a.tally.score || a.created - b.created);
    const oldest = ls.reduce((a, b) => (a.created <= b.created ? a : b));
    out.push({ id, title: corrNodes.get(id)?.n || oldest.name, lines: ls, winner: ls[0] });
  }
  out.sort((a, b) => b.winner.tally.score - a.winner.tally.score || b.lines.length - a.lines.length || a.winner.created - b.winner.created);
  return out;
}

export function stats(segs, stations, mode) {
  const len = segsLength(segs);
  const km = len / 1000;
  return {
    km,
    stations: stations.length,
    spacing: stations.length > 1 ? km / (stations.length - 1) : 0,
    cost: km * (MODES[mode]?.cost || 0),
  };
}

export function snapStation(lat, lng, name) {
  return { lat: round5(lat), lng: round5(lng), name };
}

export function lineToGeoJSON(l) {
  return {
    type: 'Feature',
    properties: { name: l.name, mode: l.mode, colour: l.color, kind: l.kind === 'e' ? 'existing' : 'proposal', description: l.desc || undefined },
    geometry: l.segs.length === 1
      ? { type: 'LineString', coordinates: l.segs[0].map(([a, o]) => [o, a]) }
      : { type: 'MultiLineString', coordinates: l.segs.map((s) => s.map(([a, o]) => [o, a])) },
  };
}

export function stationsToGeoJSON(l) {
  return l.stations.map((s) => ({
    type: 'Feature',
    properties: { name: s.name, line: l.name },
    geometry: { type: 'Point', coordinates: [s.lng, s.lat] },
  }));
}
