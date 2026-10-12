import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelRuntime } from '../lib/channel-runtime.js';

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
