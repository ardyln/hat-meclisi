// Security rules tests against the Realtime Database emulator. Run from the repo root:
//   npx firebase-tools emulators:exec --only database --project demo-hat-meclisi "node tools/test-rules.mjs"
// Each scenario uses fresh users, so the 10 s cooldown only gets in the way where it is
// the thing being tested.

import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { ref, update, set, remove, get } from 'firebase/database';
import { serializeLine } from '../js/model.js';

const TS = { '.sv': 'timestamp' };
const env = await initializeTestEnvironment({
  projectId: 'demo-hat-meclisi',
  database: { rules: readFileSync('database.rules.json', 'utf8'), host: '127.0.0.1', port: 9000 },
});

let n = 0, failed = 0, user = 0;
async function test(name, fn) {
  n++;
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${name}\n      ${e.message}`);
  }
}

const freshUser = () => `u${++user}`;
const db = (uid) => (uid ? env.authenticatedContext(uid).database() : env.unauthenticatedContext().database());
let ids = 0;
const newId = () => `-test${String(++ids).padStart(8, '0')}`;
const logId = () => `-log${String(++ids).padStart(10, '0')}`;

const SEG = [[41.0, 29.0], [41.01, 29.02], [41.02, 29.05]];
function draft(over = {}) {
  return { name: 'M99 Test', kind: 'p', mode: 'metro', color: '#e3051b', segs: [SEG], stations: [{ lat: 41, lng: 29, name: 'A' }], desc: '', corridor: null, ...over };
}

// Mirrors buildUpdate() in js/backend.js.
function change(uid, { lines = {}, created = [], corr = {}, dropVotes = [], log = { a: 'new', i: 'x' } }) {
  const u = {};
  for (const [id, node] of Object.entries(lines)) u[`lines/${id}`] = node === null ? null : { ...node, t: TS, t0: created.includes(id) ? TS : node.t0 };
  for (const [id, node] of Object.entries(corr)) u[`corr/${id}`] = { ...node, a: uid, t: TS };
  for (const id of dropVotes) u[`votes/${id}`] = null;
  u[`cool/${uid}`] = { t: TS };
  u[`log/${logId()}`] = { u: uid, t: TS, ...log };
  return u;
}

async function propose(uid, over = {}) {
  const id = newId();
  const node = serializeLine(draft({ corridor: id, ...over }), uid, 'nick');
  await assertSucceeds(update(ref(db(uid)), change(uid, { lines: { [id]: node }, created: [id], corr: { [id]: { n: node.n } }, log: { a: 'new', i: id, s: node.n } })));
  return { id, node };
}

async function readRaw(path) {
  let v;
  await env.withSecurityRulesDisabled(async (ctx) => { v = (await get(ref(ctx.database(), path))).val(); });
  return v;
}

async function seedAs(path, value) {
  await env.withSecurityRulesDisabled((ctx) => set(ref(ctx.database(), path), value));
}

// ----------------------------------------------------------------------------------

await test('anyone can read lines, corridors, votes and the feed', async () => {
  for (const p of ['lines', 'corr', 'votes', 'log']) await assertSucceeds(get(ref(db(null), p)));
});

await test('cooldowns are private', async () => {
  await assertFails(get(ref(db(freshUser()), 'cool/someone-else')));
});

await test('signed-out visitors cannot write', async () => {
  const id = newId();
  const node = serializeLine(draft({ corridor: id }), 'x', 'x');
  await assertFails(update(ref(db(null)), { [`lines/${id}`]: node }));
});

await test('a new proposal with its corridor, cooldown and feed entry is accepted', async () => {
  await propose(freshUser());
});

await test('a second change within 10 s is refused', async () => {
  const a = freshUser();
  await propose(a);
  const id = newId();
  const node = serializeLine(draft({ corridor: id }), a, 'n');
  await assertFails(update(ref(db(a)), change(a, { lines: { [id]: node }, created: [id], corr: { [id]: { n: 'x' } } })));
});

await test('a line without a cooldown stamp is refused', async () => {
  const a = freshUser(), id = newId();
  const node = serializeLine(draft({ corridor: id }), a, 'n');
  await assertFails(update(ref(db(a)), { [`lines/${id}`]: { ...node, t: TS, t0: TS }, [`corr/${id}`]: { n: 'x', a, t: TS } }));
});

await test('a proposal needs its corridor', async () => {
  const a = freshUser(), id = newId();
  const node = serializeLine(draft({ corridor: id }), a, 'n');
  await assertFails(update(ref(db(a)), change(a, { lines: { [id]: node }, created: [id] })));
});

await test('someone else can add an alternative alignment to a corridor', async () => {
  const { id } = await propose(freshUser());
  const b = freshUser(), alt = newId();
  const node = serializeLine(draft({ corridor: id, fork: id, name: 'via B' }), b, 'b');
  await assertSucceeds(update(ref(db(b)), change(b, { lines: { [alt]: node }, created: [alt], log: { a: 'alt', i: alt } })));
});

await test('an alternative cannot point at a corridor that does not exist', async () => {
  const b = freshUser(), alt = newId();
  const node = serializeLine(draft({ corridor: '-doesnotexist00' }), b, 'b');
  await assertFails(update(ref(db(b)), change(b, { lines: { [alt]: node }, created: [alt], log: { a: 'alt', i: alt } })));
});

await test('nobody can open a corridor for someone else’s line', async () => {
  const { id } = await propose(freshUser());
  const b = freshUser(), alt = newId();
  const node = serializeLine(draft({ corridor: id }), b, 'b');
  await assertFails(update(ref(db(b)), change(b, { lines: { [alt]: node }, created: [alt], corr: { [alt]: { n: 'hijack' } } })));
});

await test('only the author can edit a line', async () => {
  const { id, node } = await propose(freshUser());
  const stored = await readRaw(`lines/${id}`);
  const b = freshUser();
  await assertFails(update(ref(db(b)), change(b, { lines: { [id]: { ...node, n: 'mine now', a: b, t0: stored.t0 } }, log: { a: 'edit', i: id } })));
});

await test('the author can edit, keeping the creation time, corridor and kind', async () => {
  const a = freshUser();
  const { id, node } = await propose(a);
  const stored = await readRaw(`lines/${id}`);
  await seedAs(`cool/${a}`, { t: Date.now() - 20000 });
  await assertFails(update(ref(db(a)), change(a, { lines: { [id]: { ...node, n: 'renamed', t0: stored.t0 - 1 } }, log: { a: 'edit', i: id } })));
  await assertFails(update(ref(db(a)), change(a, { lines: { [id]: { ...node, k: 'e', g: null, t0: stored.t0 } }, log: { a: 'edit', i: id } })));
  await assertSucceeds(update(ref(db(a)), change(a, { lines: { [id]: { ...node, n: 'renamed', t0: stored.t0 } }, corr: { [id]: { n: 'renamed' } }, log: { a: 'edit', i: id } })));
});

await test('the cooldown expires after 10 s', async () => {
  const a = freshUser();
  await propose(a);
  await new Promise((r) => setTimeout(r, 10200));
  await propose(a);
});

await test('fields are validated', async () => {
  const bad = [
    { m: 'rocket' },
    { c: 'red' },
    { p: 'has<html>' },
    { n: '' },
    { n: 'x'.repeat(61) },
    { s: 'not json' },
    { extra: 1 },
  ];
  for (const over of bad) {
    const a = freshUser(), id = newId();
    const node = { ...serializeLine(draft({ corridor: id }), a, 'n'), ...over };
    await assertFails(update(ref(db(a)), change(a, { lines: { [id]: node }, created: [id], corr: { [id]: { n: 'x' } } })));
  }
});

await test('votes: one ±1 per user, only on proposals, only as yourself', async () => {
  const { id } = await propose(freshUser());
  const b = freshUser();
  await assertSucceeds(set(ref(db(b), `votes/${id}/${b}`), 1));
  await assertSucceeds(set(ref(db(b), `votes/${id}/${b}`), -1));
  await assertSucceeds(remove(ref(db(b), `votes/${id}/${b}`)));
  await assertFails(set(ref(db(b), `votes/${id}/${b}`), 2));
  await assertFails(set(ref(db(b), `votes/${id}/someone-else`), 1));
  await assertFails(set(ref(db(b), `votes/-nosuchline0000/${b}`), 1));
});

await test('existing lines can be imported in a batch, with their OSM id', async () => {
  const a = freshUser();
  const n1 = serializeLine(draft({ kind: 'e', osm: 'r111' }), a, 'n');
  const n2 = serializeLine(draft({ kind: 'e', osm: 'r222' }), a, 'n');
  await assertSucceeds(update(ref(db(a)), change(a, { lines: { 'osm-r111': n1, 'osm-r222': n2 }, created: ['osm-r111', 'osm-r222'], log: { a: 'imp', i: 'osm-r111', c: 2 } })));
  const b = freshUser();
  await assertFails(set(ref(db(b), `votes/osm-r111/${b}`), 1));
  const c = freshUser();
  const n3 = serializeLine(draft({ kind: 'e' }), c, 'n');
  await assertFails(update(ref(db(c)), change(c, { lines: { 'osm-r333': n3 }, created: ['osm-r333'], log: { a: 'imp', i: 'osm-r333', c: 1 } })));
});

await test('an imported line cannot be overwritten by another visitor', async () => {
  const b = freshUser();
  const n = serializeLine(draft({ kind: 'e', osm: 'r111', name: 'vandal' }), b, 'n');
  await assertFails(update(ref(db(b)), change(b, { lines: { 'osm-r111': n }, created: ['osm-r111'], log: { a: 'imp', i: 'osm-r111', c: 1 } })));
});

await test('the author can delete a line together with its votes; others cannot', async () => {
  const a = freshUser();
  const { id } = await propose(a);
  const b = freshUser();
  await assertSucceeds(set(ref(db(b), `votes/${id}/${b}`), 1));
  const c = freshUser();
  await assertFails(update(ref(db(c)), change(c, { lines: { [id]: null }, dropVotes: [id], log: { a: 'del', i: id } })));
  await assertFails(update(ref(db(b)), { [`votes/${id}`]: null }));
  await seedAs(`cool/${a}`, { t: Date.now() - 20000 });
  await assertSucceeds(update(ref(db(a)), change(a, { lines: { [id]: null }, dropVotes: [id], log: { a: 'del', i: id } })));
});

await test('feed entries must be your own, stamped, and use a known action', async () => {
  const a = freshUser();
  await assertFails(update(ref(db(a)), { [`cool/${a}`]: { t: TS }, [`log/${logId()}`]: { u: a, t: TS, a: 'hack', i: 'x' } }));
  const b = freshUser();
  await assertFails(update(ref(db(b)), { [`cool/${b}`]: { t: TS }, [`log/${logId()}`]: { u: 'someone', t: TS, a: 'new', i: 'x' } }));
  const c = freshUser();
  await assertFails(set(ref(db(c), `log/${logId()}`), { u: c, t: TS, a: 'new', i: 'x' }));
});

await test('only the corridor’s author can rename it', async () => {
  const { id } = await propose(freshUser());
  const b = freshUser();
  await assertFails(update(ref(db(b)), { [`cool/${b}`]: { t: TS }, [`corr/${id}`]: { n: 'renamed', a: b, t: TS }, [`log/${logId()}`]: { u: b, t: TS, a: 'edit', i: id } }));
});

console.log(`\n${n - failed}/${n} passed`);
await env.cleanup();
process.exit(failed ? 1 : 0);
