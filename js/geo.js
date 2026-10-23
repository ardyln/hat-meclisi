// Geometry helpers. Coordinates are [lat, lng] pairs throughout.
//
// Lines are stored as Google encoded polylines (precision 5, ~1 m), one string per
// branch, joined by spaces. Encoded polylines only use the characters '?'..'~', so a
// space can never appear inside one.

export const TURKEY = { south: 34.5, west: 24.5, north: 43, east: 46 };
export const EMPTY_CENTER = [39.0, 35.2];

export function inTurkey([lat, lng]) {
  return lat >= TURKEY.south && lat <= TURKEY.north && lng >= TURKEY.west && lng <= TURKEY.east;
}

function encodeValue(v, out) {
  v = v < 0 ? ~(v << 1) : v << 1;
  while (v >= 0x20) {
    out.push(String.fromCharCode((0x20 | (v & 0x1f)) + 63));
    v >>= 5;
  }
  out.push(String.fromCharCode(v + 63));
}

export function encodePath(pts) {
  const out = [];
  let plat = 0, plng = 0;
  for (const [lat, lng] of pts) {
    const a = Math.round(lat * 1e5), o = Math.round(lng * 1e5);
    encodeValue(a - plat, out);
    encodeValue(o - plng, out);
    plat = a;
    plng = o;
  }
  return out.join('');
}

export function decodePath(str) {
  const pts = [];
  let i = 0, lat = 0, lng = 0;
  const next = () => {
    let shift = 0, result = 0, b;
    do {
      if (i >= str.length) throw new Error('truncated polyline');
      b = str.charCodeAt(i++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (i < str.length) {
    lat += next();
    lng += next();
    pts.push([lat / 1e5, lng / 1e5]);
  }
  return pts;
}

export const encodeSegs = (segs) => segs.filter((s) => s.length >= 2).map(encodePath).join(' ');
export const decodeSegs = (str) => (str ? str.split(' ').filter(Boolean).map(decodePath).filter((s) => s.length >= 2) : []);

const R = 6371008.8;
const rad = (d) => (d * Math.PI) / 180;

export function distance([a1, o1], [a2, o2]) {
  const dA = rad(a2 - a1), dO = rad(o2 - o1);
  const h = Math.sin(dA / 2) ** 2 + Math.cos(rad(a1)) * Math.cos(rad(a2)) * Math.sin(dO / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function pathLength(pts) {
  let d = 0;
  for (let i = 1; i < pts.length; i++) d += distance(pts[i - 1], pts[i]);
  return d;
}

export const segsLength = (segs) => segs.reduce((s, p) => s + pathLength(p), 0);

// Local equirectangular projection in metres around a reference latitude: accurate
// enough for snapping and simplifying anything up to a few hundred kilometres long.
function projector(lat0) {
  const k = Math.cos(rad(lat0));
  return ([lat, lng]) => [rad(lng) * R * k, rad(lat) * R];
}

// Douglas–Peucker, tolerance in metres. Keeps both endpoints.
export function simplify(pts, tol) {
  if (pts.length < 3) return pts.slice();
  const P = projector(pts[0][0]);
  const xy = pts.map(P);
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    let best = -1, bestD = tol;
    for (let i = s + 1; i < e; i++) {
      const d = segDist(xy[i], xy[s], xy[e]).d;
      if (d > bestD) { bestD = d; best = i; }
    }
    if (best > 0) {
      keep[best] = 1;
      stack.push([s, best], [best, e]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

function segDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const x = a[0] + t * dx, y = a[1] + t * dy;
  return { d: Math.hypot(p[0] - x, p[1] - y), t };
}

// Nearest point on any branch: { seg, i (segment start index), t, point, d (metres) }.
export function nearestOnSegs(segs, q) {
  const P = projector(q[0]);
  const qx = P(q);
  let best = null;
  segs.forEach((pts, si) => {
    for (let i = 1; i < pts.length; i++) {
      const r = segDist(qx, P(pts[i - 1]), P(pts[i]));
      if (!best || r.d < best.d) {
        const a = pts[i - 1], b = pts[i];
        best = { seg: si, i: i - 1, t: r.t, d: r.d, point: [a[0] + (b[0] - a[0]) * r.t, a[1] + (b[1] - a[1]) * r.t] };
      }
    }
  });
  return best;
}

export function boundsOf(segs, stations = []) {
  let s = 90, w = 180, n = -90, e = -180;
  const add = ([lat, lng]) => {
    if (lat < s) s = lat;
    if (lat > n) n = lat;
    if (lng < w) w = lng;
    if (lng > e) e = lng;
  };
  segs.forEach((p) => p.forEach(add));
  stations.forEach((st) => add([st.lat, st.lng]));
  return n < s ? null : [[s, w], [n, e]];
}

export const round5 = (v) => Math.round(v * 1e5) / 1e5;
