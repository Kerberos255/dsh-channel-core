import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelRuntime, connectionSettingsChanged, groupAllowlistFor, shouldCollectGroup } from '../lib/channel-runtime.js';

function runtimeWith(groups) {
  const saves = [], events = [];
  const runtime = Object.create(ChannelRuntime.prototype);
  runtime.settings = { configFile: {
    snapshot: () => ({ value: { allowedGroups: [...groups] }, revision: 'rev-1' }),
    save: (value, revision) => { saves.push({ value, revision }); },
  } };
  runtime.diagnostic = (level, event, detail) => events.push({ level, event, detail });
  return { runtime, saves, events };
}

test('a newly seen group is appended to allowedGroups and saved with the current revision', () => {
  const { runtime, saves, events } = runtimeWith(['oc_known']);
  const groups = runtime.collectGroup(['oc_known'], 'oc_new');
  assert.deepEqual(groups, ['oc_known', 'oc_new']);
  assert.equal(saves.length, 1);
  assert.deepEqual(saves[0].value.allowedGroups, ['oc_known', 'oc_new']);
  assert.equal(saves[0].revision, 'rev-1', 'save must pass the revision it read');
  assert.equal(events[0].event, 'channel.group-collected');
});

test('an already known group is left untouched and never saved twice', () => {
  const { runtime, saves } = runtimeWith(['oc_known']);
  const groups = runtime.collectGroup(['oc_known'], 'oc_known');
  assert.deepEqual(groups, ['oc_known']);
  assert.equal(saves.length, 0);
});

test('a conflicting write fails closed and reports a diagnostic instead of throwing', () => {
  const { runtime, events } = runtimeWith([]);
  runtime.settings.configFile.save = () => {
    const error = new Error('config-conflict');
    error.code = 'config-conflict';
    throw error;
  };
  const groups = runtime.collectGroup([], 'oc_new');
  assert.equal(groups, null, 'caller keeps the old config when the write fails');
  assert.equal(events.length, 1);
  assert.equal(events[0].level, 'warn');
  assert.equal(events[0].event, 'channel.group-collect-failed');
  assert.equal(events[0].detail.code, 'config-conflict');
});

test('other settings survive the rewrite unchanged', () => {
  const { runtime, saves } = runtimeWith(['oc_known']);
  runtime.settings.configFile.snapshot = () => ({
    value: { allowedGroups: ['oc_known'], requireMention: true, throttleMs: 750, enabled: true },
    revision: 'rev-2',
  });
  runtime.collectGroup([], 'oc_new');
  assert.deepEqual(saves[0].value, {
    allowedGroups: ['oc_known', 'oc_new'], requireMention: true, throttleMs: 750, enabled: true,
  });
});

function groupConfig(overrides = {}) {
  return {
    allowGroups: true, autoCollectGroups: true, allowedUsers: ['ou_owner'], allowedGroups: ['oc_known'],
    ...overrides,
  };
}
function groupMessage(userId, conversationId) {
  return { kind: 'group', userId, conversationId };
}

test('only an allowed user speaking in a new group triggers collection', () => {
  assert.equal(shouldCollectGroup(groupMessage('ou_owner', 'oc_new'), groupConfig()), true);
});

test('a stranger speaking in a new group never widens the allowlist', () => {
  assert.equal(shouldCollectGroup(groupMessage('ou_stranger', 'oc_new'), groupConfig()), false);
});

test('collection stays off when groups are disabled or auto-collection is off', () => {
  assert.equal(shouldCollectGroup(groupMessage('ou_owner', 'oc_new'), groupConfig({ allowGroups: false })), false);
  assert.equal(shouldCollectGroup(groupMessage('ou_owner', 'oc_new'), groupConfig({ autoCollectGroups: false })), false);
});

test('a known group and direct messages are never collected', () => {
  assert.equal(shouldCollectGroup(groupMessage('ou_owner', 'oc_known'), groupConfig()), false);
  assert.equal(shouldCollectGroup({ kind: 'dm', userId: 'ou_owner', conversationId: 'oc_new' }, groupConfig()), false);
});

test('the SDK allowlist is emptied exactly while auto-collection owns admission', () => {
  assert.deepEqual(groupAllowlistFor(groupConfig()), [], 'auto-collection must reach the runtime gate');
  assert.deepEqual(groupAllowlistFor(groupConfig({ autoCollectGroups: false })), ['oc_known'],
    'a manual allowlist still filters inside the SDK');
  assert.deepEqual(groupAllowlistFor(groupConfig({ allowGroups: false })), []);
});

test('collecting a group is receive scope and must not rebuild the connection', () => {
  const before = groupConfig();
  assert.equal(connectionSettingsChanged(before, { ...before, allowedGroups: ['oc_known', 'oc_new'] }), false,
    'reconnecting here aborts the message that discovered the group');
});

test('every other settings change still rebuilds the connection', () => {
  const before = groupConfig();
  assert.equal(connectionSettingsChanged(null, before), true, 'the first configuration always connects');
  assert.equal(connectionSettingsChanged(before, { ...before, requireMention: true }), true);
  assert.equal(connectionSettingsChanged(before, { ...before, autoCollectGroups: false }), true,
    'auto-collection changes which allowlist the SDK receives');
  assert.equal(connectionSettingsChanged(before, { ...before, streaming: { mode: 'card' } }), true);
  assert.equal(connectionSettingsChanged({ allowedGroups: ['oc_known'] }, { allowedGroups: ['oc_known', 'oc_new'] }), true,
    'a manual allowlist without auto-collection cannot self-heal, so it reconnects');
});

function feishuFixture(extra = {}) {
  const config = {
    enabled: true, accountId: 'default', appId: 'cli_fixture', allowGroups: true, autoCollectGroups: true,
    allowedUsers: ['ou_owner'], allowedGroups: ['oc_known'], requireMention: false, agentPreset: 'agent',
    memoryNamespace: 'private', inputMode: 'inherit', workspacePath: '', identityLinks: [], ...extra,
  };
  const subscribers = new Set(), calls = [];
  const configFile = {
    value: config, revision: 'rev-1',
    subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn); },
    snapshot() { return { value: this.value, revision: this.revision }; },
    save(next) { this.value = next; for (const fn of subscribers) fn(); },
  };
  const ctx = {
    credentials: { async resolve() { return { value: 'fixture' }; } },
    channelCore: {
      networkReady: Promise.resolve(),
      store: { claimOwner() {}, setOwner() {}, syncAliases() {} },
      bridge: { register() { return () => {}; } },
      resolveSessionWorkspace: async (runtimeConfig, signal) => {
        signal?.throwIfAborted();
        return { cwd: 'E:\\fixture-workspace', agentPreset: runtimeConfig.agentPreset };
      },
      receive: async (message) => { calls.push(message); return { accepted: true }; },
    },
    on() { return () => {}; },
  };
  let transportArgs;
  const runtime = new ChannelRuntime(ctx, { configFile }, {
    provider: 'feishu',
    credentialRefs: () => ['FEISHU_APP_SECRET'],
    createTransport: async (args) => {
      transportArgs = args;
      return { start: async () => {}, close: async () => {}, details: () => ({}) };
    },
  });
  return { runtime, configFile, calls, get transportArgs() { return transportArgs; } };
}

test('the owner speaking in a new group is collected and the same message is still processed', async () => {
  const f = feishuFixture();
  try {
    await f.runtime.reconfigure();
    const result = await f.transportArgs.receive({
      kind: 'group', userId: 'ou_owner', conversationId: 'oc_new', text: 'hello', resources: [], mentionedBot: false,
    });
    assert.deepEqual(result, { accepted: true });
    assert.equal(f.calls.length, 1, 'the discovering message must reach the core');
    assert.deepEqual(f.configFile.value.allowedGroups, ['oc_known', 'oc_new']);
  } finally { await f.runtime.close(); }
});

test('a stranger in a new group is neither collected nor processed', async () => {
  const f = feishuFixture();
  try {
    await f.runtime.reconfigure();
    const result = await f.transportArgs.receive({
      kind: 'group', userId: 'ou_stranger', conversationId: 'oc_new', text: 'hello', resources: [], mentionedBot: false,
    });
    assert.deepEqual(result, { ignored: true });
    assert.equal(f.calls.length, 0);
    assert.deepEqual(f.configFile.value.allowedGroups, ['oc_known']);
  } finally { await f.runtime.close(); }
});
