import { deliveryKey } from './delivery-store.js';
import { routeKeys } from './routing.js';
import { CoreError } from './validation.js';

const fail=(code,message)=>{throw new CoreError(code,message);};
const BYTES_MAX=32000;

/** Native tool rendering requires an array of content blocks, not a JSON string. */
export const renderProactiveToolResult=(_args,value)=>[{type:'text',text:JSON.stringify(value)}];

/**
 * Trusted channel-core outbound entry. This does not accept free-form platform
 * addresses: every destination must be a currently bound, configured conversation
 * owned by the calling native Session.
 */
export class ProactiveOutbound {
 constructor(core){this.core=core;}

 targets(sessionId){
  if(typeof sessionId!=='string'||!sessionId.startsWith('session-'))fail('outbound-session-required','主动消息必须由已存在的原生会话发送');
  const rows=this.core.store.db.prepare('SELECT binding_key,id,session_id,data FROM bindings WHERE session_id=?').all(sessionId);
  const results=[];
  for(const row of rows){
   let binding;try{binding=JSON.parse(row.data)}catch{continue}
   if(!['feishu','discord'].includes(binding.provider)||!['dm','group','thread'].includes(binding.kind))continue;
   if(routeKeys(binding,binding.scope,this.core.configFile.value.sharedDM).bindingKey!==row.binding_key)continue;
   const config=this.core.ctx.get?.(binding.provider+'ChannelSettings')?.configFile?.value;
   if(!config?.enabled||config.accountId!==binding.accountId)continue;
   if(binding.kind==='dm'){
    if(config.dmPolicy==='disabled')continue;
    const actor=binding.userId;
    const owner=this.core.store.owner?.(binding.provider,binding.accountId)?.userId;
    const permitted=config.dmPolicy==='all'||config.allowedUsers?.includes(actor)
      ||config.ownerMode==='manual'&&config.ownerUserId===actor
      ||config.ownerMode==='first-dm'&&owner===actor;
    if(!actor||!permitted)continue;
   }else if(!config.allowGroups||config.groupPolicy!=='all'&&!config.allowedGroups?.includes(binding.conversationId))continue;
   results.push({id:row.id,sessionId,provider:binding.provider,accountId:binding.accountId,
    conversationId:binding.conversationId,threadId:binding.threadId,kind:binding.kind});
  }
  return results;
 }

 async send({sessionId,bindingId,text,idempotencyKey,source='host'}={}){
  if(typeof text!=='string'||!text.trim()||Buffer.byteLength(text,'utf8')>BYTES_MAX)fail('outbound-content-invalid','消息正文必须非空且不超过 32000 字节');
  if(typeof idempotencyKey!=='string'||!idempotencyKey.trim()||idempotencyKey.length>160)fail('outbound-key-required','主动投递需要稳定的幂等键');
  if(typeof source!=='string'||!source.trim()||source.length>64)fail('outbound-source-invalid','主动消息来源无效');
  const available=this.targets(sessionId);
  const candidates=bindingId?available.filter(t=>t.id===bindingId):available;
  if(candidates.length!==1){
   const code=candidates.length?'outbound-target-ambiguous':available.length?'outbound-binding-denied':'outbound-target-unavailable';
   fail(code,available.length>1&&!bindingId?'存在多个已绑定渠道，请显式指定 bindingId：'+available.map(t=>t.id+' ('+t.provider+'/'+t.kind+')').join('，'):'找不到当前会话可用的、已配置授权的渠道绑定');
  }
  const target=candidates[0];
  const id=deliveryKey(['proactive-v1',source,sessionId,target.id,idempotencyKey]);
  const bridge=this.core.bridge;
  const origin={provider:target.provider,accountId:target.accountId,
   conversationId:target.conversationId,kind:target.kind,
   ...(target.threadId?{threadId:target.threadId}:{})};
  const body={sessionId,text,status:'completed',final:true,proactive:true};
  const old=bridge.store.get(id);
  if(old){
   let previous;try{previous=JSON.parse(old.body)}catch{}
   if(previous?.text!==undefined&&previous.text!==text)fail('outbound-idempotency-conflict','相同投递键不能修改已保存的消息内容');
   if(old.provider!==origin.provider||old.account_id!==origin.accountId)fail('outbound-idempotency-conflict','已保存投递目标与当前绑定不一致');
  }else bridge.store.enqueue(id,origin,body);
  let row=bridge.store.get(id);
  const registration=bridge.adapters.get(JSON.stringify([origin.provider,origin.accountId]));
  if(row.state==='pending'&&registration&&!registration.closed){
   await bridge.deliver(row,registration);
   row=bridge.store.get(id);
  }
  this.core.ctx.get?.('pluginDiagnostics')?.record('dsh-channel-core',
   row.state==='failed'?'warn':'info','channel.proactive-send',
   {provider:origin.provider,state:row.state,code:row.error||undefined});
  // sent means remote transport accepted it; uncertain must not be replayed blindly.
  return {id,state:row.state,provider:origin.provider,kind:origin.kind,
    ...(row.remote_id?{messageId:row.remote_id}:{})};
 }
}
