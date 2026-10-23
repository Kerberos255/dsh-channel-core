import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { NewSessionMigration } from './new-session-migration.js';

const MIB = 1024 * 1024;
const SESSION_FILE = 'session.v4.jsonl.zstd';
const COOLDOWN_MS = 6 * 60 * 60 * 1000;

const rotationId = (sessionId) =>
  'session-' + createHash('sha256').update(JSON.stringify(['dsh-channel-rotation-v1', sessionId])).digest('hex').slice(0, 32);

/**
 * Bound the growth of Session logs. Two behaviours share one trigger:
 * a channel Session switches to a successor and is archived; a Session with no
 * binding (a Web Session) is archived without switching, because the Host offers
 * no way to move a browser tab from a plugin.
 */
export class SessionRotation {
  constructor(core) {
    this.core = core;
    this.timer = null;
    this.running = false;
    this.cooldown = new Map();
    this.failures = new Map();
  }

  get config() { return this.core.configFile.value; }
  get migration() { return this._migration ?? (this._migration = new NewSessionMigration(this.core)); }
  service(name) { return this.migration.service(name); }

  /** Session ids and log sizes, filtered to the current threshold. */
  scan() {
    const limit = Math.max(1, this.config.rotationFileMiB) * MIB;
    const root = path.join(this.core.ctx.dshHomePath(), 'sessions');
    const found = [];
    let workspaces;
    try { workspaces = fs.readdirSync(root, { withFileTypes: true }); } catch { return found; }
    for (const workspace of workspaces) {
      if (!workspace.isDirectory()) continue;
      const workspacePath = path.join(root, workspace.name);
      let sessions;
      try { sessions = fs.readdirSync(workspacePath, { withFileTypes: true }); } catch { continue; }
      for (const session of sessions) {
        if (!session.isDirectory()) continue;
        const file = path.join(workspacePath, session.name, SESSION_FILE);
        let stat;
        try { stat = fs.statSync(file); } catch { continue; }
        if (!stat.isFile() || stat.size < limit) continue;
        found.push({ sessionId: session.name, bytes: stat.size, modifiedAt: stat.mtimeMs });
      }
    }
    found.sort((left, right) => right.bytes - left.bytes);
    return found;
  }

  /** Everything that must be true before a Session may be rotated. */
  eligible(entry) {
    const sessionId = entry.sessionId;
    const idleMs = Math.max(1, this.config.rotationIdleMinutes) * 60_000;
    if (Date.now() - entry.modifiedAt < idleMs) return { ok: false, code: 'busy' };

    const agent = this.service('agents')?.get?.(sessionId);
    if (agent && agent.status !== 'idle') return { ok: false, code: 'busy' };

    const live = this.core.bridge?.interactions?.pending;
    if (live && [...live.values()].some(pending => pending?.req?.agent?.session?.id === sessionId)) return { ok: false, code: 'awaiting-answer' };

    const waiting = this.core.store.db
      .prepare('SELECT COUNT(*) AS c FROM interactions WHERE session_id=? AND consumed=0 AND expires_at>?')
      .get(sessionId, Date.now()).c;
    if (waiting) return { ok: false, code: 'awaiting-answer' };

    const inbound = this.core.store.db
      .prepare("SELECT COUNT(*) AS c FROM receipts WHERE session_id=? AND status IN ('received','admitting','uncertain')")
      .get(sessionId).c;
    if (inbound) return { ok: false, code: 'pending-input' };

    if (this.core.commandTasks?.size) return { ok: false, code: 'busy' };
    if (this.cooldown.has(sessionId) && this.cooldown.get(sessionId) > Date.now()) return { ok: false, code: 'cooldown' };
    if (this.core.store.db.prepare('SELECT COUNT(*) AS c FROM migration_journal WHERE old_session=? AND phase IN (?,?)').get(sessionId, 'created', 'uncertain').c) {
      return { ok: false, code: 'pending-migration' };
    }
    return { ok: true };
  }

  bindingsOf(sessionId) {
    return this.core.store.db.prepare('SELECT binding_key,id,data FROM bindings WHERE session_id=?').all(sessionId);
  }

  /** True for a verified owner DM, which LCM already rotates with memory handoff. */
  isOwnerDm(rows) {
    if (!this.config.rotationExcludeOwnerDm) return false;
    return rows.some(row => {
      try { return JSON.parse(row.data).kind === 'dm'; } catch { return false; }
    });
  }

  note(sessionId, outcome, code) {
    this.service('pluginDiagnostics')?.record('dsh-channel-core', outcome === 'failed' ? 'warn' : 'info', 'rotation.' + outcome, { code, state: outcome === 'failed' ? 'failed' : 'completed' });
    try {
      this.core.store.db.prepare('INSERT INTO audit(kind,detail,at) VALUES(?,?,?)')
        .run('session-rotation', JSON.stringify({ sessionId, outcome, code: code ?? null }), Date.now());
    } catch { /* audit is best effort; never block rotation on it */ }
  }

  async rotate(entry) {
    const rows = this.bindingsOf(entry.sessionId);
    if (this.isOwnerDm(rows)) { this.note(entry.sessionId, 'skipped', 'owner-dm-lcm'); return { skipped: 'owner-dm-lcm' }; }

    // A Session without a channel binding is NOT necessarily a Web Session: it may
    // be a desktop Session, a CLI Session, or one owned by another plugin, and the
    // Host offers no reliable way to tell them apart from here. Rotating or
    // archiving it could destroy a Session the user is still working in, so a
    // binding-less Session is only reported, never touched automatically.
    if (!rows.length) {
      this.note(entry.sessionId, 'skipped', 'no-binding');
      return { skipped: 'no-binding' };
    }

    const scope = (() => { try { return JSON.parse(rows[0].data).scope; } catch { return null; } })();
    if (!scope) { this.note(entry.sessionId, 'failed', 'binding-scope-unreadable'); return { failed: 'binding-scope-unreadable' }; }

    // Read the header ONCE, asynchronously. A synchronous read returns a Promise,
    // which silently produced an undefined cwd and would have created the
    // successor in the wrong workspace.
    const header = await this.header(entry.sessionId);
    if (!header?.cwd) {
      this.cooldown.set(entry.sessionId, Date.now() + COOLDOWN_MS);
      this.note(entry.sessionId, 'failed', 'header-unavailable');
      return { failed: 'header-unavailable' };
    }

    const next = rotationId(entry.sessionId);
    await this.core.controller.create({ sessionId: next, cwd: header.cwd, ...(header.agentPreset ? { agentPreset: header.agentPreset } : {}) });
    const outcome = await this.migration.run({ previous: entry.sessionId, next, scope, correlationId: 'rotation:' + entry.sessionId });
    this.note(entry.sessionId, 'completed', outcome.archived?.ok ? null : 'archive-pending');
    await this.announce(rows, outcome);
    return outcome;
  }

  /** Native Session header, or null when it cannot be read. The Host API is async. */
  async header(sessionId) {
    try {
      const query = this.service('sessionQuery');
      if (!query?.observeSession) return null;
      const observation = await query.observeSession(sessionId);
      try {
        return observation?.header ?? null;
      } finally {
        observation?.[Symbol.dispose]?.();
      }
    } catch { return null; }
  }

  /** Tell the conversation what happened, once, through the route that moved. */
  async announce(rows, outcome) {
    const binding = this.core.store.binding(rows[0].binding_key);
    if (!binding?.sessionId) return;
    const text = `会话已自动轮转（日志达到 ${this.config.rotationFileMiB} MiB）`
      + (outcome?.migrated?.length ? `，已迁移 ${outcome.migrated.length} 个定时任务` : '')
      + (outcome?.archived?.ok ? '，旧会话已归档' : '，旧会话暂未归档');
    try {
      await this.core.sendToBoundSession({
        sessionId: binding.sessionId, text,
        idempotencyKey: 'rotation-notice:' + rows[0].binding_key + ':' + Date.now(), source: 'rotation',
      });
    } catch { /* the notice must never undo a completed rotation */ }
  }

  /** One pass. Never throws into the timer; failures are recorded and cooled down. */
  async tick() {
    if (this.running || this.core.closed || this.config.rotationMode !== 'auto') return;
    this.running = true;
    try {
      for (const entry of this.scan()) {
        const gate = this.eligible(entry);
        if (!gate.ok) continue;
        try {
          await this.rotate(entry);
          this.failures.delete(entry.sessionId);
        } catch (error) {
          const count = (this.failures.get(entry.sessionId) ?? 0) + 1;
          this.failures.set(entry.sessionId, count);
          this.cooldown.set(entry.sessionId, Date.now() + COOLDOWN_MS);
          this.note(entry.sessionId, 'failed', error?.code ?? 'rotation-failed');
          if (count >= 3) this.cooldown.set(entry.sessionId, Date.now() + COOLDOWN_MS * 4);
        }
      }
    } finally { this.running = false; }
  }

  start() {
    if (this.timer) return;
    const minutes = Math.max(1, this.config.rotationScanMinutes);
    this.timer = setInterval(() => { void this.tick().catch(() => {}) }, minutes * 60_000);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
