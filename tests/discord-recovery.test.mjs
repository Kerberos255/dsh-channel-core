import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DiscordRecovery, recoveryFailure, RECOVERY_MAX_PER_HOUR } from '../lib/discord-recovery.js';
import { awaitDiscordStartup } from '../lib/discord-startup.js';

function fixture() {
  let time = 1_000_000, invokes = 0, interval;
  const r = {
    closed: false, provider: 'discord', ready: false, connecting: false, activeInbound: 0, transport: null,
    settings: { configFile: { value: { enabled: true, accountId: 'fixture' } } },
    diagnostic() {},
    async reconfigure() { invokes++; },
  };
  const recovery = new DiscordRecovery(r, {
    now: () => time, every: cb => { interval = cb; return { unref() {} }; },
    clear: () => {}, random: () => 0.5, sdkGraceMs: 120_000,
  });
  return { r, recovery, get invokes() { return invokes; }, advance(ms) { time += ms; }, tick() { return interval(); } };
}
test('initial network failure retries, then clears backoff when Discord recovers', async () => {
  const f = fixture();
  f.recovery.noteFailure({ code: 'ECONNREFUSED' });
  assert.equal(await f.recovery.poll(), false);
  f.advance(15_000);
  assert.equal(await f.recovery.poll(), true);
  assert.equal(f.invokes, 1);
  f.r.ready = true; f.r.transport = { health: () => ({ ready: true }) };
  await f.recovery.poll();
  assert.equal(f.recovery.failures, 0);
  assert.equal(f.recovery.nextAt, 0);
  f.recovery.stop();
});
test('SDK gets two minutes to RESUME; successful RESUME avoids a redundant login', async () => {
  const f = fixture();
  let sdkReady = false;
  f.r.transport = { health: () => ({ ready: sdkReady, recovering: !sdkReady, terminal: false }) };
  assert.equal(await f.recovery.poll(), false);
  f.advance(119_999); assert.equal(await f.recovery.poll(), false);
  sdkReady = true; f.r.ready = true;
  f.advance(5);
  assert.equal(await f.recovery.poll(), false);
  assert.equal(f.invokes, 0);
  f.recovery.stop();
});
test('dead gateway is replaced after grace, never while a receive or final delivery is active', async () => {
  const f = fixture();
  f.r.transport = { health: () => ({ ready: false, terminal: false, code: null }) };
  await f.recovery.poll();
  f.advance(121_000);
  f.r.activeInbound = 1;
  assert.equal(await f.recovery.poll(), false);
  f.r.activeInbound = 0;
  f.r.core = { bridge: {
    turns: new Map([['a', { sessionId: 's', turn: 1, terminal: false }]]),
    outputOrigins: () => [{ provider: 'discord', accountId: 'fixture' }],
  } };
  assert.equal(await f.recovery.poll(), false);
  f.r.core.bridge.turns.clear();
  assert.equal(await f.recovery.poll(), true);
  assert.equal(f.invokes, 1);
  f.recovery.stop();
});
test('Discord terminal Gateway close codes and invalid authentication stop automatic retries', async () => {
  for (const code of [4004, 4010, 4011, 4012, 4013, 4014]) {
    const f = fixture();
    f.recovery.noteFailure({ code });
    f.advance(3_600_000);
    assert.equal(await f.recovery.poll(), false);
    assert.equal(f.invokes, 0);
    f.recovery.stop();
  }
  assert.equal(recoveryFailure({ code: 'ETIMEDOUT' }).terminal, false);
});
test('explicit disable, closed runtime and legitimate READY never trigger a replacement', async () => {
  const f = fixture();
  f.recovery.noteFailure({ code: 'ETIMEDOUT' });
  f.advance(30_000);
  f.r.settings.configFile.value.enabled = false;
  assert.equal(await f.recovery.poll(), false);
  f.r.settings.configFile.value.enabled = true;
  f.r.closed = true;
  assert.equal(await f.recovery.poll(), false);
  f.recovery.stop();
  assert.equal(await f.recovery.poll(), false);
});
test('recovery limits failed login attempts per hour', async () => {
  const f = fixture();
  f.recovery.noteFailure({ code: 'ECONNRESET' });
  for (let i = 0; i < RECOVERY_MAX_PER_HOUR; i++) {
    f.advance(300_000);
    assert.equal(await f.recovery.poll(), true);
    f.recovery.noteFailure({ code: 'ECONNRESET' });
  }
  assert.equal(f.invokes, RECOVERY_MAX_PER_HOUR);
  assert.equal(await f.recovery.poll(), false);
  f.recovery.stop();
});
test('Discord startup has an abortable initial READY deadline', async () => {
  const emitter = new EventEmitter();
  emitter.login = () => Promise.resolve('only-test');
  emitter.isReady = () => false;
  const abort = new AbortController();
  await assert.rejects(
    awaitDiscordStartup(emitter, 'fixture', abort.signal, { loginTimeoutMs: 30, readyTimeoutMs: 15 }),
    { code: 'discord-ready-timeout' },
  );
});
test('Discord login timeout aborts without leaving the Host waiting forever', async () => {
  const emitter = new EventEmitter();
  emitter.login = () => new Promise(() => {});
  const abort = new AbortController();
  await assert.rejects(
    awaitDiscordStartup(emitter, 'fixture', abort.signal, { loginTimeoutMs: 15 }),
    { code: 'discord-login-timeout' },
  );
});
test('an already healthy client stays on SDK-managed gateway connection', async () => {
  const emitter = new EventEmitter();
  let loginCalls = 0;
  emitter.login = async () => { loginCalls++; };
  emitter.isReady = () => true;
  const abort = new AbortController();
  await awaitDiscordStartup(emitter, 'fixture', abort.signal, { loginTimeoutMs: 50 });
  assert.equal(loginCalls, 1);
});
