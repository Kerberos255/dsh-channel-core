import { deliveryKey } from './delivery-store.js';
import { routeKeys } from './routing.js';
import { CoreError } from './validation.js';
import {validateWorkspaceImage} from './outbound-image.js';
import {validateWorkspaceFile} from './outbound-file.js';

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

 /** Convert binding rows into authorized targets for one Session. Shared by the
  * direct path and the retired-route fallback so both apply identical checks. */
 eligible(rows,sessionId){
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

 targets(sessionId){
  if(typeof sessionId!=='string'||!sessionId.startsWith('session-'))fail('outbound-session-required','主动消息必须由已存在的原生会话发送');
  const rows=this.core.store.db.prepare('SELECT binding_key,id,session_id,data FROM bindings WHERE session_id=?').all(sessionId);
  const results=this.eligible(rows,sessionId);
  if(results.length)return results;
  // Fallback: this Session used to serve a route that has since been rebound to
  // another Session (for example after /new). Delivery stays possible, but only
  // through a recorded binding_key whose scope still matches exactly; the history
  // never grants a route the Session was not already authorized for.
  const seen=new Set();
  for(const entry of this.core.store.routeHistory(sessionId)){
   const row=this.core.store.db.prepare('SELECT binding_key,id,session_id,data FROM bindings WHERE binding_key=?').get(entry.binding_key);
   if(!row||seen.has(row.id))continue;
   let binding;try{binding=JSON.parse(row.data)}catch{continue}
   if(JSON.stringify(binding.scope)!==entry.scope_json)continue;
   const resolved=this.eligible([row],sessionId);
   if(!resolved.length)continue;
   seen.add(row.id);
   results.push(...resolved);
  }
  return results;
 }

 async send({sessionId,bindingId,text='',imagePath,filePath,workspacePath,idempotencyKey,source='host'}={}){
  if(imagePath&&filePath)fail('outbound-media-ambiguous','一次仅能发送一张图片或一个文件');
  if(typeof text!=='string'||(!text.trim()&&!imagePath&&!filePath)||Buffer.byteLength(text,'utf8')>BYTES_MAX)
   fail('outbound-content-invalid','消息必须包含非空文字、图片或文件');
  // Feishu's native file message has no caption; silently dropping text is unsafe.
  if(filePath&&text.trim())fail('outbound-file-caption-unsupported','请单独发送文字说明，文件消息不能携带文字');
  if(typeof idempotencyKey!=='string'||!idempotencyKey.trim()||idempotencyKey.length>160)fail('outbound-key-required','主动投递需要稳定的幂等键');
  if(typeof source!=='string'||!source.trim()||source.length>64)fail('outbound-source-invalid','主动消息来源无效');
  const available=this.targets(sessionId);
  const candidates=bindingId?available.filter(t=>t.id===bindingId):available;
  if(candidates.length!==1){
   const code=candidates.length?'outbound-target-ambiguous':available.length?'outbound-binding-denied':'outbound-target-unavailable';
   // A guessed bindingId used to produce "no authorized binding", which reads as
   // "this session has no channel" and sends the model hunting for another way
   // out. Say plainly that the id was wrong and that omitting it is correct.
   if(!candidates.length&&available.length&&bindingId)
    fail(code,'指定的 bindingId 不属于当前 Session，请省略 bindingId 直接重试；本会话可用绑定：'+available.map(t=>t.id+' ('+t.provider+'/'+t.kind+')').join('，'));
   fail(code,available.length>1&&!bindingId?'存在多个已绑定渠道，请显式指定 bindingId：'+available.map(t=>t.id+' ('+t.provider+'/'+t.kind+')').join('，'):'找不到当前会话可用的、已配置授权的渠道绑定');
  }
  const target=candidates[0];
  if(imagePath&&target.provider!=='feishu')fail('outbound-image-provider-unsupported','图片发送目前仅支持飞书');
  if(filePath&&target.provider!=='feishu')fail('outbound-file-provider-unsupported','文件发送目前仅支持飞书');
  const image=imagePath?validateWorkspaceImage(imagePath,workspacePath):null;
  const file=filePath?validateWorkspaceFile(filePath,workspacePath):null;
  const id=deliveryKey(['proactive-v1',source,sessionId,target.id,idempotencyKey]);
  const bridge=this.core.bridge;
  const origin={provider:target.provider,accountId:target.accountId,
   conversationId:target.conversationId,kind:target.kind,
   ...(target.threadId?{threadId:target.threadId}:{})};
  const body={sessionId,text,status:'completed',final:true,proactive:true,
   ...(image?{imagePath:image.imagePath,workspacePath:image.workspacePath,imageDigest:image.imageDigest}:{}),
   ...(file?{filePath:file.filePath,workspacePath:file.workspacePath,fileDigest:file.fileDigest,fileName:file.fileName}:{} )};
  const old=bridge.store.get(id);
  if(old){
   let previous;try{previous=JSON.parse(old.body)}catch{}
   if(previous?.text!==undefined&&(previous.text!==text||previous.imageDigest!==image?.imageDigest||
     Boolean(previous.imagePath)!==Boolean(image)||previous.fileDigest!==file?.fileDigest||
     previous.fileName!==file?.fileName||Boolean(previous.filePath)!==Boolean(file)))
    fail('outbound-idempotency-conflict','相同投递键不能修改已保存的消息内容或附件');
   if(old.provider!==origin.provider||old.account_id!==origin.accountId)fail('outbound-idempotency-conflict','已保存投递目标与当前绑定不一致');
  }
  // Persist the immutable external record before any adapter can send the
  // message; duplicate calls reuse exactly the same delivery and archive.
  this.core.store.tx(()=>{
   if(!old)bridge.store.enqueue(id,origin,body);
   bridge.store.archive(id,{sessionId,provider:origin.provider,source,idempotencyKey,
    text:image?'[图片] '+(text.trim()||image.imagePath.split(/[\\/]/).at(-1)):
     file?'[文件] '+file.fileName:text});
  });
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
    ...(image?{contentType:'image'}:file?{contentType:'file',fileName:file.fileName}:{}),
    ...(row.remote_id?{messageId:row.remote_id}:{})};
 }
}
