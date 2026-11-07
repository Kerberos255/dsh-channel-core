/** Read SDK WebSocket state without relying on inbound message activity.
 * A quiet conversation is not a lost connection.
 */
export function feishuConnectionHealth(channel, signal) {
  if (signal?.aborted) return { ready:false, recovering:false, terminal:false, code:null };
  let status;
  try {
    status = channel?.getConnectionStatus?.();
  } catch {
    return { ready:false, recovering:false, terminal:false, code:'feishu-health-check-failed' };
  }
  return {
    ready:status?.state==='connected',
    recovering:status?.state==='connecting'||status?.state==='reconnecting',
    terminal:false,
    code:status?.state==='failed'?'feishu-sdk-failed':null,
  };
}
