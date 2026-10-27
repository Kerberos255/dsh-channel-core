import path from 'node:path';
import { createHash } from 'node:crypto';
import { credentialRef } from '@deepseek-ai/dsh-credentials';

// One set of formatters, bound to the machine's own zone rather than UTC.
const LOCAL_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
const DATE_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: LOCAL_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
const TIME_FMT = new Intl.DateTimeFormat('en-GB', { timeZone: LOCAL_ZONE, hour: '2-digit', minute: '2-digit', hour12: false });
const WEEK_FMT = new Intl.DateTimeFormat('zh-CN', { timeZone: LOCAL_ZONE, weekday: 'short' });
/** `[2026-10-27 周二 11:30]` using the channel's own timestamp, in local time. */
export function localStamp(timestamp) {
  const value = new Date(Number.isFinite(timestamp) ? timestamp : Date.now());
  return `[${DATE_FMT.format(value)} ${WEEK_FMT.format(value)} ${TIME_FMT.format(value)}]`;
}

export function allowed(message,config) {
  if(message.kind==='dm')return config.dmPolicy!=='disabled'&&(config.dmPolicy==='all'||config.allowedUsers.includes(message.userId)||config.ownerMode==='first-dm'&&!config.allowedUsers.length||config.ownerMode==='manual'&&config.ownerUserId===message.userId);
  if(!config.allowGroups)return false;
  if(config.groupPolicy!=='all'&&(!config.allowedUsers.includes(message.userId)||!config.allowedGroups.includes(message.conversationId)))return false;
  return !config.requireMention||message.mentionedBot;
}
/** Group allowlist handed to a channel SDK.
 * Feishu's SDK policy gate drops every group outside a non-empty allowlist before
 * ChannelRuntime.receive() can auto-collect it, so auto-collection must own admission
 * on its own: hand the SDK an empty list and let allowed() gate the reply.
 */
export function groupAllowlistFor(config) {
  return config.allowGroups&&!config.autoCollectGroups?config.allowedGroups??[]:[];
}
/** Auto-collection widens the allowlist only for the owner, never for strangers. */
export function shouldCollectGroup(message,config) {
  return message.kind!=='dm'&&Boolean(config.allowGroups)&&Boolean(config.autoCollectGroups)
    &&config.allowedUsers.includes(message.userId)&&!config.allowedGroups.includes(message.conversationId);
}
export function channelScope(config) {
  const workspaceId=config.workspacePath?'path-'+createHash('sha256').update(path.resolve(config.workspacePath).toLowerCase()).digest('hex').slice(0,24):'default';
  return {workspaceId,presetId:config.agentPreset||'default',memoryNamespace:config.memoryNamespace,scheduleNamespace:config.memoryNamespace};
}
export function identityLinks(config) {
  return config.identityLinks.map(line=>{
    const split=line.indexOf('=');if(split<1||split===line.length-1)throw new Error('identity-link-invalid');
    return {userId:line.slice(0,split).trim(),identityId:line.slice(split+1).trim()};
  });
}
/** Whether a settings change requires rebuilding the live connection.
 * `allowedGroups` is exempt while auto-collection owns admission: the runtime reads the
 * fresh list for every message, and reconnecting would abort the very message that just
 * discovered the group (reconfigure() aborts the in-flight signal). Every other field is
 * still enforced while the transport is being built, so those changes must reconnect.
 */
export function connectionSettingsChanged(previous,next) {
  if(!previous)return true;
  const exempt=previous.autoCollectGroups===true&&next.autoCollectGroups===true?new Set(['allowedGroups']):null;
  const cold=config=>JSON.stringify(Object.entries(config).filter(entry=>!exempt?.has(entry[0])));
  return cold(previous)!==cold(next);
}
export class ChannelRuntime {
  constructor(ctx,settings,{provider,credentialRefs,createTransport,core}) {
    this.ctx=ctx;this.settings=settings;this.provider=provider;this.credentialRefs=credentialRefs;this.createTransport=createTransport;this.core=core??ctx.channelCore;
    this.closed=false;this.generation=0;this.transport=null;this.unregister=null;this.abort=null;this.tail=Promise.resolve();this.message='渠道连接未启用';
    this.reconnects=0;this.connectedAt=null;this.lastEventAt=null;this.lastDisconnectAt=null;this.applied=null;
    this.diagnostic=(level,event,details={})=>this.ctx.get?.('pluginDiagnostics')?.record('dsh-channel-core',level,event,{provider:this.provider,...details});
    this.unsubscribe=settings.configFile.subscribe(()=>{
      const next=settings.configFile.value;
      // Receive-scope edits (a collected group) must not tear the connection down: the
      // abort in reconfigure() would kill the message that just discovered the group.
      if(this.applied&&!connectionSettingsChanged(this.applied,next)){this.applied=next;return;}
      this.reconfigure();
    });
    this.credentialDispose=ctx.on('credentials/reference-updated',ref=>{if(this.credentialRefs(this.settings.configFile.value).includes(ref))this.reconfigure();});
  }
  details(){
    const config=this.settings.configFile.value,allGroups=config.allowGroups&&config.groupPolicy==='all';
    const privateMessage=config.dmPolicy==='disabled'?'私聊已关闭。':config.dmPolicy==='all'?'接收所有私聊用户的消息。':config.allowedUsers.length?'私聊按指定用户范围接收。':'私聊尚未配置允许使用的用户，暂不接收私聊消息。';
    const groupMessage=!config.allowGroups?'服务器或群聊消息已关闭。':allGroups?'接收服务器内所有用户、所有频道的消息'+(config.requireMention?'，需要 @ 机器人。':'，无需 @ 机器人。'):'服务器或群聊消息按指定用户与频道范围接收。';
    const receiveMessage=privateMessage+' '+groupMessage;
    const core=this.core??this.ctx.channelCore;
    const owner=core.store.owner?.(this.provider,config.accountId)??null;
    const ownerStatus=owner?('已认领：'+owner.userId+'（'+(owner.source==='manual'?'手动设置':'首次私聊')+'）'):'尚未认领；第一位私聊者将自动成为主人';
    const source=core.runtimeNetwork?.source;
    return {message:this.message,connected:!!this.ready,provider:this.provider,ownerStatus,receiveMessage,workspacePath:this.workspacePath??'',reconnects:this.reconnects,connectedAt:this.connectedAt,lastEventAt:this.lastEventAt,lastDisconnectAt:this.lastDisconnectAt,...this.transport?.details?.(),...(source?{networkMessage:{system:'网络：跟随 Windows 系统代理',environment:'网络：跟随代理环境变量',custom:'网络：使用自定义代理',direct:'网络：直接连接'}[source]}:{})};
  }
  reconfigure(){
    if(this.closed)return Promise.resolve();
    const generation=++this.generation;
    this.abort?.abort();
    this.tail=this.tail.catch(()=>{}).then(()=>this.configure(generation)).catch(error=>{this.diagnostic('error','channel.configure-failed',{code:error?.code});if(!this.closed&&generation===this.generation)this.message='连接失败：请检查凭证、权限或网络';});
    return this.tail;
  }
  async configure(generation){
    await this.disconnect();
    if(this.closed||generation!==this.generation)return;
    const config=this.settings.configFile.value;this.applied=config;
    if(config.ownerMode==='manual')this.core.store.setOwner(this.provider,config.accountId,config.ownerUserId);
    if(!config.enabled){this.message='渠道连接未启用';return;}
    if(this.provider==='feishu'&&!config.appId){this.message='请填写飞书应用 App ID';return;}
    try{await (this.core??this.ctx.channelCore).networkReady;}catch(error){this.message='网络配置失败：'+(error.code??'network-config-invalid');return;}
    if(this.closed||generation!==this.generation)return;
    const values=[];
    for(const name of this.credentialRefs(config)){const resolved=await this.ctx.credentials.resolve(credentialRef(name));if(!resolved?.value){this.message='请配置渠道凭证';return;}values.push(resolved.value);}
    if(this.closed||generation!==this.generation)return;
    const abort=new AbortController();this.abort=abort;this.message='正在连接渠道…';
    let transport;
    try {
      const context=await this.sessionContext(config,abort.signal);this.workspacePath=context.create.cwd;
      transport=await this.createTransport({config,credentials:values,signal:abort.signal,
        receive:message=>this.receive(message,this.settings.configFile.value,transport,abort.signal),
        ...(this.provider==='feishu'?{menuStatus:event=>this.menuStatus(event,config,abort.signal)}:{}),
        ...(this.provider==='discord'?{statusPanel:event=>this.discordStatusPanel(event,config,abort.signal)}:{}),
        state:(message,connected,scope='channel')=>{if(generation===this.generation){this.message=message;if(scope==='channel'&&typeof message==='string'&&/失败|错误|超时|不可用|失效|异常/.test(message))this.diagnostic('warn','channel.status-error',{state:'failed'});if(typeof connected==='boolean'){if(connected&&!this.ready){this.connectedAt=Date.now();if(this.lastDisconnectAt)this.reconnects++;this.diagnostic('info','channel.connected',{state:'active'});}if(!connected&&this.ready){this.lastDisconnectAt=Date.now();this.diagnostic('warn','channel.disconnected',{state:'failed'});}this.ready=connected;}}},
        diagnostic:(level,event,details={})=>this.diagnostic(level,event,details),
        action:request=>(this.core??this.ctx.channelCore).bridge.answer({...request,provider:this.provider,accountId:config.accountId}).then(result=>{if(result?.accepted&&result?.completed)this.diagnostic('info','channel.answer-completed',{state:'ok'});return result;},error=>{this.diagnostic('error','channel.answer-failed',{code:error?.code,state:'failed'});throw error;}),
        sessions:async message=>allowed({...message,mentionedBot:true},config)?(this.core??this.ctx.channelCore).channelSessions(message,{scope:(await this.sessionContext(config,abort.signal)).scope}):[],
      });
      if(this.closed||abort.signal.aborted||generation!==this.generation){await transport.close();return;}
      const links=identityLinks(config);
      for(const link of links){
        if(!config.allowedUsers.includes(link.userId))throw new Error('identity-link-user-not-allowed');
      }
      (this.core??this.ctx.channelCore).store.syncAliases(this.provider,config.accountId,links);
      this.transport=transport;
      await transport.start();
      if(abort.signal.aborted||generation!==this.generation){await this.disconnect();return;}
      this.unregister=(this.core??this.ctx.channelCore).bridge.register(this.provider,config.accountId,transport);this.ready=true;
      this.connectedAt??=Date.now();
      this.message='渠道已连接';
    }catch(error){
      await transport?.close().catch(()=>{});await this.disconnect();
      if(!this.closed&&generation===this.generation)this.message='连接失败：'+(error.code??'请检查凭证、权限或网络');
    }
  }
  async discordStatusPanel(event,config,signal){
    if(this.closed||signal.aborted||this.provider!=='discord')return null;
    if(typeof event?.userId!=='string')return null;
    const core=this.core??this.ctx.channelCore;
    const owner=core.store.owner('discord',config.accountId);
    if(!owner||owner.userId!==event.userId)return null;
    const status=core.statusCenter;
    if(!status?.discordPersonalStatus)throw new Error('discord-status-service-unavailable');
    const recentAt=core.recentReplyAtForOwner('discord',config.accountId,event.userId);
    return status.discordPersonalStatus({provider:'discord',accountId:config.accountId},recentAt);
  }
  async menuStatus(event,config,signal){
    if(this.closed||signal.aborted||this.provider!=='feishu')return null;
    if(!event||event.eventKey!=='status'||typeof event.userId!=='string')return null;
    const core=this.core??this.ctx.channelCore;
    const owner=core.store.owner('feishu',config.accountId);
    if(!owner||owner.userId!==event.userId)return null;
    const status=core.statusCenter;
    if(!status?.feishuPersonalStatus)throw new Error('feishu-status-service-unavailable');
    const recentAt=core.recentReplyAtForOwner('feishu',config.accountId,event.userId);
    return status.feishuPersonalStatus('',{provider:'feishu',accountId:config.accountId},recentAt);
  }
  async receive(message,config,transport,signal){
    if(this.closed||signal.aborted)return {ignored:true};
    // Auto-collect: remember a group the owner speaks in, so its chat id never has
    // to be looked up by hand. Strangers in other groups never widen the allowlist.
    if(shouldCollectGroup(message,config)){
      const collected=this.collectGroup(config.allowedGroups,message.conversationId);
      if(collected)config={...config,allowedGroups:collected};
    }
    if(!allowed(message,config))return {ignored:true};
    if(message.kind==='dm'){
      const store=(this.core??this.ctx.channelCore).store;
      if(config.ownerMode==='first-dm')store.claimOwner(message);
      else if(config.ownerMode==='manual')store.setOwner(this.provider,config.accountId,config.ownerUserId);
    }
    this.lastEventAt=Date.now();
    try{
      const {create,scope}=await this.sessionContext(config,signal);
      const options={signal,create,scope,workspaceScope:scope.workspaceId,channelMode:config.inputMode==='inherit'?undefined:config.inputMode,
        idempotencyPayload:{...message,resources:message.resources??[]},
        uploadAttachments:message.resources?.length?sessionId=>transport.upload(message,sessionId,this.ctx.fileUploads,signal):undefined,
      };
      const command=message.text.trim().match(this.provider==='feishu'?/^\/(new|stop|status|session|answer|model|think|reason)(?:\s+([\s\S]*))?$/:/^\/(new|stop|status|session|answer|reason)(?:\s+([\s\S]*))?$/);
      if(command)return (this.core??this.ctx.channelCore).command(message,command[1],command[2]??'',options,transport);
      // Stamp the local date onto every non-command message. The model has no
      // clock of its own and the Host runtime context carries no time, so without
      // this it infers dates from content and gets them wrong. It sits at the very
      // front of the newest message only, which leaves the cached prompt prefix
      // untouched; commands and the idempotency payload stay exactly as received.
      return (this.core??this.ctx.channelCore).receive(message.text?.trim()?{...message,text:localStamp(message.timestamp)+' '+message.text}:message,options);
    }catch(error){
      this.diagnostic('error','channel.receive-failed',{code:error?.code??'unknown',state:'failed'});
      throw error;
    }
  }
  collectGroup(known,conversationId){
    try{
      const snapshot=this.settings.configFile.snapshot();
      const current=snapshot.value;
      if(current.allowedGroups.includes(conversationId))return current.allowedGroups;
      const next={...current,allowedGroups:[...current.allowedGroups,conversationId]};
      this.settings.configFile.save(next,snapshot.revision);
      this.diagnostic('info','channel.group-collected',{state:'ok'});
      return next.allowedGroups;
    }catch(error){
      this.diagnostic('warn','channel.group-collect-failed',{code:error?.code,state:'failed'});
      return null;
    }
  }
  async sessionContext(config,signal){
    const core=this.core??this.ctx.channelCore;
    const resolved=core.resolveSessionWorkspace ? await core.resolveSessionWorkspace(config,signal) : {cwd:await core.resolveWorkspace(config,signal),agentPreset:config.agentPreset};
    // Native session.create accepts workspaceId OR cwd, never both.
    // The cwd remains in the routing scope even when native creation uses the workspace ID.
    const create={...(resolved.workspaceId?{workspaceId:resolved.workspaceId}:{cwd:resolved.cwd}),...(resolved.agentPreset?{agentPreset:resolved.agentPreset}:{})};
    return {create,scope:channelScope({...config,agentPreset:resolved.agentPreset,workspacePath:resolved.cwd})};
  }
  async disconnect(){
    this.abort?.abort();this.abort=null;
    this.ready=false;
    const transport=this.transport;this.transport=null;
    // Closing the SDK also aborts pending connection/REST work before draining delivery.
    await transport?.close().catch(()=>{});
    const unregister=this.unregister;this.unregister=null;await unregister?.();
  }
  async close(){
    if(this.closed)return;this.closed=true;this.generation++;this.abort?.abort();this.unsubscribe();this.credentialDispose();
    await this.tail.catch(()=>{});await this.disconnect();
  }
}
