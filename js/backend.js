// Live sync. FirebaseBackend talks to the Realtime Database (database.rules.json checks
// every write and enforces the cooldown); LocalBackend is a same-interface demo that
// keeps everything in this browser and syncs its tabs.
//
// Handlers: line(id, node|null)  corr(id, node|null)  votes(lineId, {uid: ±1}|null)
//           log(id, entry, isLive)  status(kind, detail)  cooldown(untilMs)
//
// Every change is one atomic multi-path write carrying the user's cooldown stamp and a
// feed entry, so the rules can tie the three together.

import { FIREBASE_CONFIG } from './config.js';

export const COOLDOWN_MS = 10000;
const LOG_LIMIT = 80;
const SDK = 'https://www.gstatic.com/firebasejs/10.12.2/';
const TS = { '.sv': 'timestamp' };

const params = new URLSearchParams(location.search);
const useFirebase = () => !params.has('demo') && !!(params.get('emulator') || FIREBASE_CONFIG.apiKey);

export function fail(code, message = code) {
  return Object.assign(new Error(message), { code });
}

function randomId() {
  const abc = '-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz';
  const a = crypto.getRandomValues(new Uint8Array(19));
  return '-' + Date.now().toString(36) + Array.from(a, (v) => abc[v % abc.length]).join('');
}

export function storageGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
export function storageSet(key, value) {
  try { localStorage.setItem(key, value); } catch { /* private mode etc. */ }
}

export async function createBackend(handlers) {
  const b = useFirebase() ? new FirebaseBackend(handlers, params.get('emulator')) : new LocalBackend(handlers);
  await b.start();
  return b;
}

// Turns a change description into the multi-path update both backends apply.
//   change = { lines: { id: node | null }, created: Set(ids), corr: { id: node },
//              dropVotes: [ids], log: { a, i, s?, c? } }
function buildUpdate(change, uid, nick, logId) {
  const u = {};
  for (const [id, node] of Object.entries(change.lines || {})) {
    if (node === null) { u[`lines/${id}`] = null; continue; }
    u[`lines/${id}`] = { ...node, t: TS, t0: change.created?.has(id) ? TS : node.t0 };
  }
  for (const [id, node] of Object.entries(change.corr || {})) u[`corr/${id}`] = { ...node, a: uid, t: TS };
  for (const id of change.dropVotes || []) u[`votes/${id}`] = null;
  u[`cool/${uid}`] = { t: TS };
  const e = { u: uid, t: TS, a: change.log.a, i: change.log.i };
  if (change.log.s) e.s = String(change.log.s).slice(0, 64);
  if (change.log.c) e.c = change.log.c;
  if (nick) e.w = String(nick).slice(0, 24);
  u[`log/${logId}`] = e;
  return u;
}

class FirebaseBackend {
  constructor(h, emu) {
    this.h = h;
    this.emu = emu;
    this.mode = emu ? 'emulator' : 'firebase';
    this.offset = 0;
    this.uid = null;
    this.cooldownUntil = 0;
  }

  now() { return Date.now() + this.offset; }

  async start() {
    this.h.status('connecting');
    const [app, auth, db] = await Promise.all([
      import(SDK + 'firebase-app.js'),
      import(SDK + 'firebase-auth.js'),
      import(SDK + 'firebase-database.js'),
    ]);
    this.fb = db;
    const config = this.emu
      ? { apiKey: 'demo-key', projectId: 'demo-hat-meclisi', databaseURL: `http://${this.emu.split(':')[0]}:9000?ns=demo-hat-meclisi` }
      : FIREBASE_CONFIG;
    const fbApp = app.initializeApp(config);
    const a = auth.getAuth(fbApp);
    this.db = db.getDatabase(fbApp);
    if (this.emu) {
      const host = this.emu.split(':')[0];
      auth.connectAuthEmulator(a, `http://${host}:9099`, { disableWarnings: true });
      db.connectDatabaseEmulator(this.db, host, Number(this.emu.split(':')[1]) || 9000);
    }
    const signedIn = new Promise((resolve) => auth.onAuthStateChanged(a, (user) => user && resolve(user)));
    auth.signInAnonymously(a).catch((e) => this.h.status('error', e.code || e.message));
    this.uid = (await signedIn).uid;

    const r = (p) => db.ref(this.db, p);
    db.onValue(r('.info/serverTimeOffset'), (s) => { this.offset = s.val() || 0; });
    db.onValue(r('.info/connected'), (s) => this.h.status(s.val() ? 'online' : 'offline'));
    db.onValue(r(`cool/${this.uid}/t`), (s) => {
      this.cooldownUntil = (s.val() || 0) + COOLDOWN_MS;
      this.h.cooldown(this.cooldownUntil);
    }, () => {});

    for (const [path, fn] of [['lines', 'line'], ['corr', 'corr'], ['votes', 'votes']]) {
      const q = r(path);
      db.onChildAdded(q, (s) => this.h[fn](s.key, s.val()));
      db.onChildChanged(q, (s) => this.h[fn](s.key, s.val()));
      db.onChildRemoved(q, (s) => this.h[fn](s.key, null));
    }
    // Entries already there when the page opens are history, later ones are live.
    let live = false;
    db.onChildAdded(db.query(r('log'), db.orderByKey(), db.limitToLast(LOG_LIMIT)), (s) => this.h.log(s.key, s.val(), live));
    await db.get(r('lines')).catch(() => {});
    live = true;
  }

  newId() { return this.fb.push(this.fb.ref(this.db, 'lines')).key; }

  async commit(change, nick) {
    if (this.now() < this.cooldownUntil) throw fail('cooldown');
    const logId = this.fb.push(this.fb.ref(this.db, 'log')).key;
    try {
      await this.fb.update(this.fb.ref(this.db), buildUpdate(change, this.uid, nick, logId));
    } catch (e) {
      throw fail(/permission/i.test(e.code || e.message) ? 'denied' : 'network', e.message);
    }
  }

  async vote(lineId, v) {
    const r = this.fb.ref(this.db, `votes/${lineId}/${this.uid}`);
    try {
      await (v ? this.fb.set(r, v) : this.fb.remove(r));
    } catch (e) {
      throw fail('denied', e.message);
    }
  }
}

// Demo mode: the same data model in localStorage, synced between this browser's tabs.
// ?cool=0 shortens the cooldown for testing.
class LocalBackend {
  constructor(h) {
    this.h = h;
    this.mode = 'demo';
    this.key = 'hat-meclisi-demo';
    this.cool = params.has('cool') ? Number(params.get('cool')) * 1000 : COOLDOWN_MS;
    this.uid = storageGet('hat-meclisi-demo-uid') || `demo-${randomId().slice(1, 9)}`;
    storageSet('hat-meclisi-demo-uid', this.uid);
    this.cooldownUntil = 0;
  }

  now() { return Date.now(); }

  load() {
    try {
      const d = JSON.parse(storageGet(this.key) || '{}');
      return { lines: d.lines || {}, corr: d.corr || {}, votes: d.votes || {}, log: d.log || {}, cool: d.cool || {} };
    } catch {
      return { lines: {}, corr: {}, votes: {}, log: {}, cool: {} };
    }
  }

  async start() {
    this.data = this.load();
    for (const [id, n] of Object.entries(this.data.lines)) this.h.line(id, n);
    for (const [id, n] of Object.entries(this.data.corr)) this.h.corr(id, n);
    for (const [id, n] of Object.entries(this.data.votes)) this.h.votes(id, n);
    for (const id of Object.keys(this.data.log).sort().slice(-LOG_LIMIT)) this.h.log(id, this.data.log[id], false);
    this.cooldownUntil = (this.data.cool[this.uid] || 0) + this.cool;
    this.h.cooldown(this.cooldownUntil);
    this.h.status('demo');
    try {
      this.channel = new BroadcastChannel(this.key);
      this.channel.onmessage = () => this.reload();
    } catch { /* no cross-tab sync */ }
  }

  // Another tab wrote: diff the stored state against ours and report what changed.
  reload() {
    const next = this.load();
    for (const [part, fn] of [['lines', 'line'], ['corr', 'corr'], ['votes', 'votes']]) {
      const a = this.data[part], b = next[part];
      for (const id of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (JSON.stringify(a[id]) !== JSON.stringify(b[id])) this.h[fn](id, b[id] ?? null);
      }
    }
    for (const id of Object.keys(next.log).sort()) if (!this.data.log[id]) this.h.log(id, next.log[id], true);
    this.data = next;
  }

  save() {
    const ids = Object.keys(this.data.log).sort();
    for (const id of ids.slice(0, Math.max(0, ids.length - LOG_LIMIT))) delete this.data.log[id];
    storageSet(this.key, JSON.stringify(this.data));
    this.channel?.postMessage(1);
  }

  newId() { return randomId(); }

  async commit(change, nick) {
    if (this.now() < this.cooldownUntil) throw fail('cooldown');
    const now = Date.now();
    const u = buildUpdate(change, this.uid, nick, randomId());
    const fresh = (v) => (v && typeof v === 'object' && v['.sv'] ? now : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fresh(x)])) : v);
    for (const [path, value] of Object.entries(u)) {
      const [part, id] = path.split('/');
      if (part === 'lines' && value && !change.created?.has(id) && this.data.lines[id]?.a !== this.uid) throw fail('denied');
      const v = fresh(value);
      if (v === null) delete this.data[part][id];
      else this.data[part][id] = v;
      const fn = { lines: 'line', corr: 'corr', votes: 'votes' }[part];
      if (fn) this.h[fn](id, v);
      if (part === 'log') this.h.log(id, v, true);
    }
    this.cooldownUntil = now + this.cool;
    this.h.cooldown(this.cooldownUntil);
    this.save();
  }

  async vote(lineId, v) {
    const votes = { ...(this.data.votes[lineId] || {}) };
    if (v) votes[this.uid] = v;
    else delete votes[this.uid];
    if (Object.keys(votes).length) this.data.votes[lineId] = votes;
    else delete this.data.votes[lineId];
    this.h.votes(lineId, this.data.votes[lineId] || null);
    this.save();
  }
}
