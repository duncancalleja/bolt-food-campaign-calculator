import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const sync = require('../../malta-hub-sync.js');
const here = dirname(fileURLToPath(import.meta.url));

const am = 'Fiona Borg';
const kpiKey = `${am}||Bolt Plus`;
const tick = 'targeting||Sponsored Listings||Fiona Borg||976';
const comment = 'amComment||Sponsored Listings||Fiona Borg||976';

function memoryStorage(seed = {}) {
  const data = new Map(Object.entries(seed));
  return {
    getItem: k => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
  };
}

function testKeys() {
  assert.equal(sync.isSyncableKey(tick), true);
  assert.equal(sync.isSyncableKey(comment), true);
  assert.equal(sync.isSyncableKey('amComment||Sponsored Listings||976'), true);
  assert.equal(sync.isSyncableKey('nextStep||Smart Promotions||12'), true);
  assert.equal(sync.isSyncableKey(kpiKey), true);
  assert.equal(sync.isSyncableKey('Alena Tokareva||Q3 Renegotiations'), true);
  assert.equal(sync.isSyncableKey('Duncan Calleja||Bolt Plus'), false);
  assert.equal(sync.isSyncableKey('targeting||Sponsored Listings||Fiona Borg'), false);
  assert.equal(sync.isSyncableKey('notes'), false);
  assert.equal(sync.sameValue({ b: 1, a: { d: 2, c: 3 } }, { a: { c: 3, d: 2 }, b: 1 }), true);
}

function testMerge() {
  const local = {
    [kpiKey]: { notes: 'from this browser', confidence: 'Low' },
    [tick]: true,
    [comment]: 'local comment',
    'keep-me': 1,
  };
  const remote = {
    [kpiKey]: { notes: 'from the sheet', confidence: 'High', amComment: 'sheet' },
    'amComment||Sponsored Listings||976': 'legacy',
  };

  const first = sync.mergeSharedState(local, remote, { migrated: false });
  assert.deepEqual(first.state[kpiKey], remote[kpiKey]);
  assert.equal(first.state[tick], true);
  assert.equal(first.state[comment], 'local comment');
  assert.equal(first.state['amComment||Sponsored Listings||976'], 'legacy');
  assert.equal(first.state['keep-me'], 1);
  assert.equal(first.meta.pendingUpserts[tick], true);
  assert.equal(first.meta.pendingUpserts[comment], 'local comment');
  assert.equal(kpiKey in first.meta.pendingUpserts, false);
  assert.equal(first.meta.migrated, false);

  const pending = sync.mergeSharedState(local, remote, {
    migrated: true,
    pendingUpserts: { [kpiKey]: { notes: 'typing', confidence: 'Medium' } },
    pendingDeletes: [tick],
  });
  assert.equal(pending.state[kpiKey].notes, 'typing');
  assert.equal(tick in pending.state, false);
  assert.equal(comment in pending.state, false);

  const after = sync.mergeSharedState(
    { [tick]: true, [comment]: 'stale local' },
    { [comment]: 'sheet comment' },
    { migrated: true }
  );
  assert.equal(tick in after.state, false);
  assert.equal(after.state[comment], 'sheet comment');
  assert.equal(sync.hasPending(after.meta), false);
}

function testNoteAndAck() {
  const meta = sync.noteChange(
    { [tick]: true, [kpiKey]: { notes: 'a' } },
    { [kpiKey]: { notes: 'b', confidence: 'High' } },
    { migrated: true }
  );
  assert.equal(meta.pendingDeletes.includes(tick), true);
  assert.equal(meta.pendingUpserts[kpiKey].notes, 'b');

  const acked = sync.acknowledgePush(meta, { [kpiKey]: { notes: 'b', confidence: 'High' } }, [tick]);
  assert.equal(sync.hasPending(acked), false);
  assert.equal(acked.migrated, true);

  const newer = sync.noteChange({}, { [comment]: 'v2' }, meta);
  const partial = sync.acknowledgePush(newer, { [kpiKey]: { notes: 'b', confidence: 'High' } }, [tick]);
  assert.equal(partial.pendingUpserts[comment], 'v2');
}

function scriptAllowlistMatches() {
  const gs = readFileSync(join(here, 'Code.gs'), 'utf8');
  for (const name of sync.AM_NAMES) assert.ok(gs.includes(name), name);
  for (const kpi of sync.KPI_NAMES) assert.ok(gs.includes(kpi), kpi);
  assert.ok(gs.includes('Hub shared state'));
  assert.ok(gs.includes('12YkQowNT23C1i9D9SYuPuiYA_HazgSkEZUHRZnNi9kA'));
  assert.equal(gs.includes('setName'), false);
  assert.equal(gs.includes('Duncan'), false);
}

function startSheet() {
  const rows = new Map();
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const token = url.searchParams.get('token') || '';
    const finish = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(body));
    };
    const entries = () => Object.fromEntries(rows);
    if (token !== 'secret') return finish(200, { ok: false, error: 'unauthorized' });
    if (req.method === 'GET') return finish(200, { ok: true, applied: false, entries: entries() });
    if (req.method !== 'POST') return finish(405, { ok: false, error: 'method' });
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
      catch { return finish(200, { ok: false, error: 'bad json' }); }
      const rejected = [];
      for (const [key, value] of Object.entries(body.upserts || {})) {
        if (!sync.isSyncableKey(key)) rejected.push(key);
        else rows.set(key, value);
      }
      for (const key of body.deletes || []) {
        if (!sync.isSyncableKey(key)) rejected.push(key);
        else rows.delete(key);
      }
      finish(200, { ok: true, applied: true, entries: entries(), rejected });
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}/exec`,
        close: () => new Promise(r => server.close(r)),
      });
    });
  });
}

async function testTwoBrowsers() {
  const sheet = await startSheet();
  const timers = [];
  const setTimer = (fn, ms) => {
    const id = setTimeout(fn, ms);
    timers.push(id);
    return id;
  };
  const make = (seed) => sync.createHubSync({
    storage: memoryStorage(seed),
    fetch: globalThis.fetch,
    setTimer,
    clearTimer: id => clearTimeout(id),
    onToast() {},
    onStatus() {},
    onState() {},
  });

  const browserA = make({
    'mt-mm-performance-hub-v2': JSON.stringify({
      [comment]: 'already typed',
      [tick]: true,
      [kpiKey]: { notes: 'local note', confidence: 'Low', amComment: 'kpi comment' },
    }),
  });
  await browserA.boot({ webAppUrl: sheet.url, token: 'secret' });
  await browserA.flush();
  assert.equal(browserA.statusInfo().status, 'saved');
  assert.equal(browserA.loadState()[comment], 'already typed');
  assert.equal(browserA.loadState()[tick], true);

  const browserB = make({});
  await browserB.boot({ webAppUrl: sheet.url, token: 'secret' });
  assert.equal(browserB.loadState()[comment], 'already typed');
  assert.equal(browserB.loadState()[tick], true);
  assert.equal(browserB.loadState()[kpiKey].notes, 'local note');
  assert.equal(browserB.loadState()[kpiKey].confidence, 'Low');
  assert.equal(browserB.loadState()[kpiKey].amComment, 'kpi comment');

  const cleared = Object.assign({}, browserB.loadState());
  delete cleared[tick];
  cleared[comment] = 'from B';
  cleared[kpiKey] = Object.assign({}, cleared[kpiKey], { confidence: 'High', notes: 'from B' });
  browserB.saveState(cleared);
  await browserB.flush();

  await browserA.pull();
  assert.equal(browserA.loadState()[tick], undefined);
  assert.equal(browserA.loadState()[comment], 'from B');
  assert.equal(browserA.loadState()[kpiKey].confidence, 'High');
  assert.equal(browserA.loadState()[kpiKey].notes, 'from B');

  const offline = make({});
  await offline.boot({ webAppUrl: 'http://127.0.0.1:9/exec', token: 'secret' });
  assert.equal(offline.statusInfo().status, 'error');
  offline.saveState({ [kpiKey]: { notes: 'kept locally' } });
  assert.equal(offline.loadState()[kpiKey].notes, 'kept locally');

  const unconfigured = make({ 'mt-mm-performance-hub-v2': JSON.stringify({ [tick]: true }) });
  await unconfigured.boot({ webAppUrl: '', token: '' });
  assert.equal(unconfigured.statusInfo().status, 'off');
  assert.equal(unconfigured.statusInfo().shortHint, 'Team sync not connected');
  assert.equal(unconfigured.loadState()[tick], true);

  timers.forEach(id => clearTimeout(id));
  await sheet.close();
}

async function testStaleGetDoesNotDropASave() {
  let releaseGet;
  const gate = new Promise(resolve => { releaseGet = resolve; });
  let gets = 0;
  const rows = new Map();
  const fetchImpl = async (url, init) => {
    const method = (init && init.method) || 'GET';
    if (method === 'GET') {
      gets += 1;
      if (gets === 1) await gate;
    } else {
      const body = JSON.parse(init.body);
      for (const [k, v] of Object.entries(body.upserts || {})) rows.set(k, v);
      for (const k of body.deletes || []) rows.delete(k);
    }
    return {
      text: async () => JSON.stringify({
        ok: true,
        applied: method === 'POST',
        entries: Object.fromEntries(rows),
      }),
    };
  };
  const client = sync.createHubSync({
    storage: memoryStorage(),
    fetch: fetchImpl,
    setTimer() { return 0; },
    clearTimer() {},
    onToast() {},
    onStatus() {},
    onState() {},
  });
  const pullPromise = client.boot({ webAppUrl: 'https://example.test/exec', token: 'secret' });
  client.saveState({ [comment]: 'typed during load' });
  await client.flush();
  releaseGet();
  await pullPromise;
  assert.equal(client.loadState()[comment], 'typed during load');
  assert.equal(rows.get(comment), 'typed during load');
}

testKeys();
testMerge();
testNoteAndAck();
scriptAllowlistMatches();
await testTwoBrowsers();
await testStaleGetDoesNotDropASave();
console.log('malta hub sync tests passed');
