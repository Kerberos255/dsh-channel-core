// Shared SDK-aware recovery coordinator for the Host's persistent channels.
// The underlying SDK owns normal reconnect/RESUME. This supervisor only
// rebuilds an initial failed or persistently disconnected transport.
export const TERMINAL_GATEWAY_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014]);
export const RECOVERY_INTERVAL_MS = 30_000;
export const SDK_GRACE_MS = 120_000;
export const RECOVERY_MAX_PER_HOUR = 10;
const HOUR_MS = 3_600_000;
const BACKOFF_BASE_MS = 15_000;
const BACKOFF_MAX_MS = 300_000;
const safeCode = error => {
  const code = error?.code ?? error?.status;
  if (typeof code === 'number' && Number.isSafeInteger(code)) return code;
  return typeof code === 'string' && /^[a-zA-Z0-9_-]{1,48}$/.test(code) ? code : 'unknown';
};
export function recoveryFailure(error, provider = 'discord') {
  const code = safeCode(error);
  return {
    code,
    terminal: (provider === 'discord' && TERMINAL_GATEWAY_CODES.has(Number(code))) ||
      ['token-invalid', 'network-config-invalid', 'network-proxy-invalid',
       'network-proxy-missing', 'network-runtime-upgrade-required',
       'DISALLOWED_INTENTS', 'TOKEN_INVALID', 'credential-unavailable'].includes(code),
  };
}
export class ChannelRecovery {
  constructor(runtime, { now = Date.now, every = setInterval, clear = clearInterval, random = Math.random,
      intervalMs = RECOVERY_INTERVAL_MS, sdkGraceMs = SDK_GRACE_MS } = {}) {
    this.runtime = runtime;
    this.provider = runtime.provider;
    this.now = now;
    this.clear = clear;
    this.random = random;
    this.sdkGraceMs = sdkGraceMs;
    this.failures = 0;
    this.attempts = [];
    this.nextAt = 0;
    this.disconnectedAt = 0;
    this.terminal = null;
    this.recovering = false;
    this.closed = false;
    this.lastCode = null;
    this.timer = every(() => { void this.poll().catch(() => {}); }, intervalMs);
    this.timer?.unref?.();
  }
  diagnostic(level, event, fields = {}) {
    this.runtime.diagnostic?.(level, event, { state: level === 'info' ? 'ok' : 'failed', ...fields });
  }
  resetManual() {
    this.terminal = null;
    this.lastCode = null;
    this.nextAt = 0;
    this.failures = 0;
    this.disconnectedAt = 0;
  }
  noteConnected() {
    if (this.closed) return;
    if (this.failures || this.disconnectedAt) this.diagnostic('info', `channel.${this.provider}-recovered`);
    this.failures = 0;
    this.disconnectedAt = 0;
    this.nextAt = 0;
    this.lastCode = null;
    this.terminal = null;
  }
  noteDisconnected(code = null) {
    if (this.closed) return;
    if (!this.disconnectedAt) this.disconnectedAt = this.now();
    if (this.provider === 'discord' && code !== null && TERMINAL_GATEWAY_CODES.has(Number(code)))
      this.block(code);
  }
  block(code) {
    if (this.closed || this.terminal !== null) return;
    this.terminal = code;
    this.lastCode = code;
    this.diagnostic('warn', `channel.${this.provider}-terminal`, { code });
  }
  noteFailure(error) {
    if (this.closed) return;
    const { code, terminal } = recoveryFailure(error, this.provider);
    this.lastCode = code;
    if (terminal) { this.block(code); return; }
    this.failures++;
    const exponential = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.min(this.failures - 1, 5));
    const jitter = 0.8 + this.random() * 0.4;
    this.nextAt = this.now() + Math.round(exponential * jitter);
    this.diagnostic('warn', `channel.${this.provider}-retry-scheduled`, { code });
  }
  isBusy() {
    const r = this.runtime;
    if (r.activeInbound > 0) return true;
    const bridge = (r.core ?? r.ctx?.channelCore)?.bridge;
    const accountId = r.settings.configFile.value.accountId;
    const registration = bridge?.adapters?.get(JSON.stringify([this.provider, accountId]));
    if (registration?.tails?.size > 0) return true;
    if (!bridge?.turns?.size || typeof bridge.outputOrigins !== 'function') return false;
    for (const state of bridge.turns.values()) {
      if (state.terminal) continue;
      try {
        if (bridge.outputOrigins(state.sessionId, state.turn)
          .some(item => item.provider === this.provider && item.accountId === accountId)) return true;
      } catch { return true; }
    }
    return false;
  }
  async poll() {
    const r = this.runtime;
    if (this.closed || this.recovering || r.closed || r.provider !== this.provider) return false;
    if (!r.settings.configFile.value.enabled) return false;
    const now = this.now();
    const health = r.transport?.health?.();
    if (health?.terminal) { this.block(health.code ?? 'gateway-terminal'); return false; }
    if (this.terminal !== null) return false;
    if (health?.ready === true || (r.ready && health?.ready !== false)) {
      this.noteConnected();
      return false;
    }
    if (r.connecting) return false;
    if (r.transport && !this.disconnectedAt) this.noteDisconnected(health?.code ?? null);
    if (r.transport && now - this.disconnectedAt < this.sdkGraceMs) return false;
    if (!r.transport && !this.failures && !this.disconnectedAt) return false;
    if (now < this.nextAt || this.isBusy()) return false;
    this.attempts = this.attempts.filter(at => now - at < HOUR_MS);
    if (this.attempts.length >= RECOVERY_MAX_PER_HOUR) {
      this.nextAt = this.attempts[0] + HOUR_MS;
      return false;
    }
    this.attempts.push(now);
    this.recovering = true;
    this.diagnostic('warn', `channel.${this.provider}-recovering`);
    try {
      await r.reconfigure({ recovery: true });
      if (r.ready && r.transport?.health?.()?.ready !== false) this.noteConnected();
      return true;
    } finally {
      this.recovering = false;
    }
  }
  stop() {
    if (this.closed) return;
    this.closed = true;
    this.clear(this.timer);
  }
}
