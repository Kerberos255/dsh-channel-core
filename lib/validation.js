export class CoreError extends Error {
  constructor(code, message = code) { super(message); this.name = 'CoreError'; this.code = code }
}
export function id(value, field = 'id') {
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || /[\x00-\x1f]/.test(value)) throw new CoreError('invalid-' + field);
  return value;
}
export function mode(value) {
  if (!['steering', 'queue', 'interrupt'].includes(value)) throw new CoreError('invalid-mode');
  return value;
}
export function channelMessage(input) {
  if (!input || typeof input !== 'object' || !['feishu', 'discord'].includes(input.provider)) throw new CoreError('invalid-provider');
  const result = Object.fromEntries(['provider', 'accountId', 'conversationId', 'userId', 'messageId'].map(key => [key, id(input[key], key)]));
  if (input.threadId !== undefined) result.threadId = id(input.threadId, 'threadId');
  if (input.replyTo !== undefined) result.replyTo = id(input.replyTo, 'replyTo');
  if (!['dm', 'group', 'thread'].includes(input.kind)) throw new CoreError('invalid-kind');
  if (typeof input.text !== 'string' || Buffer.byteLength(input.text, 'utf8') > 65536) throw new CoreError('invalid-text');
  if (!Number.isSafeInteger(input.timestamp) || input.timestamp < 0) throw new CoreError('invalid-timestamp');
  if (!Array.isArray(input.attachments ?? []) || (input.attachments?.length ?? 0) > 16) throw new CoreError('invalid-attachments');
  const attachments = (input.attachments ?? []).map(a => {
    if (!a || typeof a !== 'object') throw new CoreError('invalid-attachments');
    return { receiptId: id(a.receiptId, 'attachment'), ...(a.mediaType ? { mediaType: id(a.mediaType, 'mediaType') } : {}) };
  });
  if (!input.text.trim() && !attachments.length) throw new CoreError('empty-message');
  return { ...result, kind: input.kind, text: input.text, attachments, timestamp: input.timestamp };
}
export function scope(input, identityId) {
  if (!input || typeof input !== 'object') throw new CoreError('invalid-scope');
  return Object.fromEntries(['identityId', 'workspaceId', 'presetId', 'memoryNamespace', 'scheduleNamespace'].map(key => [key, id(key === 'identityId' ? identityId : input[key], key)]));
}
