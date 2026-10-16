/**
 * Optional task alerts. Sources publish a small, non-sensitive event after
 * persisting their task status. Neither Dream nor any other producer imports
 * Channel Core; this adapter alone owns delivery and recipient selection.
 */
export class TaskNotifications {
  constructor(core) { this.core = core; }

  channels() {
    return ['feishu', 'discord'].filter(provider => {
      const config = this.core.ctx.get?.(provider + 'ChannelSettings')?.configFile?.value;
      if (!config?.enabled || !config.accountId) return false;
      if (provider === 'feishu' && !config.appId) return false;
      const runtime = this.core.channelAdapters?.find(adapter => adapter.provider === provider);
      return runtime?.message !== '请配置渠道凭证';
    }).map(id => ({ id, label: id === 'feishu' ? '飞书' : 'Discord' }));
  }

  /** Resolve the *current* owner conversation. Never pin a rotating Session ID. */
  ownerTarget(provider) {
    const config = this.core.ctx.get?.(provider + 'ChannelSettings')?.configFile?.value;
    if (!config?.enabled) return null;
    const owner = this.core.store.owner(provider, config.accountId);
    if (!owner?.userId) return null;
    const candidates = [];
    const rows = this.core.store.db.prepare('SELECT session_id, id, data FROM bindings').all();
    for (const row of rows) {
      let binding;
      try { binding = JSON.parse(row.data); } catch { continue; }
      if (binding.provider !== provider || binding.accountId !== config.accountId ||
          binding.kind !== 'dm' || binding.userId !== owner.userId) continue;
      if (this.core.outboundTargets(row.session_id).some(target =>
        target.bindingId === row.id && target.provider === provider && target.kind === 'dm')) {
        candidates.push({ sessionId: row.session_id, bindingId: row.id });
      }
    }
    // Never guess a recipient when multiple workspaces/roles share a provider.
    return candidates.length === 1 ? candidates[0] : null;
  }

  async notify(alert) {
    const settings = this.core.configFile.value;
    if (!settings.taskNotifications || settings.notificationChannel === 'none') return { state: 'disabled' };
    if (!alert || alert.state !== 'failed' || alert.origin !== 'scheduled' ||
        typeof alert.id !== 'string' || !/^[a-zA-Z0-9:_-]{1,120}$/.test(alert.id) ||
        typeof alert.source !== 'string' || !/^dsh-[a-z0-9-]{1,60}$/.test(alert.source))
      return { state: 'ignored' };
    const provider = settings.notificationChannel;
    if (!this.channels().some(channel => channel.id === provider)) return { state: 'unavailable' };
    const target = this.ownerTarget(provider);
    if (!target) return { state: 'no-owner-target' };
    const labels = { daily: '每日记忆', dream: 'Dream 整理', weekly: '每周记忆复查' };
    const label = alert.source === 'dsh-memory-dreaming' ? (labels[alert.kind] ?? '记忆任务') : '自动任务';
    const text = '⚠️ DSH 任务通知\n\n任务：' + label + '\n状态：执行失败\n请在对应插件的执行记录中查看原因。';
    return this.core.sendToBoundSession({
      ...target, text, source: 'task-alert', idempotencyKey: alert.source + ':' + alert.id,
    });
  }
}
