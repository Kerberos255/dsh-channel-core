import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CoreStore } from '../lib/store.js';
import { SessionRotation } from '../lib/rotation.js';

const MIB = 1024 * 1024;
const scope = { workspaceId: 'w', presetId: 'agent', memoryNamespace: 'private', scheduleNamespace: 'private', identityId: 'i' };

/** Build a home directory containing one workspace with the given sessions. */
function workspace(sessions) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rot-'));
  const folder = path.join(home, 'sessions', '--ws--');
  for (const entry of sessions) {
    const dir = path.join(folder, entry.id);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'session.v4.jsonl.zstd');
    fs.writeFileSync(file, Buffer.alloc(entry.bytes ?? Math.round(1.2 * MIB)));
    if (entry.ageMinutes) {
      const when = new Date(Date.now() - entry.ageMinutes * 60_000);
      fs.utimesSync(file, when, when);
    }
  }
  return home;
}

function fixture({ sessions = [], config = {}, tasks = [], bindings = [], ownerDm = false, archiveThrows = false } = {}) {
  const home = workspace(sessions);
  const store = new CoreStore(':memory:');
  const archived = [];
  const created = [];
  const live = [...tasks];
  const schedule = {
    async catalog() { return live.map(row => ({ ...row })); },
    async create(sessionId, input) {
      const row = { id: 'schedule-' + randomUUID().slice(0, 8), sessionId, status: 'active', title: input.title, kind: 'cron', expression: input.cron?.expression, scheduledAt: new Date(Date.now() + 3600_000).toISOString() };
      live.push(row); return row;
    },
    async delete({ sessionId, id }) { const i = live.findIndex(r => r.id === id && r.sessionId === sessionId); if (i >= 0) live.splice(i, 1); },
  };
  const ctx = {
    dshHomePath: (...parts) => path.join(home, ...parts),
    get(name) {
      if (name === 'schedule') return schedule;
      if (name === 'workspaceRegistry') return { async archiveSession(id) { if (archiveThrows) throw Object.assign(new Error('busy'), { name: 'WorkspaceActiveSessionError' }); archived.push(id); } };
      if (name === 'agents') return { get: () => undefined };
      if (name === 'sessionQuery') return { observeSession: () => ({ header: { cwd: home, agentPreset: 'agent' }, [Symbol.dispose]() {} }) };
      if (name === 'pluginDiagnostics') return { record() {} };
      return undefined;
    },
  };
  const core = {
    ctx, store, closed: false, commandTasks: new Map(),
    controller: { async create(request) { created.push(request); } },
    configFile: { value: { rotationMode: 'auto', rotationFileMiB: 1, rotationIdleMinutes: 10, rotationScanMinutes: 10, rotationExcludeOwnerDm: true, ...config } },
    sendToBoundSession: async () => ({ state: 'sent' }),
    bridge: { interactions: { pending: new Map() } },
  };
  for (const binding of bindings) {
    store.putBinding(binding.key, { provider: 'feishu', accountId: 'bot', conversationId: binding.conversationId ?? 'chat-1', kind: binding.kind ?? 'group', sessionId: binding.sessionId, scope });
  }
  return { core, store, archived, created, live, home };
}

const aged = (id, extra = {}) => ({ id, bytes: Math.round(1.2 * MIB), ageMinutes: 600, ...extra });

test('rotation ignores logs below the threshold', async () => {
  const f = fixture({ sessions: [{ id: 'session-small', bytes: 1000 }] });
  const rotation = new SessionRotation(f.core);
  assert.equal(rotation.scan().length, 0);
  await rotation.tick();
  assert.equal(f.archived.length, 0);
});

test('a channel session with active tasks migrates them and archives', async () => {
  const sessionId = 'session-channel';
  const f = fixture({
    sessions: [aged(sessionId)],
    bindings: [{ key: 'route-1', sessionId }],
    tasks: [{ id: 'schedule-a', sessionId, status: 'active', kind: 'cron', title: '日报', prompt: 'p', expression: '0 9 * * 1-5', scheduledAt: new Date(Date.now() + 3600_000).toISOString() }],
  });
  const rotation = new SessionRotation(f.core);
  await rotation.tick();
  assert.equal(f.archived.length, 1);
  assert.equal(f.archived[0], sessionId);
  assert.equal(f.live.filter(r => r.sessionId === sessionId).length, 0);
  assert.equal(f.live.filter(r => r.sessionId !== sessionId).length, 1);
  assert.equal(f.created.length, 1);
});

test('a fresh log is skipped until the idle window passes', async () => {
  const sessionId = 'session-fresh';
  const f = fixture({ sessions: [{ id: sessionId, bytes: Math.round(1.2 * MIB) }], bindings: [{ key: 'route-1', sessionId }] });
  const rotation = new SessionRotation(f.core);
  await rotation.tick();
  assert.equal(f.archived.length, 0);
});

test('an owner DM is left to LCM', async () => {
  const sessionId = 'session-dm';
  const f = fixture({ sessions: [aged(sessionId)], bindings: [{ key: 'route-dm', sessionId, kind: 'dm' }] });
  const rotation = new SessionRotation(f.core);
  const entry = rotation.scan().find(row => row.sessionId === sessionId);
  assert.equal(rotation.isOwnerDm(rotation.bindingsOf(sessionId)), true);
  await rotation.tick();
  assert.equal(f.archived.length, 0, 'LCM owns owner DMs');
  assert(entry);
});

test('a session without bindings is archived without switching', async () => {
  const sessionId = 'session-web';
  const f = fixture({ sessions: [aged(sessionId)] });
  const rotation = new SessionRotation(f.core);
  await rotation.tick();
  assert.deepEqual(f.archived, [sessionId]);
  assert.equal(f.created.length, 1, 'a successor session is created for the next launch');
});

test('rotationMode off does nothing', async () => {
  const sessionId = 'session-off';
  const f = fixture({ sessions: [aged(sessionId)], config: { rotationMode: 'off' } });
  const rotation = new SessionRotation(f.core);
  await rotation.tick();
  assert.equal(f.archived.length, 0);
  assert.equal(f.created.length, 0);
});

test('a failure cools the session down instead of retrying every pass', async () => {
  const sessionId = 'session-fail';
  const f = fixture({ sessions: [aged(sessionId)], archiveThrows: true });
  const rotation = new SessionRotation(f.core);
  await rotation.tick();
  assert(rotation.cooldown.has(sessionId), 'failed session enters a cooldown window');
  assert(f.core.store.db.prepare('SELECT COUNT(*) AS c FROM audit WHERE kind=?').get('session-rotation').c >= 1, 'failure is audited');
  const before = f.created.length;
  await rotation.tick();
  assert.equal(f.created.length, before, 'second pass must not retry during cooldown');
});

test('an archive refusal is reported without losing the new session', async () => {
  const sessionId = 'session-archive-refused';
  const f = fixture({ sessions: [aged(sessionId)], archiveThrows: true });
  const rotation = new SessionRotation(f.core);
  const entry = rotation.scan().find(row => row.sessionId === sessionId);
  await rotation.rotate(entry);
  assert.equal(f.created.length, 1);
});
