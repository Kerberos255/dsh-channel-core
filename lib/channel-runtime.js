import path from 'node:path';
import { createHash } from 'node:crypto';
import { credentialRef } from '@deepseek-ai/dsh-credentials';

export function allowed(message,config) {
  if(message.kind==='dm')return config.dmPolicy!=='disabled'&&(config.dmPolicy==='all'||config.allowedUsers.includes(message.userId)||config.ownerMode==='first-dm'&&!config.allowedUsers.length||config.ownerMode==='manual'&&config.ownerUserId===message.userId);
  if(!config.allowGroups)return false;
  if(config.groupPolicy!=='all'&&(!config.allowedUsers.includes(message.userId)||!config.allowedGroups.includes(message.conversationId)))return false;
  return !config.requireMention||message.mentionedBot;
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
export class ChannelRuntime {
  constructor(ctx,settings,{provider,credentialRefs,createTransport,core}) {
    this.ctx=ctx;this.settings=settings;this.provider=provider;this.credentialRefs=credentialRefs;this.createTransport=createTransport;this.core=core??ctx.channelCore;
    this.closed=false;this.generation=0;this.transport=null;this.unregister=null;this.abort=null;this.tail=Promise.resolve();this.message='渠道连接未启用';
    this.reconnects=0;this.connectedAt=null;this.lastEventAt=null;this.lastDisconnectAt=null;
    this.unsubscribe=settings.configFile.subscribe(()=>this.reconfigure());
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
    this.tail=this.tail.catch(()=>{}).then(()=>this.configure(generation)).catch(()=>{if(!this.closed&&generation===this.generation)this.message='连接失败：请检查凭证、权限或网络';});
    return this.tail;
  }
  async configure(generation){
    await this.disconnect();
    if(this.closed||generation!==this.generation)return;
    const config=this.settings.configFile.value;
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
        receive:message=>this.receive(message,config,transport,abort.signal),
        state:(message,connected)=>{if(generation===this.generation){this.message=message;if(typeof connected==='boolean'){if(connected&&!this.ready){this.connectedAt=Date.now();if(this.lastDisconnectAt)this.reconnects++;}if(!connected&&this.ready)this.lastDisconnectAt=Date.now();this.ready=connected;}}},
        action:request=>(this.core??this.ctx.channelCore).bridge.answer({...request,provider:this.provider,accountId:config.accountId}),
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
  async receive(message,config,transport,signal){
    if(this.closed||signal.aborted||!allowed(message,config))return {ignored:true};
    if(message.kind==='dm'){
      const store=(this.core??this.ctx.channelCore).store;
      if(config.ownerMode==='first-dm')store.claimOwner(message);
      else if(config.ownerMode==='manual')store.setOwner(this.provider,config.accountId,config.ownerUserId);
    }
    this.lastEventAt=Date.now();
    const {create,scope}=await this.sessionContext(config,signal);
    const options={signal,create,scope,workspaceScope:scope.workspaceId,channelMode:config.inputMode==='inherit'?undefined:config.inputMode,
      idempotencyPayload:{...message,resources:message.resources??[]},
      uploadAttachments:message.resources?.length?sessionId=>transport.upload(message,sessionId,this.ctx.fileUploads,signal):undefined,
    };
    const command=message.text.trim().match(/^\/(new|stop|status|session|answer)(?:\s+([\s\S]*))?$/);
    if(command)return (this.core??this.ctx.channelCore).command(message,command[1],command[2]??'',options,transport);
    return (this.core??this.ctx.channelCore).receive(message,options);
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
