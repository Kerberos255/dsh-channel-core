import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelRecovery } from '../../../lib/channel-recovery.js';
import { createTransport } from '../transport.js';
import { schema } from '../config.js';

function transportFixture({ failLogin = false, initialState = 'connecting' } = {}) {
  const listeners = new Map(), options = [];
  let sdkState = initialState, closedForce = 0, disconnects = 0, logins = 0;
  const channel = {
    connected: false,
    on(name, fn) { listeners.set(name, fn); return () => listeners.delete(name); },
    getConnectionStatus() { return { state: sdkState, reconnectAttempts: 0 }; },
    rawWsClient: { close({ force } = {}) { if (force) closedForce++; } },
    async connect() {
      logins++;
      if (failLogin && logins === 1) {
        sdkState = 'failed';
        throw Object.assign(new Error('transient-feishu-connection'), { code: 'not_connected' });
      }
      sdkState = 'connected';
      channel.connected = true;
    },
    async disconnect() { disconnects++; if (channel.connected) { channel.connected = false; sdkState = 'idle'; } },
  };
  const sdk = {
    Domain: { Feishu: 'feishu', Lark: 'lark' },
    createLarkChannel(opts) { options.push(opts); return channel; },
  };
  const abort = new AbortController();
  async function create() {
    return createTransport({
      config: schema.validate({ enabled: true, appId: 'cli_fixture', allowedUsers: [], allowedGroups: [] }),
      credentials: ['fixture-only'], signal: abort.signal, receive: async () => {}, state: () => {},
      action: async () => {},
    }, sdk);
  }
  return {
    create, channel, listeners, options, abort,
    get state() { return sdkState; },
    set state(value) { sdkState = value; },
    get closedForce() { return closedForce; },
    get disconnects() { return disconnects; },
    get logins() { return logins; },
  };
}

test('Feishu enables the SDK ping watchdog and bases health on the live socket, not silence', async () => {
  const f = transportFixture();
  const t = await f.create();
  try {
    assert.equal(f.options[0].wsConfig.pingTimeout, 60);
    assert.equal(f.options[0].handshakeTimeoutMs, 15000);
    assert.equal(t.health().ready, false);
    await t.start();
    assert.equal(t.health().ready, true);
    f.state = 'reconnecting';
    assert.deepEqual({ ready: t.health().ready, recovering: t.health().recovering }, { ready: false, recovering: true });
    f.state = 'connected';
    assert.equal(t.health().ready, true);
    f.state = 'failed';
    assert.equal(t.health().code, 'feishu-sdk-failed');
  } finally { await t.close(); }
  assert.equal(f.closedForce, 0);
});

test('failed first Feishu WS handshake closes the orphaned SDK client, preventing duplicate reconnect loops', async () => {
  const f = transportFixture({ failLogin: true });
  const t = await f.create();
  try {
    await assert.rejects(t.start(), { code: 'not_connected' });
    assert.equal(t.health().ready, false);
  } finally { await t.close(); }
  assert.equal(f.closedForce, 1);
  assert.equal(f.disconnects, 1);
});

function recoveryFixture() {
  let now = 1_000_000, attempts = 0;
  let state = 'connected';
  const r = {
    provider: 'feishu', closed: false, connecting: false, ready: true, activeInbound: 0,
    settings: { configFile: { value: { enabled: true, accountId: 'fixture' } } },
    diagnostic() {},
    transport: { health: () => ({
      ready: state === 'connected',
      recovering: state === 'reconnecting' || state === 'connecting',
      terminal: false,
    }) },
    async reconfigure({ recovery } = {}) { assert.equal(recovery, true); attempts++; this.ready = true; state = 'connected'; },
  };
  const supervisor = new ChannelRecovery(r, {
    now: () => now, every: () => ({ unref() {} }), clear: () => {}, sdkGraceMs: 120_000,
  });
  return {
    r, supervisor, get attempts() { return attempts; },
    set state(value) { state = value; },
    advance(ms) { now += ms; },
  };
}

test('Feishu SDK self-reconnect takes priority and avoids unnecessary channel replacement', async () => {
  const f = recoveryFixture();
  f.state = 'reconnecting';
  await f.supervisor.poll();
  f.advance(119_000);
  assert.equal(await f.supervisor.poll(), false);
  f.state = 'connected';
  f.advance(2_000);
  assert.equal(await f.supervisor.poll(), false);
  assert.equal(f.attempts, 0);
  f.supervisor.stop();
});

test('Feishu persistent disconnect is replaced once after SDK grace, without replacing other channels', async () => {
  const f = recoveryFixture();
  f.state = 'idle';
  f.r.ready = false;
  await f.supervisor.poll();
  f.advance(121_000);
  assert.equal(await f.supervisor.poll(), true);
  assert.equal(f.attempts, 1);
  assert.equal(f.r.ready, true);
  f.supervisor.stop();
});

test('Feishu auto-recovery waits for ongoing inbound messages and obeys manual disable', async () => {
  const f = recoveryFixture();
  f.state = 'failed';
  f.r.ready = false;
  await f.supervisor.poll();
  f.advance(121_000);
  f.r.activeInbound = 1;
  assert.equal(await f.supervisor.poll(), false);
  f.r.activeInbound = 0;
  f.r.settings.configFile.value.enabled = false;
  assert.equal(await f.supervisor.poll(), false);
  assert.equal(f.attempts, 0);
  f.supervisor.stop();
});
