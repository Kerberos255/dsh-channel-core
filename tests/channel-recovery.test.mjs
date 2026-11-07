import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelRecovery } from '../lib/channel-recovery.js';

function twoChannels() {
  let time = 5_000_000;
  const events = [];
  const source = new Map();
  const bridge = {
    turns: new Map(),
    adapters: new Map(),
    outputOrigins(sessionId) { return source.get(sessionId) ?? []; },
  };
  let networkRefreshes = 0, refreshFlight;
  const core = {
    bridge,
    async readyRuntimeNetwork({ refresh } = {}) {
      if (!refresh) return;
      if (!refreshFlight) {
        networkRefreshes++;
        refreshFlight = new Promise(resolve => setImmediate(resolve)).finally(() => { refreshFlight = null; });
      }
      await refreshFlight;
    },
  };
  function channel(provider) {
    let attempts = 0, healthy = false;
    const runtime = {
      provider, core, ready: false, closed: false, connecting: false, activeInbound: 0,
      settings: { configFile: { value: { enabled: true, accountId: 'default' } } },
      diagnostic(level,event) { events.push({ provider, level, event }); },
      transport: null,
      async reconfigure({ recovery } = {}) {
        assert.equal(recovery,true);
        await core.readyRuntimeNetwork({ refresh:true });
        attempts++;
        healthy = true;
        this.ready = true;
        this.transport = { health: () => ({ ready: healthy }) };
      },
    };
    const watcher = new ChannelRecovery(runtime, {
      now: () => time, every: () => ({ unref() {} }), clear: () => {}, random: () => 0.5,
    });
    return {
      runtime, watcher,
      get attempts() { return attempts; },
      set healthy(value) { healthy = value; },
    };
  }
  const discord = channel('discord'), feishu = channel('feishu');
  return {
    discord, feishu, bridge, source, events,
    get networkRefreshes() { return networkRefreshes; },
    advance(ms) { time += ms; },
    close() { discord.watcher.stop(); feishu.watcher.stop(); },
  };
}

test('shared network owner is refreshed once when both disconnected channels recover together', async () => {
  const h = twoChannels();
  try {
    h.discord.watcher.noteFailure({ code:'ETIMEDOUT' });
    h.feishu.watcher.noteFailure({ code:'not_connected' });
    h.advance(16_000);
    assert.deepEqual(await Promise.all([h.discord.watcher.poll(),h.feishu.watcher.poll()]),[true,true]);
    assert.equal(h.networkRefreshes,1);
    assert.equal(h.discord.attempts,1);
    assert.equal(h.feishu.attempts,1);
    assert.equal(h.discord.watcher.failures,0);
    assert.equal(h.feishu.watcher.failures,0);
  } finally { h.close(); }
});

test('parallel polls for the same account never start duplicate channel instances', async () => {
  const h = twoChannels();
  try {
    h.feishu.watcher.noteFailure({ code:'ETIMEDOUT' });
    h.advance(16_000);
    const calls = await Promise.all([h.feishu.watcher.poll(),h.feishu.watcher.poll(),h.feishu.watcher.poll()]);
    assert.equal(calls.filter(Boolean).length,1);
    assert.equal(h.feishu.attempts,1);
  } finally { h.close(); }
});

test('an active Feishu delivery does not stop a disconnected Discord account from recovering', async () => {
  const h = twoChannels();
  try {
    h.discord.watcher.noteFailure({ code:'ECONNRESET' });
    h.feishu.watcher.noteFailure({ code:'ECONNRESET' });
    h.bridge.turns.set('turn', { sessionId:'running',turn:1,terminal:false });
    h.source.set('running', [{provider:'feishu',accountId:'default'}]);
    h.advance(16_000);
    assert.equal(await h.feishu.watcher.poll(),false);
    assert.equal(await h.discord.watcher.poll(),true);
    assert.equal(h.feishu.attempts,0);
    assert.equal(h.discord.attempts,1);
    h.bridge.turns.clear();
    assert.equal(await h.feishu.watcher.poll(),true);
  } finally { h.close(); }
});

test('disabled Feishu and stopped Discord cannot be restarted by scheduled recovery', async () => {
  const h = twoChannels();
  try {
    h.feishu.watcher.noteFailure({ code:'not_connected' });
    h.discord.watcher.noteFailure({ code:'ETIMEDOUT' });
    h.feishu.runtime.settings.configFile.value.enabled = false;
    h.discord.runtime.closed = true;
    h.advance(16_000);
    assert.equal(await h.feishu.watcher.poll(),false);
    assert.equal(await h.discord.watcher.poll(),false);
    assert.equal(h.feishu.attempts+h.discord.attempts,0);
  } finally { h.close(); }
});
