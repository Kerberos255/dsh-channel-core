import { checkAbort, boundedBytes, statusLabel } from 'dsh-channel-core/transport-utils';
import { renderProgressLines } from 'dsh-channel-core/progress-lines';
import { renderFooter } from '../discord/footer.js';
import { createCardKitChannel, streamingCard } from './cardkit.js';

export function normalize(message,config){
  return {provider:'feishu',accountId:config.accountId,conversationId:message.chatId,userId:message.senderId,messageId:message.messageId,
    ...(message.threadId?{threadId:message.threadId}:{}),...(message.replyToMessageId?{replyTo:message.replyToMessageId}:{}),
    kind:message.chatType==='p2p'?'dm':message.threadId?'thread':'group',text:message.content??'',attachments:[],resources:message.resources??[],
    timestamp:Math.trunc(message.createTime??Date.now()),mentionedBot:!!message.mentionedBot};
}
const CARD_TEXT_BYTES=9000;
const CARD_JSON_BYTES=24000;
const byteLength=text=>Buffer.byteLength(String(text??''),'utf8');

/** Byte-bounded, Unicode-safe card splitting; preserve code fences across cards. */
export function splitFeishuMarkdown(value,maxBytes=CARD_TEXT_BYTES){
  const text=String(value??'');
  if(!text)return ['本轮已完成。'];
  const chars=Array.from(text),chunks=[];
  let start=0,fence='';
  while(start<chars.length){
    const prefix=fence?'\x60\x60\x60'+fence+'\n':'';
    const limit=maxBytes-byteLength(prefix)-96;
    if(limit<100)throw new Error('feishu-card-budget-too-small');
    let end=start,length=0,lastNewline=-1;
    while(end<chars.length&&end-start<6000){
      const size=byteLength(chars[end]);
      if(length+size>limit)break;
      length+=size;
      if(chars[end]==='\n')lastNewline=end;
      end++;
    }
    if(end===start)throw new Error('feishu-character-exceeds-card-budget');
    if(end<chars.length&&lastNewline>start+(end-start)/2)end=lastNewline+1;
    const segment=chars.slice(start,end).join('');
    for(const match of segment.matchAll(/(?:^|\n)\x60\x60\x60([^\n]*)/g))
      fence=fence?'':match[1].trim().slice(0,48)||' ';
    chunks.push(prefix+segment+(fence?'\n\x60\x60\x60':''));
    start=end;
  }
  return chunks;
}
function tailWithinBytes(input,maxBytes){
  const chars=Array.from(String(input));let total=0,start=chars.length;
  while(start>0&&total+byteLength(chars[start-1])<=maxBytes)total+=byteLength(chars[--start]);
  return {text:chars.slice(start).join(''),truncated:start>0};
}
const safeAgent=value=>{
  const clean=String(value??'').replace(/[\r\n\x00-\x1f\x7f]/g,'').trim().slice(0,48);
  return clean||'Agent';
};
const title=body=>safeAgent(body.agentName)+' · '+statusLabel(body.status)+(body.partCount>1?' · '+body.partIndex+'/'+body.partCount:'');
const wrapCard=(body,elements)=>({
  schema:'2.0',config:{wide_screen_mode:true,update_multi:true},
  header:{title:{tag:'plain_text',content:title(body)},template:body.status==='failed'?'red':body.final?'green':'blue'},
  body:{elements},
});

const isToolLine=text=>/^(?:✅|❌|⏳) /.test(text);
export function formatProgressRows(rows){
  return rows.map((text,index)=>index===0?text:
    (isToolLine(rows[index-1])&&isToolLine(text)?'\n':'\n\n')+text).join('');
}
export function card(body,actions=[],options){
  const isProgress=body.final!==true&&options?.mode==='progress';
  const lines=isProgress?renderProgressLines(body,{...options.progress,feishuLayout:true,reasoningMaxChars:7000}):[];
  // Never use body.text as a progress fallback: it can contain a transient draft.
  const fallback=isProgress?(statusLabel(body.status)||'正在处理…'):(body.text||statusLabel(body.status));
  const content=String(lines.length?formatProgressRows(lines):fallback).slice(0,7500);
  const elements=[{tag:'markdown',content},
    ...actions.map(action=>({tag:'button',text:{tag:'plain_text',content:action.label.slice(0,80)},type:'default',value:{dsh:action.token}}))];
  if(body.footerText)elements.push({tag:'markdown',content:body.footerText,text_size:'notation'});
  return wrapCard(body,elements);
}

/** Independent final draft card: the full answer is never placed in this card. */
/** Keep genuine chronological reasoning while hiding answer-only repeats. */
export function distinctReasoning(drafts,answer=''){
  const normalize=value=>String(value??'').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu,'');
  const reference=normalize(answer),grams=new Set();
  for(let i=0;i+3<=reference.length;i++)grams.add(reference.slice(i,i+3));
  return (drafts??[]).map(raw=>String(raw??'').split(/\n\s*\n/).filter(paragraph=>{
    const line=normalize(paragraph);
    if(line.length<16||!reference)return true;
    if(reference.includes(line))return false;
    if(line.length<36)return true;
    let matched=0,total=0;
    for(let i=0;i+3<=line.length;i++){total++;if(grams.has(line.slice(i,i+3)))matched++;}
    return !total||matched/total<0.88;
  }).join('\n\n').trim()).filter(Boolean);
}
export function draftCard(body){
  const separate=distinctReasoning(body.drafts,body.text);
  const raw=separate.join('\n\n');
  const visible=tailWithinBytes(raw,7000);
  const reasoning=(visible.truncated||body.draftsTruncated?'…（较早思考已省略）\n':'')+visible.text;
  return wrapCard({...body,partCount:undefined},[{
    tag:'collapsible_panel',expanded:false,
    header:{title:{tag:'plain_text',content:'💭 思考'},vertical_align:'center',
      icon:{tag:'standard_icon',token:'down-small-ccm_outlined',size:'16px 16px'},icon_position:'right',icon_expanded_angle:-180},
    border:{color:'grey',corner_radius:'5px'},vertical_spacing:'8px',padding:'8px 8px 8px 8px',
    elements:[{tag:'markdown',content:reasoning,text_size:'notation'}],
  }]);
}
const withinBudget=payload=>byteLength(JSON.stringify(payload))<=CARD_JSON_BYTES;

/** Keep every byte of the final answer; further split any JSON-escaped outlier. */
export function finalCards(body,options){
  let parts=splitFeishuMarkdown(body.text);
  while(true){
    const cards=parts.map((text,i)=>card({...body,text,footerText:i===parts.length-1?body.footerText:'',final:true,partIndex:i+1,partCount:parts.length},[],options));
    if(cards.every(withinBudget))return cards;
    const next=parts.flatMap((text,i)=>withinBudget(cards[i])?[text]:splitFeishuMarkdown(text,Math.max(1500,Math.floor(byteLength(text)/2))));
    if(next.length===parts.length)throw new Error('feishu-card-payload-too-large');
    parts=next;
  }
}
export async function createTransport({config,credentials,signal,receive,state,action,host},sdkOverride){
  const sdk=sdkOverride??await import('@larksuiteoapi/node-sdk');
  const silent=Object.fromEntries(['error','warn','info','debug','trace'].map(name=>[name,()=>{}]));
  const http=sdk.defaultHttpInstance?{
    request:options=>sdk.defaultHttpInstance.request({...options,timeout:15000,signal}),
    ...Object.fromEntries(['get','delete','head','options'].map(method=>[method,(url,options)=>sdk.defaultHttpInstance[method](url,{...options,timeout:15000,signal})])),
    ...Object.fromEntries(['post','put','patch'].map(method=>[method,(url,data,options)=>sdk.defaultHttpInstance[method](url,data,{...options,timeout:15000,signal})])),
  }:undefined;
  const channel=sdk.createLarkChannel({appId:config.appId,appSecret:credentials[0],domain:config.domain==='lark'?sdk.Domain.Lark:sdk.Domain.Feishu,source:'dsh-channel-feishu',logger:silent,handshakeTimeoutMs:15000,
    ...(http?{httpInstance:http}:{}),
    policy:{dmMode:config.ownerMode==='first-dm'||config.ownerMode==='manual'?'all':'allowlist',dmAllowlist:config.allowedUsers,groupAllowlist:config.allowGroups?config.allowedGroups:[],requireMention:config.requireMention,respondToMentionAll:false},
    safety:{chatQueue:{enabled:false},batch:{text:{delayMs:0,longDelayMs:0},media:{delayMs:0}},staleMessageWindowMs:300000},outbound:{streamThrottleMs:config.throttleMs,textChunkLimit:6000,retry:{maxAttempts:1}}});
  const runtimeMetrics=new Map();
  async function presentation(body,force=false){
    const sessionId=body.sessionId,previous=sessionId?runtimeMetrics.get(sessionId):null;
    let metrics=previous?.value??{};
    if(sessionId&&host?.runtimeMetrics&&(force||!previous||Date.now()-previous.at>=6000)){
      try{
        const fresh=await host.runtimeMetrics(sessionId);
        if(fresh&&typeof fresh==='object'){metrics=fresh;runtimeMetrics.set(sessionId,{at:Date.now(),value:fresh});}
        if(runtimeMetrics.size>256)runtimeMetrics.delete(runtimeMetrics.keys().next().value);
      }catch{/* Missing session metrics must not interrupt card delivery. */}
    }
    let role=body.agentName||metrics.agentName;
    if(!role)try{role=host?.defaultAgentName?.();}catch{}
    const footerText=renderFooter(config.streaming.footer,body,metrics);
    return {...body,agentName:role||'Agent',footerText};
  }
  const progress=new Map(),presented=new Map(),kitRecords=new Map(),disposers=[];
  let kitApi=null; // resolve lazily: rawClient can appear after channel.connect()
  let kitDisabled=false;
  const key=origin=>JSON.stringify([origin.conversationId,origin.threadId??'',origin.messageId]);
  const sendOptions=origin=>({replyTo:origin.messageId,replyInThread:!!origin.threadId});
  disposers.push(channel.on('message',async message=>{
    if(signal.aborted)return;
    const origin=normalize(message,config);
    try{await receive(origin);}catch(error){state('消息处理失败：'+(error.code??'请查看 DSH 日志'));await present(origin,{text:'消息未被接收，请查看渠道设置与 DSH 日志。',status:'failed',final:true}).catch(()=>{});progress.delete(key(origin));presented.delete(key(origin));}
  }));
  disposers.push(channel.on('cardAction',async event=>{
    const token=event.action?.value?.dsh;
    if(!signal.aborted&&typeof token==='string')try{await action({token,userId:event.operator.openId,conversationId:event.chatId,threadId:event.threadId,messageId:event.messageId,values:event.action.option?[event.action.option]:undefined});}catch{return {toast:{type:'error',content:'该操作已失效，或当前账号无权回答。'}};}
  }));
  disposers.push(channel.on('error',error=>state('渠道错误：'+error.code)));
  disposers.push(channel.on('reconnecting',()=>state('渠道正在重连…',false)));
  disposers.push(channel.on('reconnected',()=>state('渠道已重新连接',true)));
  async function presentPayload(origin,payload,{recreateMissing=true,streaming=false}={}){
    checkAbort(signal);
    if(!withinBudget(payload))throw Object.assign(new Error('feishu-card-payload-too-large'),{definitelyNotSent:true});
    const id=key(origin),signature=JSON.stringify(payload);
    if(streaming&&!kitApi&&config.streaming.cardEngine==='cardkit'&&!kitDisabled){
      kitApi=createCardKitChannel(channel);
      if(!kitApi){kitDisabled=true;state('CardKit SDK 接口不可用，已自动使用兼容卡片',false);}
    }
    const existing=progress.get(id);
    if(existing&&presented.get(id)===signature)return {messageId:existing};
    const record=kitRecords.get(id);
    if(record){
      // CardKit-linked IM messages must be edited through CardKit, not
      // through the legacy IM patch API. One serial sequence owns all updates.
      if(streaming&&record.streaming){
        const next=streamingCard(payload);
        const structure=JSON.stringify({header:next.header,extra:next.body.elements.slice(1)});
        if(record.structural!==structure)await kitApi.update(record,next);
        else await kitApi.text(record,next.body.elements[0].content);
      }else{
        await kitApi.close(record);
        await kitApi.update(record,payload);
        kitRecords.delete(id);
      }
      presented.set(id,signature);
      return {messageId:record.messageId};
    }
    if(existing){
      try{
        await channel.updateCard(existing,payload);
        presented.set(id,signature);
        return {messageId:existing};
      }catch(error){
        if(error?.status!==404&&error?.statusCode!==404)throw error;
        progress.delete(id);presented.delete(id);
        state('原进度卡片不存在，'+(recreateMissing?'重新发送卡片':'已跳过折叠思考卡'),false);
        if(!recreateMissing)return {messageId:null};
      }
    }
    if(streaming&&kitApi&&!kitDisabled){
      try{
        const created=await kitApi.create(origin,payload);
        kitRecords.set(id,created);
        progress.set(id,created.messageId);presented.set(id,signature);
        return {messageId:created.messageId};
      }catch(error){
        // Fallback is safe only when card.create failed BEFORE any IM send.
        if(!error.cardKitFallbackSafe)throw error;
        kitDisabled=true;
        state('CardKit 创建不可用，已回退兼容卡片：'+(error.code??'api-unavailable'),false);
      }
    }
    checkAbort(signal);
    const sent=await channel.send(origin.conversationId,{card:payload},sendOptions(origin));
    progress.set(id,sent.messageId);presented.set(id,signature);
    return sent;
  }
  const present=async(origin,body,actions=[],options)=>presentPayload(origin,card(await presentation(body),actions,options),{streaming:(options?.mode==='progress'||options?.mode==='partial')&&!actions.length&&body.final!==true});
  let closing;const close=()=>closing??=(async()=>{signal.removeEventListener('abort',onAbort);disposers.splice(0).forEach(dispose=>dispose());await channel.disconnect();progress.clear();presented.clear();kitRecords.clear();})();
  const onAbort=()=>{void close().catch(()=>{});};signal.addEventListener('abort',onAbort,{once:true});
  return {
    throttleMs:config.throttleMs,
    showNarration:config.streaming.mode==='progress'&&config.streaming.progress.narration,
    start:()=>channel.connect(),
    details:()=>({feishuCardEngine:kitRecords.size?'CardKit':kitDisabled?'兼容模式（CardKit 不可用）':config.streaming.cardEngine==='patch'?'兼容模式':'CardKit 待首次流式创建'}),
    close,
    progress:config.streaming.mode!=='off'?(origin,body)=>present(origin,body,[],config.streaming):undefined,
    async send(origin,body){
      const finished=await presentation({...body,final:true},true);
      const hasDrafts=origin.kind==='dm'&&config.streaming.mode==='progress'
        &&config.streaming.progress.narration&&progress.has(key(origin))&&Array.isArray(body.drafts)&&distinctReasoning(body.drafts,body.text).length>0;
      // Only retain a collapsed reasoning card if content remains after answer overlap removal.
      // The final answer is never placed inside that same card.
      // Prepare and validate all answer cards before mutating the progress card.
      const cards=finalCards(finished,config.streaming);
      // Confirm answer delivery before converting the old progress message
      // into a retained thought card. A failed thought-card patch must never
      // suppress an otherwise successful final response.
      let result;
      for(let i=0;i<cards.length;i++){
        checkAbort(signal);
        if(i===0&&!hasDrafts)result=await presentPayload(origin,cards[i]);
        else{
          const sent=await channel.send(origin.conversationId,{card:cards[i]},sendOptions(origin));
          result??=sent;
        }
      }
      if(hasDrafts){
        try{await presentPayload(origin,draftCard(finished),{recreateMissing:false});}
        catch(error){state('飞书最终答复已发送，但折叠思考卡更新失败：'+(error?.code??'unknown'));}
      }
      progress.delete(key(origin));presented.delete(key(origin));kitRecords.delete(key(origin));
      return result;
    },
    async question(origin,body,actions){
      const wasKit=kitRecords.has(key(origin));
      const answer=await present(origin,body,actions);
      if(wasKit){progress.delete(key(origin));presented.delete(key(origin));}
      return answer;
    },
    async upload(message,sessionId,fileUploads,uploadSignal){
      if(!config.attachments)throw Object.assign(new Error('attachments-disabled'),{code:'attachments-disabled'});
      if(message.resources.length>16)throw new Error('too-many-attachments');
      const files=[];
      for(const resource of message.resources){
        checkAbort(uploadSignal);
        const response=await channel.rawClient.im.v1.messageResource.get({path:{message_id:message.messageId,file_key:resource.fileKey},params:{type:resource.type==='image'?'image':'file'}});
        const data=response.getReadableStream();
        const uploaded=await fileUploads.uploadStream({sessionId,data:boundedBytes(data,config.maxAttachmentMB*1024*1024,uploadSignal),signal:uploadSignal,name:resource.fileName??(resource.type==='image'?'image.png':'attachment')});
        files.push(uploaded);
      }
      return files;
    },
  };
}
