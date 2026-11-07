// Normalize Schedule v0.2.2 Host-wide entries to the v0.2.1 /new migration contract.
// Never retry ambiguous writes or delete tasks bound to another Session.
const sessionOf = task => task.sessionId ?? (task.target?.kind === 'session' ? task.target.sessionId : undefined);
const adapt = task => ({ ...task, ...(sessionOf(task) === undefined ? {} : { sessionId: sessionOf(task) }) });

function timing(input) {
  if (input.cron) return { kind: 'cron', cron: input.cron };
  if (input.daily) return { kind: 'daily', daily: input.daily };
  if (input.weekly) return { kind: 'weekly', weekly: input.weekly };
  if (input.every_seconds !== undefined) return { kind: 'every', every_seconds: input.every_seconds };
  if (input.at) return { kind: 'at', at: input.at };
  throw new Error('Schedule migration refused an unsupported recurrence');
}

export function compatibleSchedule(schedule) {
  if (!schedule || typeof schedule.catalog !== 'function') return schedule;
  if (typeof schedule.delete === 'function') return schedule; // 0.2.1
  if (typeof schedule.edit !== 'function') throw new Error('Schedule migration cannot verify Host API');
  const catalog = async () => (await schedule.catalog()).map(adapt);
  return {
    catalog,
    async create(sessionId, input, signal) {
      const created = await schedule.create({ title: input.title, prompt: input.prompt,
        timing: timing(input), target: { kind: 'session', sessionId } }, undefined, signal);
      if (typeof created?.id !== 'string') throw new Error('Schedule migration create outcome unconfirmed');
      return adapt(created);
    },
    async delete({ sessionId, id }, signal) {
      const existing = (await catalog()).find(task => task.id === id);
      if (!existing || existing.sessionId !== sessionId) return { id, deleted: false, code: 'schedule_not_found' };
      const result = await schedule.edit({ id, action: 'delete' }, undefined, signal);
      if (result?.deleted === true) return result;
      if (result?.code === 'schedule_not_found') return { id, deleted: false, code: result.code };
      throw new Error('Schedule migration delete outcome unconfirmed: '+String(result?.code ?? 'unknown'));
    },
  };
}
