import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskNotifications } from '../lib/task-notifications.js';

function fixture() {
  const settings = { taskNotifications: false, notificationChannel: 'none' };
  const configs = {
    feishu: { enabled: true, accountId: 'main', appId: 'configured', dmPolicy: 'all' },
    discord: { enabled: false, accountId: 'main' },
  };
  let rows = [{ id: 'binding-one', session_id: 'session-old', data: JSON.stringify({
    provider: 'feishu', accountId: 'main', kind: 'dm', userId: 'owner',
  }) }];
  const sent = [];
  const core = {
    configFile: { value: settings },
    ctx: { get(name) { return configs[name.replace('ChannelSettings','')] ?
      { configFile: { value: configs[name.replace('ChannelSettings','')] } } : null; } },
    store: {
      owner(provider, accountId) { return provider === 'feishu' && accountId === 'main' ? { userId: 'owner' } : null; },
      db: { prepare() { return { all() { return rows; } }; } },
    },
    outboundTargets(sessionId) { return rows.filter(row => row.session_id === sessionId).map(row =>
      ({ bindingId: row.id, provider: JSON.parse(row.data).provider, kind: JSON.parse(row.data).kind })); },
    sendToBoundSession(request) { sent.push(request); return Promise.resolve({ state: 'sent' }); },
  };
  return { core, settings, configs, sent, setRows(next) { rows = next; } };
}
const alert = { source: 'dsh-memory-dreaming', id: 'abc123', kind: 'daily', state: 'failed', origin: 'scheduled' };

test('disabled task alerts do not dispatch, and only enabled configured channels are offered', async () => {
  const f = fixture(), adapter = new TaskNotifications(f.core);
  assert.deepEqual(adapter.channels(), [{ id: 'feishu', label: '飞书' }]);
  assert.equal((await adapter.notify(alert)).state, 'disabled');
  assert.equal(f.sent.length, 0);
  f.configs.feishu.enabled = false;
  assert.deepEqual(adapter.channels(), []);
});
test('a scheduled memory failure reaches the owner DM only, without pinning a session', async () => {
  const f = fixture(), adapter = new TaskNotifications(f.core);
  f.settings.taskNotifications = true; f.settings.notificationChannel = 'feishu';
  assert.equal((await adapter.notify(alert)).state, 'sent');
  assert.equal(f.sent[0].sessionId, 'session-old');
  assert.equal(f.sent[0].bindingId, 'binding-one');
  assert.match(f.sent[0].text, /每日记忆/);
  assert.equal(f.sent[0].text.includes('abc123'), false);
  f.setRows([{ id: 'binding-one', session_id: 'session-new', data: JSON.stringify({
    provider: 'feishu', accountId: 'main', kind: 'dm', userId: 'owner',
  }) }]);
  assert.equal((await adapter.notify({...alert,id:'next'})).state, 'sent');
  assert.equal(f.sent[1].sessionId, 'session-new');
  assert.equal(f.sent[0].idempotencyKey !== f.sent[1].idempotencyKey, true);
});
test('missing owner, ambiguous routes, disabled provider and forged/manual events never send', async () => {
  const f = fixture(), adapter = new TaskNotifications(f.core);
  f.settings.taskNotifications = true; f.settings.notificationChannel = 'feishu';
  assert.equal((await adapter.notify({...alert,origin:'manual'})).state, 'ignored');
  assert.equal((await adapter.notify({...alert,state:'completed'})).state, 'ignored');
  assert.equal((await adapter.notify({...alert,id:'../../etc'})).state, 'ignored');
  f.setRows([]);
  assert.equal((await adapter.notify(alert)).state, 'no-owner-target');
  f.setRows([1,2].map(n => ({ id: 'binding-'+n, session_id: 'session-'+n, data: JSON.stringify({
    provider: 'feishu', accountId: 'main', kind: 'dm', userId: 'owner',
  }) })));
  assert.equal((await adapter.notify(alert)).state, 'no-owner-target');
  f.configs.feishu.enabled = false;
  assert.equal((await adapter.notify(alert)).state, 'unavailable');
  assert.equal(f.sent.length, 0);
});
