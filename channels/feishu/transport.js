import { checkAbort, boundedBytes, statusLabel } from 'dsh-channel-core/transport-utils';
import { renderProgressLines } from 'dsh-channel-core/progress-lines';

export function normalize(message,config){
  return {provider:'feishu',accountId:config.accountId,conversationId:message.chatId,userId:message.senderId,messageId:message.messageId,
    ...(message.threadId?{threadId:message.threadId}:{}),...(message.replyToMessageId?{replyTo:message.replyToMessageId}:{}),
    kind:message.chatType==='p2p'?'dm':message.threadId?'thread':'group',text:message.content??'',attachments:[],resources:message.resources??[],
    timestamp:Math.trunc(message.createTime??Date.now()),mentionedBot:!!message.mentionedBot};
}
export function card(body,actions=[],options){
  const isProgress=body.final!==true&&options?.mode==='progress';
  const lines=isProgress?renderProgressLines(body,options.progress):[];
  // Progress must not fall back to body.text: it can contain an uncommitted draft.
  const fallback=isProgress?(statusLabel(body.status)||'正在处理…'):(body.text||statusLabel(body.status));
  const content=String(lines.length?lines.join('\n'):fallback).slice(0,7500);
  return {schema:'2.0',config:{wide_screen_mode:true,update_multi:true},header:{title:{tag:'plain_text',content:'DeepSeek · '+statusLabel(body.status)},template:body.status==='failed'?'red':body.final?'green':'blue'},
    body:{elements:[{tag:'markdown',content},...actions.map(action=>({tag:'button',text:{tag:'plain_text',content:action.label.slice(0,80)},type:'default',value:{dsh:action.token}}))]}};
}
export async function createTransport({config,credentials,signal,receive,state,action},sdkOverride){
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
  const progress=new Map(),presented=new Map(),disposers=[];
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
  async function present(origin,body,actions=[],streaming){
    checkAbort(signal);
    const id=key(origin),payload=card(body,actions,streaming),signature=JSON.stringify(payload);
    const existing=progress.get(id);
    if(existing&&presented.get(id)===signature)return {messageId:existing};
    if(existing){
      try {
        await channel.updateCard(existing,payload);
        presented.set(id,signature);
        return {messageId:existing};
      } catch(error) {
        // An unknown outcome is not safe to resend; only a confirmed missing card is.
        if(error?.status!==404&&error?.statusCode!==404)throw error;
        progress.delete(id);presented.delete(id);
        state('原进度卡片不存在，重新发送卡片',false);
      }
    }
    checkAbort(signal);
    const sent=await channel.send(origin.conversationId,{card:payload},sendOptions(origin));
    progress.set(id,sent.messageId);presented.set(id,signature);
    return sent;
  }
  let closing;const close=()=>closing??=(async()=>{signal.removeEventListener('abort',onAbort);disposers.splice(0).forEach(dispose=>dispose());await channel.disconnect();progress.clear();presented.clear();})();
  const onAbort=()=>{void close().catch(()=>{});};signal.addEventListener('abort',onAbort,{once:true});
  return {
    throttleMs:config.throttleMs,
    start:()=>channel.connect(),
    close,
    progress:config.streaming.mode!=='off'?(origin,body)=>present(origin,body,[],config.streaming):undefined,
    async send(origin,body){
      let result;
      if(body.text.length>7500){
        if(progress.has(key(origin)))await present(origin,{...body,text:'回复较长，完整内容见下方。'});
        checkAbort(signal);result=await channel.send(origin.conversationId,{markdown:body.text},sendOptions(origin));
      }else result=await present(origin,body);
      progress.delete(key(origin));presented.delete(key(origin));return result;
    },
    question:(origin,body,actions)=>present(origin,body,actions),
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
