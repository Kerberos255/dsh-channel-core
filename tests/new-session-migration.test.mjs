import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { CoreStore } from '../lib/store.js';
import { NewSessionMigration, toCreateInput, isExpiredOneShot } from '../lib/new-session-migration.js';

const previous = 'session-old';
const next = 'session-new';
const scope = { workspaceId: 'w', presetId: 'agent', memoryNamespace: 'private', scheduleNamespace: 'private', identityId: 'i' };

function task(overrides = {}) {
  return {
    id: 'schedule-' + randomUUID().slice(0, 8),
    sessionId: previous,
    status: 'active',
    kind: 'cron',
    title: '早盘日报',
    prompt: '生成报告',
    expression: '45 9 * * 1-5',
    timeZone: 'Asia/Shanghai',
    scheduledAt: new Date(Date.now() + 3600_000).toISOString(),
    ...overrides,
  };
}

function fixture({ tasks = [], agentStatus, failCreate, uncertainCreate, failDelete, changeBindingsDuringCreate, archiveThrows } = {}) {
  const store = new CoreStore(':memory:');
  const live = [...tasks];
  const archived = [];
  const calls = { created: [], deleted: [] };

  const schedule = {
    async catalog() { return live.map(row => ({ ...row })); },
    async create(sessionId, input) {
      if (changeBindingsDuringCreate) {
        changeBindingsDuringCreate();
      }
      if (uncertainCreate) { const e = new Error('timeout'); e.name = 'TimeoutError'; throw e; }
      if (failCreate) { const e = new Error('boom'); e.code = 'create-failed'; throw e; }
      const row = {
        id: 'schedule-' + randomUUID().slice(0, 8),
        sessionId, status: 'active', title: input.title, prompt: input.prompt,
        kind: input.cron ? 'cron' : input.at ? 'at' : input.every_seconds ? 'every' : 'cron',
        expression: input.cron?.expression, timeZone: input.cron?.time_zone ?? input.at?.time_zone,
        scheduledAt: input.at ?? new Date(Date.now() + 3600_000).toISOString(),
      };
      live.push(row);
      calls.created.push({ sessionId, input, id: row.id });
      return row;
    },
    async delete({ sessionId, id }) {
      if (failDelete) { const e = new Error('nope'); e.code = 'delete-failed'; throw e; }
      const index = live.findIndex(row => row.id === id && row.sessionId === sessionId);
      if (index >= 0) live.splice(index, 1);
      calls.deleted.push({ sessionId, id });
    },
  };

  const ctx = {
    get(name) {
      if (name === 'schedule') return schedule;
      if (name === 'workspaceRegistry') return { async archiveSession(id) { if (archiveThrows) throw Object.assign(new Error('busy'), { name: 'WorkspaceActiveSessionError' }); archived.push(id); } };
      if (name === 'agents') return { get: () => (agentStatus ? { status: agentStatus } : undefined) };
      return undefined;
    },
  };

  const core = { ctx, store, bridge: { interactions: { pending: new Map() } } };
  const bindingKey = 'route-key-' + previous;
  store.putBinding(bindingKey, { provider: 'feishu', accountId: 'bot', conversationId: 'chat-approved', kind: 'group', sessionId: previous, scope });

  return { core, store, live, archived, calls, schedule, bindingKey };
}

const run = (f, overrides = {}) => new NewSessionMigration(f.core).run({ previous, next, scope, correlationId: 'receipt-1', ...overrides });

test('migrates active tasks, switches the binding and archives the old session', async () => {
  const t = task();
  const f = fixture({ tasks: [t] });
  const outcome = await run(f);

  assert.equal(outcome.migrated.length, 1);
  assert.equal(outcome.failed.length, 0);
  assert.equal(outcome.archived.ok, true);
  assert.deepEqual(f.archived, [previous]);

  const rows = f.store.db.prepare('SELECT session_id FROM bindings').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].session_id, next, 'binding must move to the new session');
  assert.equal(f.live.filter(r => r.sessionId === previous).length, 0);
  assert.equal(f.live.filter(r => r.sessionId === next).length, 1);
  assert.deepEqual(f.calls.deleted.map(r => r.id), [t.id]);
  assert.equal(f.store.routeHistory(previous).length, 1, 'retired route recorded for B1 fallback');
});

test('inactive tasks are never recreated', async () => {
  const done = task({ status: 'inactive', kind: 'at', at: new Date(Date.now() - 86400_000).toISOString() });
  const f = fixture({ tasks: [done] });
  const outcome = await run(f);
  assert.equal(outcome.migrated.length, 0);
  assert.equal(outcome.skipped.length, 1);
  assert.equal(outcome.skipped[0].reason, 'inactive');
  assert.equal(f.calls.created.length, 0);
});

test('an expired one-shot is skipped instead of refiring', async () => {
  const old = task({ kind: 'at', at: new Date(Date.now() - 60_000).toISOString() });
  const f = fixture({ tasks: [old] });
  const outcome = await run(f);
  assert.equal(outcome.skipped[0].reason, 'expired');
  assert.equal(f.calls.created.length, 0);
});

test('a future one-shot is migrated as an absolute time', async () => {
  const when = new Date(Date.now() + 7200_000).toISOString();
  const f = fixture({ tasks: [task({ kind: 'at', at: when })] });
  const outcome = await run(f);
  assert.equal(outcome.migrated.length, 1);
  assert.equal(f.calls.created[0].input.at, when);
});

test('a task about to fire blocks the switch with no side effects', async () => {
  const f = fixture({ tasks: [task({ scheduledAt: new Date(Date.now() + 30_000).toISOString() })] });
  await assert.rejects(run(f), { code: 'imminent-trigger' });
  assert.equal(f.calls.created.length, 0);
  assert.equal(f.archived.length, 0);
  assert.equal(f.store.db.prepare('SELECT session_id FROM bindings').get().session_id, previous);
});

test('a live agent or a pending question blocks the switch', async () => {
  const busy = fixture({ tasks: [task()], agentStatus: 'running' });
  await assert.rejects(run(busy), { code: 'session-busy' });
  assert.equal(busy.calls.created.length, 0);

  const asking = fixture({ tasks: [task()] });
  asking.core.bridge.interactions.pending.set('p1', { req: { agent: { session: { id: previous } } } });
  await assert.rejects(run(asking), { code: 'awaiting-answer' });
  assert.equal(asking.calls.created.length, 0);
});

test('an unconfirmed inbound message blocks the switch', async () => {
  const f = fixture({ tasks: [task()] });
  f.store.db.prepare('INSERT INTO receipts VALUES(?,?,?,?,?,?,?)')
    .run('k1', 'r1', previous, 'd', 'received', '{}', Date.now());
  await assert.rejects(run(f), { code: 'pending-input' });
});

test('a failed create keeps the old task and reports it', async () => {
  const f = fixture({ tasks: [task()], failCreate: true });
  const outcome = await run(f);
  assert.equal(outcome.migrated.length, 0);
  assert.equal(outcome.failed.length, 1);
  assert.equal(outcome.failed[0].code, 'create-failed');
  assert.equal(f.calls.deleted.length, 0, 'old task must survive a failed create');
  assert.equal(f.live.length, 1);
});

test('an uncertain create stops the migration and keeps the old task', async () => {
  const f = fixture({ tasks: [task()], uncertainCreate: true });
  await assert.rejects(run(f), { code: 'migration-uncertain' });
  assert.equal(f.calls.deleted.length, 0);
  assert.equal(f.live.length, 1);
  assert.equal(f.store.db.prepare('SELECT session_id FROM bindings').get().session_id, previous, 'binding must not switch');
});

test('a failed delete is reported as duplicate risk, not silently retried', async () => {
  const f = fixture({ tasks: [task()], failDelete: true });
  const outcome = await run(f);
  assert.equal(outcome.migrated.length, 0);
  assert.equal(outcome.failed[0].duplicateRisk, true);
  assert.equal(f.live.length, 2, 'both copies exist and are reported');
});

test('a binding change during migration aborts before switching traffic', async () => {
  const f = fixture({ tasks: [task()] });
  const second = 'route-key-second';
  f.core.ctx.get = () => undefined; // not used below
  f.store.putBinding(second, { provider: 'feishu', accountId: 'bot', conversationId: 'chat-approved', kind: 'group', sessionId: previous, scope });
  const conflict = fixture({ tasks: [task()], changeBindingsDuringCreate: () => {
    conflict.store.putBinding('route-key-moved', { provider: 'feishu', accountId: 'bot', conversationId: 'chat-approved', kind: 'group', sessionId: previous, scope });
  } });
  await assert.rejects(run(conflict), { code: 'binding-changed' });
  assert.equal(conflict.store.db.prepare('SELECT session_id FROM bindings').get().session_id, previous);
});

test('an archive refusal still switches and is reported', async () => {
  const f = fixture({ tasks: [task()], archiveThrows: true });
  const outcome = await run(f);
  assert.equal(outcome.archived.ok, false);
  assert.equal(outcome.archived.code, 'WorkspaceActiveSessionError');
  assert.equal(f.store.db.prepare('SELECT session_id FROM bindings').get().session_id, next);
});

test('a session with no tasks still rebinds and archives', async () => {
  const f = fixture({ tasks: [] });
  const outcome = await run(f);
  assert.equal(outcome.migrated.length, 0);
  assert.equal(outcome.archived.ok, true);
  assert.equal(f.store.db.prepare('SELECT session_id FROM bindings').get().session_id, next);
});

test('field mapping covers every reproducible kind', () => {
  assert.deepEqual(toCreateInput({ kind: 'cron', title: 't', prompt: 'p', expression: '0 5 * * 1', timeZone: 'Asia/Shanghai' }),
    { title: 't', prompt: 'p', cron: { expression: '0 5 * * 1', time_zone: 'Asia/Shanghai' } });
  assert.deepEqual(toCreateInput({ kind: 'daily', title: 't', prompt: 'p', time: '00:15:00', timeZone: 'Asia/Shanghai' }),
    { title: 't', prompt: 'p', daily: { time: '00:15:00', time_zone: 'Asia/Shanghai' } });
  assert.deepEqual(toCreateInput({ kind: 'weekly', title: 't', prompt: 'p', time: '04:30:00', timeZone: 'Asia/Shanghai', weekdays: [1] }),
    { title: 't', prompt: 'p', weekly: { time: '04:30:00', time_zone: 'Asia/Shanghai', weekdays: [1] } });
  assert.deepEqual(toCreateInput({ kind: 'every', title: 't', prompt: 'p', everySeconds: 3600 }),
    { title: 't', prompt: 'p', every_seconds: 3600 });
  assert.equal(toCreateInput({ kind: 'weird', title: 't', prompt: 'p' }), null);
  assert.equal(isExpiredOneShot({ kind: 'cron' }), false);
  assert.equal(isExpiredOneShot({ kind: 'at', at: '2000-01-01T00:00:00Z' }), true);
});
