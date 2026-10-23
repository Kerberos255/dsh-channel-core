import { CoreError } from './validation.js';

const TRIGGER_GUARD_MS = 90000;
const RECURRING = new Set(['cron', 'daily', 'weekly', 'every']);

const fail = (code, message) => Object.assign(new CoreError(code, message), { code });

/**
 * Rebuild one active Scheduler record into a `schedule_create` request.
 * Returns null for a kind this channel cannot reproduce.
 * A one-shot record whose moment has already passed is NOT recreated: creating
 * it again would fire an already delivered reminder a second time.
 */
export function toCreateInput(task) {
  const base = { title: task.title, prompt: task.prompt };
  switch (task.kind) {
    case 'cron': return { ...base, cron: { expression: task.expression, time_zone: task.timeZone } };
    case 'daily': return { ...base, daily: { time: task.time, time_zone: task.timeZone } };
    case 'weekly': return { ...base, weekly: { time: task.time, time_zone: task.timeZone, weekdays: task.weekdays } };
    case 'every': return { ...base, every_seconds: task.everySeconds };
    case 'at': return { ...base, at: task.at ?? task.scheduledAt };
    case 'after': return { ...base, at: task.scheduledAt };
    default: return null;
  }
}

/** True when a rebuilt one-shot record would land in the past. */
export function isExpiredOneShot(task) {
  if (RECURRING.has(task.kind)) return false;
  const at = Date.parse(task.at ?? task.scheduledAt ?? '');
  return Number.isFinite(at) ? at <= Date.now() : true;
}

const bindingRows = (core, sessionId, scope) => core.store.db
  .prepare('SELECT binding_key, revision FROM bindings WHERE session_id=? ORDER BY binding_key')
  .all(sessionId)
  .filter(row => {
    const binding = core.store.binding(row.binding_key);
    return binding && JSON.stringify(binding.scope) === JSON.stringify(scope);
  });

/**
 * Move the Scheduler tasks of one Session to its successor, then report.
 * Nothing here is atomic across the Scheduler store, the channel SQLite and the
 * workspace registry; the contract is therefore "report every step honestly and
 * never claim an outcome that did not happen".
 */
export class NewSessionMigration {
  constructor(core) { this.core = core; }

  /**
   * Resolve a Host service without ever throwing. A missing service must become
   * a reported capability gap, not a failed /new after tasks already moved:
   * `ctx.get` and even property access can raise in some Cordis setups.
   */
  service(name) {
    try {
      const found = this.core.ctx.get?.(name);
      if (found !== undefined) return found;
    } catch { /* fall through to property access */ }
    try { return this.core.ctx[name]; } catch { return undefined; }
  }

  get schedule() { return this.service('schedule'); }
  // The registry registers itself as `workspaceRegistry`; `workspace` is only the
  // package name and resolves to nothing.
  get workspace() { return this.service('workspaceRegistry'); }
  get agents() { return this.service('agents'); }

  /** Everything a /new must verify before it is allowed to change anything. */
  admission(previous, tasks) {
    const agent = this.agents?.get?.(previous);
    if (agent && agent.status !== 'idle') return { ok: false, code: 'session-busy', message: '旧会话仍在执行，请等本轮结束后重试' };

    const live = this.core.bridge?.interactions?.pending;
    if (live && [...live.values()].some(pending => pending?.req?.agent?.session?.id === previous)) {
      return { ok: false, code: 'awaiting-answer', message: '旧会话有尚未回答的提问，请先处理' };
    }
    const waiting = this.core.store.db
      .prepare('SELECT COUNT(*) AS c FROM interactions WHERE session_id=? AND consumed=0 AND expires_at>?')
      .get(previous, Date.now()).c;
    if (waiting) return { ok: false, code: 'awaiting-answer', message: '旧会话有尚未回答的提问，请先处理' };

    const inbound = this.core.store.db
      .prepare("SELECT COUNT(*) AS c FROM receipts WHERE session_id=? AND status IN ('received','admitting','uncertain')")
      .get(previous).c;
    if (inbound) return { ok: false, code: 'pending-input', message: '旧会话还有未确认的消息，请稍后重试' };

    const soon = tasks.filter(task => task.status === 'active').find(task => Number.isFinite(Date.parse(task.scheduledAt ?? ''))
      && Date.parse(task.scheduledAt) - Date.now() < TRIGGER_GUARD_MS);
    if (soon) return { ok: false, code: 'imminent-trigger', message: `任务「${soon.title}」即将触发，请稍后重试` };

    return { ok: true };
  }

  /** Every Scheduler task bound to one Session, active and inactive alike. */
  async tasks(previous) {
    const schedule = this.schedule;
    if (!schedule?.catalog) throw fail('schedule-unavailable', '无法读取定时任务服务');
    const all = await schedule.catalog();
    return all.filter(task => task.sessionId === previous);
  }

  journalPut(row) {
    this.core.store.db.prepare(`INSERT INTO migration_journal(id,scope_key,old_session,new_session,old_task_id,new_task_id,phase,error_category,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET new_task_id=excluded.new_task_id,phase=excluded.phase,error_category=excluded.error_category,updated_at=excluded.updated_at`)
      .run(row.id, row.scopeKey, row.oldSession, row.newSession, row.oldTaskId ?? null, row.newTaskId ?? null,
        row.phase, row.errorCategory ?? null, Date.now());
  }

  /**
   * Rebuild tasks into `next`, deleting each old task only after its replacement
   * is confirmed. A create whose outcome is unknown stops the whole migration:
   * guessing would either duplicate a task or lose one.
   */
  async migrateTasks(previous, next, scope, tasks, correlationId) {
    const schedule = this.schedule;
    const migrated = [], skipped = [], failed = [], absent = [];
    for (const task of tasks) {
      if (task.status !== 'active') { skipped.push({ id: task.id, title: task.title, reason: 'inactive' }); continue; }
      const input = toCreateInput(task);
      if (!input) { skipped.push({ id: task.id, title: task.title, reason: 'unsupported-kind' }); continue; }
      if (isExpiredOneShot(task)) { skipped.push({ id: task.id, title: task.title, reason: 'expired' }); continue; }

      let created;
      try {
        created = await schedule.create(next, input);
      } catch (error) {
        // The Scheduler may have written the row and failed on the way back.
        // Never retry here: a second create would leave two live copies.
        const uncertain = error?.code === 'uncertain' || error?.name === 'TimeoutError';
        failed.push({ id: task.id, title: task.title, code: error?.code ?? 'create-failed', uncertain });
        this.journalPut({ id: `${correlationId}:${task.id}`, scopeKey: correlationId, oldSession: previous, newSession: next,
          oldTaskId: task.id, phase: uncertain ? 'uncertain' : 'failed', errorCategory: error?.code ?? 'create-failed' });
        if (uncertain) {
          throw fail('migration-uncertain', '任务创建结果不确定，已停止迁移并保留原任务');
        }
        continue;
      }

      this.journalPut({ id: `${correlationId}:${task.id}`, scopeKey: correlationId, oldSession: previous, newSession: next,
        oldTaskId: task.id, newTaskId: created?.id, phase: 'created' });

      if (!created?.id) {
        // Without a confirmed new id there is nothing to track: stop here rather
        // than record a migration that cannot be verified later.
        failed.push({ id: task.id, title: task.title, code: 'created-id-missing' });
        this.journalPut({ id: `${correlationId}:${task.id}`, scopeKey: correlationId, oldSession: previous, newSession: next,
          oldTaskId: task.id, phase: 'uncertain', errorCategory: 'created-id-missing' });
        continue;
      }

      try {
        const removed = await schedule.delete({ sessionId: previous, id: task.id });
        // The Scheduler reports a missing task without throwing; treat it as the
        // removal it is, but never as a verified migration.
        if (removed && removed.deleted === false) {
          absent.push({ id: task.id, newId: created.id, title: task.title });
          this.journalPut({ id: `${correlationId}:${task.id}`, scopeKey: correlationId, oldSession: previous, newSession: next,
            oldTaskId: task.id, newTaskId: created.id, phase: 'absent' });
          continue;
        }
        migrated.push({ oldId: task.id, newId: created.id, title: task.title });
      } catch (error) {
        // Replacement exists but the original could not be removed. Compensate by
        // deleting the copy we just made: two live tasks would run the script
        // twice, and these scripts have side effects.
        let compensated = false;
        try {
          await schedule.delete({ sessionId: next, id: created.id });
          compensated = true;
        } catch { /* fall through as a duplicate risk */ }
        failed.push({ id: task.id, title: task.title, code: 'delete-failed', duplicateRisk: !compensated, compensated });
        this.journalPut({ id: `${correlationId}:${task.id}`, scopeKey: correlationId, oldSession: previous, newSession: next,
          oldTaskId: task.id, newTaskId: created.id, phase: compensated ? 'create-reverted' : 'duplicate-risk',
          errorCategory: 'delete-failed' });
      }
    }
    return { migrated, skipped, failed, absent };
  }

  /**
   * Whole /new sequence: admission, task migration, CAS rebind, strict archive.
   * The caller owns Session creation and user-visible wording.
   */
  async run({ previous, next, scope, correlationId }) {
    const before = bindingRows(this.core, previous, scope);
    let tasks;
    try {
      tasks = await this.tasks(previous);
    } catch (error) {
      if (error?.code !== 'schedule-unavailable') throw error;
      // A Host without the Scheduler must not lose /new entirely: degrade to the
      // previous behaviour and say so, instead of making the command unusable.
      this.core.ctx.get?.('pluginDiagnostics')?.record('dsh-channel-core', 'warn', 'channel.migration-degraded', { stage: 'publish' });
      this.core.store.rebindScope(previous, next, scope);
      return { migrated: [], skipped: [], failed: [], archived: await this.archive(previous), degraded: true };
    }

    const gate = this.admission(previous, tasks);
    if (!gate.ok) throw fail(gate.code, gate.message);

    if (!tasks.length) {
      this.core.store.rebindScope(previous, next, scope);
      const archived = await this.archive(previous);
      return { migrated: [], skipped: [], failed: [], archived };
    }

    const active = tasks.filter(task => task.status === 'active');
    if (!active.length) {
      // Only history left: nothing to rebuild, but the retired rows are reported.
      this.core.store.rebindScope(previous, next, scope);
      const archived = await this.archive(previous);
      return { migrated: [], skipped: tasks.map(task => ({ id: task.id, title: task.title, reason: 'inactive' })), failed: [], archived };
    }

    const result = await this.migrateTasks(previous, next, scope, tasks, correlationId);

    // Any incomplete migration forbids the route switch. Switching while a task
    // is still bound to the old Session is precisely the failure this flow
    // exists to prevent, so a partial result must leave the binding untouched.
    if (result.failed.length) {
      throw fail('migration-incomplete',
        `有 ${result.failed.length} 个任务未能安全迁移，已保留原绑定与旧会话；请核对定时任务后再试`);
    }

    // Compare-and-set: if anything touched the bindings while tasks were being
    // rebuilt, stop before switching traffic and report instead of guessing.
    const after = bindingRows(this.core, previous, scope);
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      throw fail('binding-changed', '切换期间渠道绑定发生变化，已停止；请核对后重试');
    }

    // The comparison above is advisory; the transaction repeats it as a real
    // compare-and-set so a concurrent rebind cannot slip in between.
    this.core.store.rebindScope(previous, next, scope, before);
    const archived = await this.archive(previous);
    return { ...result, archived };
  }

  async archive(sessionId) {
    const diagnostics = this.service('pluginDiagnostics');
    const workspace = this.workspace;
    if (!workspace?.archiveSession) {
      diagnostics?.record('dsh-channel-core', 'warn', 'channel.archive-unavailable', { stage: 'retire' });
      return { ok: false, code: 'workspace-unavailable' };
    }
    try {
      // Strict mode only. stopActivity:true would make Scheduler delete the
      // Session's remaining tasks, which is exactly what this flow prevents.
      await workspace.archiveSession(sessionId);
      return { ok: true };
    } catch (error) {
      diagnostics?.record('dsh-channel-core', 'warn', 'channel.archive-refused', { stage: 'retire', code: error?.name ?? error?.code });
      return { ok: false, code: error?.name ?? error?.code ?? 'archive-failed' };
    }
  }
}
