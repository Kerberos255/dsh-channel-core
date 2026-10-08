import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { CoreStore } from '../lib/store.js';
import { IdentityRouter } from '../lib/routing.js';
import { Coordinator } from '../lib/coordinator.js';
import { channelMessage } from '../lib/validation.js';

const gate = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } };
const tick = () => new Promise(done => setImmediate(done));
const request = (n, sessionId = 'root') => ({ sessionId, requestId: 'request-' + n, content: [{ type: 'text', text: 'input ' + n }] });
const options = (n, extra = {}) => ({ key: 'key-' + n, ...extra });
function harness(prompt) {
  const store = new CoreStore(':memory:');
  const calls = [], cancellations = [];
  const core = new Coordinator(store, {
    async prompt(r) { calls.push(r); return prompt ? prompt(r) : { accepted: true } },
    cancel(r) { cancellations.push(r); return { accepted: true } },
  });
  return { store, core, calls, cancellations, async close() { await core.close(); store.close() } };
}
const scope = { workspaceId: 'work', presetId: 'preset', memoryNamespace: 'm', scheduleNamespace: 's' };
const message = { provider: 'feishu', accountId: 'bot', conversationId: 'chat', userId: 'person', messageId: '1', kind: 'dm', text: 'hello', attachments: [], timestamp: 1 };
function temporary(fn) {
  const dir = mkdtempSync(path.resolve('test-state-'));
  try { return fn(path.join(dir, 'state.sqlite')) } finally {
    assert.equal(realpathSync(dir).startsWith(realpathSync(process.cwd()) + path.sep), true);
    rmSync(dir, { recursive: true, force: true });
  }
}
test('verified aliases share DM; strangers, workspaces and threads stay separate', () => {
  const store = new CoreStore(':memory:');
  try {
    const router = new IdentityRouter(store, { scope });
    const first = router.route(message);
    const discord = { ...message, provider: 'discord', conversationId: 'discord-dm' };
    assert.notEqual(router.route(discord).binding.sessionId, first.binding.sessionId);
    store.verifyAlias(discord, first.binding.scope.identityId, 'local-operator');
    const shared = router.route(discord);
    assert.equal(shared.binding.sessionId, first.binding.sessionId);
    assert.equal(shared.inboundMode, 'steering');
    assert.notEqual(router.route(discord, { scope: { ...scope, workspaceId: 'other' } }).binding.sessionId, first.binding.sessionId);
    assert.notEqual(router.route({ ...message, kind: 'thread', threadId: 't1' }).binding.sessionId, router.route({ ...message, kind: 'thread', threadId: 't2' }).binding.sessionId);
    assert.equal(router.route({ ...message, kind: 'group' }).binding.sessionId, router.route({ ...message, kind: 'group', userId: 'other-member' }).binding.sessionId);
  } finally { store.close() }
});
test('shared/separate setting changes routing without merging historic bindings', () => {
  const store = new CoreStore(':memory:');
  try {
    const router = new IdentityRouter(store, { scope });
    const shared = router.route(message).binding.sessionId;
    const separate = router.route(message, { sharedDM: false }).binding.sessionId;
    assert.notEqual(shared, separate);
    assert.equal(router.route(message).binding.sessionId, shared);
    assert.equal(router.route(message, { sharedDM: false }).binding.sessionId, separate);
  } finally { store.close() }
});
test('durable receipts preserve acceptance and mark incomplete admission uncertain after restart', () => temporary(filename => {
  let store = new CoreStore(filename);
  try {
    const input = { key: 'event-1', requestId: 'req', sessionId: 's', origin: {}, payload: 'hello' };
    assert.equal(store.claim(input).fresh, true);
    assert.equal(store.claim(input).fresh, false);
    assert.throws(() => store.claim({ ...input, payload: 'different' }), { code: 'receipt-conflict' });
    store.status('req', 'admitting'); store.close(); store = new CoreStore(filename);
    assert.equal(store.receipt('req').status, 'uncertain');
    store.claim({ ...input, key: 'event-2', requestId: 'accepted' }); store.status('accepted', 'accepted');
    store.close(); store = new CoreStore(filename);
    assert.equal(store.receipt('accepted').status, 'accepted');
  } finally { store.close() }
}));
test('prototype schema upgrade retains identities and makes ambiguous old inputs uncertain', () => temporary(filename => {
  const db = new DatabaseSync(filename);
  db.exec(`CREATE TABLE receipts(key TEXT PRIMARY KEY,request_id TEXT,session_id TEXT,epoch INTEGER,digest TEXT,status TEXT,origin TEXT,created_at INTEGER);
    INSERT INTO receipts VALUES('k','r','s',1,'d','cancelled','{}',1);
    CREATE TABLE interactions(token TEXT PRIMARY KEY,session_id TEXT,epoch INTEGER,actor_id TEXT,payload TEXT,expires_at INTEGER,consumed INTEGER);
    CREATE TABLE epochs(session_id TEXT); CREATE TABLE cancelled_messages(message_id TEXT); CREATE TABLE outbox(key TEXT);`);
  db.close();
  const store = new CoreStore(filename);
  try {
    assert.equal(store.receipt('r').status, 'uncertain');
    assert.equal(store.db.prepare('PRAGMA table_info(receipts)').all().some(c => c.name === 'epoch'), false);
    assert.equal(store.db.prepare("SELECT name FROM sqlite_master WHERE name='epochs'").get(), undefined);
  } finally { store.close() }
}));
test('concurrent duplicate delivery admits once and prepares the native Session once', async () => {
  const h = harness(); let prepared = 0;
  try {
    await Promise.all(Array.from({ length: 30 }, () => h.core.admit(request(1), options(1, { prepare: async () => { prepared++ } }))));
    assert.equal(h.calls.length, 1); assert.equal(prepared, 1);
  } finally { await h.close() }
});
test('same Session admission is serialized while another Session can proceed', async () => {
  const wait = gate(), h = harness(async r => { if (r.requestId === 'request-1') await wait.promise; return { accepted: true } });
  try {
    const a = h.core.admit(request(1), options(1));
    const b = h.core.admit(request(2), options(2));
    await h.core.admit(request(3, 'other'), options(3));
    assert.deepEqual(h.calls.map(r => r.requestId), ['request-1', 'request-3']);
    wait.resolve(); await Promise.all([a, b]);
    assert.equal(h.calls.at(-1).requestId, 'request-2');
  } finally { wait.resolve(); await h.close() }
});
test('steering/queue/interrupt reuse native policies and native cancellation', async () => {
  const h = harness();
  try {
    await h.core.admit(request(1), options(1));
    await h.core.admit(request(2), options(2, { policy: 'queue' }));
    await h.core.admit(request(3), options(3, { policy: 'interrupt' }));
    assert.deepEqual(h.calls.map(r => r.mode), ['steer', 'queue', 'queue']);
    assert.deepEqual(h.cancellations, [{ sessionId: 'root' }]);
    assert.equal(h.store.receipt('request-1').status, 'accepted');
  } finally { await h.close() }
});
test('native admission rejection can retry; an ambiguous failure cannot execute twice', async () => {
  let fail = true;
  const h = harness(() => { if (fail) throw Object.assign(new Error('reject'), { name: 'RemoteError' }); return { accepted: true } });
  try {
    await assert.rejects(h.core.admit(request(1), options(1)), /reject/);
    assert.equal(h.store.receipt('request-1').status, 'received');
    fail = false; await h.core.admit(request(1), options(1));
    assert.equal(h.calls.length, 2);
  } finally { await h.close() }
  const uncertain = harness(() => { throw new Error('connection failed') });
  try {
    await assert.rejects(uncertain.core.admit(request(1), options(1)), /connection failed/);
    await assert.rejects(uncertain.core.admit(request(1), options(1)), { code: 'uncertain-input' });
    assert.equal(uncertain.calls.length, 1);
  } finally { await uncertain.close() }
});
test('caller abort before admission retries safely; abort after native acceptance preserves receipt', async () => {
  const h = harness(), signal = new AbortController();
  try {
    signal.abort();
    await assert.rejects(h.core.admit(request(1), options(1, { signal: signal.signal })), { code: 'aborted-input' });
    assert.equal(h.calls.length, 0);
    await h.core.admit(request(1), options(1));
    assert.equal(h.calls.length, 1);
  } finally { await h.close() }
  const wait = gate(), acceptedSignal = new AbortController(), accepted = harness(async () => { await wait.promise; return { accepted: true } });
  try {
    const task = accepted.core.admit(request(2), options(2, { signal: acceptedSignal.signal }));
    await tick(); acceptedSignal.abort(); wait.resolve(); await task;
    assert.equal(accepted.store.receipt('request-2').status, 'accepted');
  } finally { wait.resolve(); await accepted.close() }
});
test('binding writes use revision compare-and-swap', () => {
  const store = new CoreStore(':memory:');
  try {
    const first = store.putBinding('k', { sessionId: 'one', scope });
    assert.throws(() => store.putBinding('k', { sessionId: 'two', scope }), { code: 'binding-conflict' });
    assert.equal(store.putBinding('k', { sessionId: 'two', scope }, first.revision).revision, 2);
  } finally { store.close() }
});
test('interaction tokens enforce actor, expiry and single use', () => {
  const store = new CoreStore(':memory:');
  try {
    const token = store.interaction('s', 'actor', { question: 'q' });
    assert.throws(() => store.consumeInteraction(token, 'other'), { code: 'stale-interaction' });
    assert.deepEqual(store.consumeInteraction(token, 'actor').payload, { question: 'q' });
    assert.throws(() => store.consumeInteraction(token, 'actor'), { code: 'stale-interaction' });
    const expired = store.interaction('s', 'actor', {}, -1);
    assert.throws(() => store.consumeInteraction(expired, 'actor'), { code: 'stale-interaction' });
  } finally { store.close() }
});
test('malformed channel input fails before storage or native admission', () => {
  for (const change of [{ provider: 'unknown' }, { userId: '' }, { text: ' ' }, { timestamp: NaN }, { attachments: [null] }, { text: 'a'.repeat(65537) }]) {
    assert.throws(() => channelMessage({ ...message, ...change }), { name: 'CoreError' });
  }
});
test('dispose drains admitted requests and rejects later admission', async () => {
  const wait = gate(), h = harness(async () => { await wait.promise; return { accepted: true } });
  const task = h.core.admit(request(1), options(1)); await tick();
  const closing = h.core.close();
  assert.throws(() => h.core.admit(request(2), options(2)), { code: 'core-closed' });
  wait.resolve(); await Promise.all([task, closing]);
  assert.equal(h.store.receipt('request-1').status, 'accepted'); h.store.close();
});
