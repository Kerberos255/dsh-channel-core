import test from 'node:test';
import assert from 'node:assert/strict';
import ChannelCore from '../lib/index.js';

/** Minimal stand-in for the channel settings service the command talks to. */
function settingsFor(narration) {
  let state = { value: { schemaVersion: 1, streaming: { mode: 'progress', progress: { narration } } }, revision: 'rev-1' };
  return {
    getConfig: () => ({ ...state, details: null }),
    setConfig(next, revision) {
      if (revision !== state.revision) throw new Error('config-conflict');
      state = { value: next, revision: 'rev-2' };
    },
    read: () => state.value,
  };
}

const call = (service, origin, args) => ChannelCore.prototype.reasonCommand.call(
  { coreCtx: { get: name => (name === 'discordChannelSettings' ? service : undefined) } },
  origin, args,
);

test('/reason reports the current state without arguments', () => {
  const settings = settingsFor(false);
  assert.match(call(settings, { provider: 'discord' }, ''), /思考显示：关/);
  assert.match(call(settings, { provider: 'discord' }, ''), /\/reason on/);
});

test('/reason on enables narration in the same setting the plugin page owns', () => {
  const settings = settingsFor(false);
  const text = call(settings, { provider: 'discord' }, 'on');
  assert.match(text, /已开启思考显示/);
  assert.equal(settings.read().streaming.progress.narration, true);
});

test('/reason off disables it again', () => {
  const settings = settingsFor(true);
  call(settings, { provider: 'discord' }, 'off');
  assert.equal(settings.read().streaming.progress.narration, false);
});

test('/reason keeps unrelated settings untouched', () => {
  const settings = settingsFor(false);
  call(settings, { provider: 'discord' }, 'on');
  const value = settings.read();
  assert.equal(value.streaming.mode, 'progress');
  assert.equal(value.schemaVersion, 1);
});

test('/reason rejects an unknown argument without writing', () => {
  const settings = settingsFor(false);
  const text = call(settings, { provider: 'discord' }, 'maybe');
  assert.match(text, /参数无效/);
  assert.equal(settings.read().streaming.progress.narration, false);
});

test('/reason is a no-op when the value already matches', () => {
  const settings = settingsFor(true);
  const text = call(settings, { provider: 'discord' }, '开');
  assert.match(text, /已经是开状态/);
});

test('/reason reports a channel that exposes no settings service', () => {
  const text = ChannelCore.prototype.reasonCommand.call({ coreCtx: { get: () => undefined } }, { provider: 'feishu' }, '');
  assert.match(text, /不支持这个开关/);
});
