import { channelMessage, scope, mode } from './validation.js';
import { createHash } from 'node:crypto';
export function routeKeys(message,currentScope,shared=true){
  const parts=Object.values(currentScope);
  const routeKey=JSON.stringify(message.kind==='dm'&&shared?['dm',...parts]:[message.kind,message.provider,message.accountId,message.conversationId,message.threadId??'',...parts.filter((_,index)=>message.kind==='dm'||index!==0)]);
  return {routeKey,bindingKey:JSON.stringify([message.provider,message.accountId,message.conversationId,message.threadId??'',routeKey])};
}
export class IdentityRouter {
  constructor(store, defaults) { this.store = store; this.defaults = defaults }
  route(input, options = {}) {
    const message = channelMessage(input);
    const identityId = this.store.identity(message);
    const currentScope = scope(options.scope ?? this.defaults.scope, identityId);
    const shared = options.sharedDM ?? this.defaults.sharedDM ?? true;
    const {routeKey,bindingKey}=routeKeys(message,currentScope,shared);
    let binding = this.store.binding(bindingKey);
    if (!binding) {
      binding = this.store.putBinding(bindingKey, { sessionId: this.store.sessionForScope(routeKey), scope: currentScope, provider: message.provider, accountId: message.accountId, conversationId: message.conversationId, threadId: message.threadId, ...(message.kind==='dm'?{userId:message.userId}:{}), kind: message.kind, delivery: 'origin' });
    }
    const inboundMode = mode(binding.inboundMode ?? options.channelMode ?? this.defaults.defaultMode ?? 'steering');
    const receiptKey = message.provider + ':' + createHash('sha256').update(JSON.stringify([message.accountId, message.messageId, 'message'])).digest('hex');
    return { message, binding, inboundMode, receiptKey };
  }
}
