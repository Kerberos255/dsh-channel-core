import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { CoreStore } from './store.js';
import { IdentityRouter } from './routing.js';
import { Coordinator } from './coordinator.js';
import { CoreError } from './validation.js';
import { randomUUID } from 'node:crypto';
import { ConfigFile, configPath,validateConfig } from './config.js';
import { ChannelBridge } from './bridge.js';
import { deliveryKey } from './delivery-store.js';
import path from 'node:path';
import { realpath,stat } from 'node:fs/promises';
import { configureRuntimeNetwork } from './runtime-network.js';
import { BindingManager } from './binding-manager.js';
import { isOwnerChannelSession } from './memory-access.js';
import { rotateTrustedDM } from './safe-rotate.js';
import { migrateChannelConfigs, registerChannelAdapters } from './channel-components.js';

export default class ChannelCore extends TypertRemoteService {
  // Core bindings and session management must remain available even when optional
  // channel delivery services are not installed. Adapters inject them separately.
  static inject = ['sessionController', 'workspaceController', 'dshHomePath'];
  constructor(ctx, config = {}) {
    super(ctx, 'channelCore');
    if (Object.keys(config).length) throw new CoreError('config-migration', 'Channel Core 配置现由插件目录的 config.json 管理，请将旧参数移入该文件并移除 Cordis config 覆盖');
    this.closed = false;
    this.commandTasks=new Map();
    this.configFile = new ConfigFile(configPath(ctx.dshHomePath()), {
      onError: error => console.warn('[channel-core]', error.code, error.message),
    });
    ctx.effect(() => () => { this.closed = true; this.configFile.close() });
    this.store = new CoreStore(ctx.dshHomePath('channel-core', 'state.sqlite'));
    this.router = new IdentityRouter(this.store, { scope: {
      workspaceId: 'default', presetId: 'default', memoryNamespace: 'private', scheduleNamespace: 'private',
    } });
    this.coordinator = new Coordinator(this.store, {
      prompt: (request, signal) => ctx.sessionController.prompt(request, signal),
      cancel: request => ctx.sessionController.cancel(request),
    });
    this.controller = ctx.sessionController;
    this.bridge = new ChannelBridge(ctx, this);
    ctx.inject(['statusCenter'],scope=>{const service=scope.statusCenter;this.statusCenter=service;scope.effect(()=>()=>{if(this.statusCenter===service)this.statusCenter=null;});});
    this.bindings = new BindingManager(this);
    this.managementReady=Promise.resolve();ctx.inject(['sessionQuery'],()=>{this.managementReady=this.managementReady.then(()=>this.bindings.recover());this.managementReady.catch(()=>{});});
    for (const initialize of remoteInitializers) initialize.call(this);
    this.networkReady = configureRuntimeNetwork(path.resolve(ctx.dshHomePath(), '..')).then(network => {
      if (this.closed) { network.restore(); this.networkRestored = true; }
      this.runtimeNetwork = network;
      return network;
    });
    this.networkReady.catch(() => {});
    this.channelConfigMigration=migrateChannelConfigs(ctx.dshHomePath());
    ctx.inject(['credentials','fileUploads'],scope=>{
      this.channelAdapters=registerChannelAdapters(scope,this);
      scope.effect(()=>()=>{this.channelAdapters=[];});
    });
    ctx.effect(() => async () => { try { await this.bindings.close();await this.managementReady.catch(()=>{});await this.coordinator.close(); await Promise.allSettled(this.commandTasks.values()); await this.bridge.close() } finally { this.store.close(); const network=await this.networkReady.catch(()=>null);if(network&&!this.networkRestored){this.networkRestored=true;network.restore();} } });
  }
  trustedMemorySession(sessionId,ownerIdentityId){return isOwnerChannelSession(this.store,sessionId,ownerIdentityId);}
  rotateTrustedDM(request){return rotateTrustedDM(this,request);}
  getConfig() { return this.configFile.reload() }
  setConfig(value, revision) {
    try {
      const valid=validateConfig(value);if(valid.sharedDM!==this.configFile.value.sharedDM&&this.bindings.state().active.some(row=>row.kind==='dm'))throw new CoreError('binding-review-required','请审阅受影响私聊，明确选择已有会话或新会话后应用共享设置');
      return this.configFile.save(valid, revision)
    }
    catch (error) {
      if (error instanceof CoreError) throw new RemoteError('channel-config/' + error.code, error.message, {});
      throw error;
    }
  }
  async bindingOperation(operation){try{await this.managementReady;return await operation();}catch(error){if(error instanceof CoreError)throw new RemoteError('channel-binding/'+error.code,error.message,{});throw error;}}
  bindingCatalog(){return this.bindingOperation(()=>this.bindings.catalog());}
  previewBindings(request,revision){return this.bindingOperation(()=>this.bindings.preview(request,revision));}
  applyBindings(proposalId,decisions,confirmation){return this.bindingOperation(()=>this.bindings.apply(proposalId,decisions,confirmation));}
  cancelBindings(proposalId){return this.bindingOperation(()=>this.bindings.cancel(proposalId));}
  health({sessionId=''}={}){
    if(this.closed)throw new CoreError('core-closed');
    const where=sessionId?' WHERE session_id=?':'',args=sessionId?[sessionId]:[];
    const rows=this.store.db.prepare('SELECT status AS state,COUNT(*) AS count FROM receipts'+where+' GROUP BY status').all(...args),inputs=Object.fromEntries(rows.map(row=>[row.state,row.count]));
    const waiting=this.store.db.prepare('SELECT COUNT(*) AS count FROM interactions WHERE consumed=0 AND expires_at>?'+(sessionId?' AND session_id=?':'')).get(Date.now(),...args).count;
    return {inputMode:this.configFile.value.defaultMode,inputs,uncertainInputs:inputs.uncertain??0,pendingInteractions:waiting,admissions:sessionId?[...this.coordinator.tails.keys()].filter(id=>id===sessionId).length:this.coordinator.tails.size};
  }
  async resolveWorkspace(config,signal) {
    signal?.throwIfAborted();
    const selected=config.workspacePath||((await this.ctx.workspaceController.initializeDefault(signal??new AbortController().signal))?.workspace.path);
    if(!selected)throw new CoreError('channel-workspace-required','请在客户端登记默认工作区，或填写渠道工作区路径');
    const cwd=await realpath(path.resolve(selected));
    if(!(await stat(cwd)).isDirectory())throw new CoreError('channel-workspace-invalid','渠道工作区必须是已存在的目录');
    signal?.throwIfAborted();return cwd;
  }
  async receive(message, options = {}) {
    if (this.closed) throw new CoreError('core-closed');
    const settings = this.configFile.value;
    const route = this.router.route(options.uploadAttachments && !message.text.trim() ? {...message,text:'（附件消息）'} : message, {
      defaultMode: settings.defaultMode, sharedDM: settings.sharedDM, ...options,
      channelMode: options.channelMode ?? settings.defaultMode,
    });
    const { binding } = route;
    const existing=this.store.db.prepare('SELECT * FROM receipts WHERE key=?').get(route.receiptKey);
    if(existing&&['accepted','settled'].includes(existing.status)){
      if(existing.digest!==deliveryKey(options.idempotencyPayload??route.message))throw new CoreError('receipt-conflict');
      return {accepted:true,duplicate:true,sessionId:existing.session_id,bindingId:JSON.parse(existing.origin).bindingId};
    }
    const create = options.create ?? {};
    if (binding.scope.workspaceId !== 'default' && (options.workspaceScope ?? create.workspaceId) !== binding.scope.workspaceId) throw new CoreError('workspace-scope-mismatch');
    if (binding.scope.presetId !== 'default' && create.agentPreset !== binding.scope.presetId) throw new CoreError('preset-scope-mismatch');
    const content = [{ type: 'text', text: route.message.text }, ...route.message.attachments.map(a => ({ type: 'file', receiptId: a.receiptId }))];
    const value = await this.coordinator.admit({
      sessionId: binding.sessionId, requestId: options.requestId ?? 'channel-' + randomUUID(), content,
    }, {
      key: route.receiptKey, payload: options.idempotencyPayload ?? route.message,
      origin: { bindingId: binding.id, ...Object.fromEntries(['userId','provider','accountId','conversationId','threadId','messageId'].filter(key=>route.message[key]!==undefined).map(key=>[key,route.message[key]])) },
      policy: route.inboundMode, signal: options.signal,
      prepare: async () => {
        await this.controller.create({ ...create, sessionId: binding.sessionId });
        if(options.uploadAttachments){
          const files=await options.uploadAttachments(binding.sessionId);
          content.splice(0,content.length,...(message.text.trim()?[{type:'text',text:message.text}]:[]),...files.map(file=>({type:'file',receiptId:file.receiptId})));
        }
      },
    });
    return { ...value, sessionId: binding.sessionId, bindingId: binding.id };
  }
  async command(message,command,args,options={}){
    if(this.closed)throw new CoreError('core-closed');options.signal?.throwIfAborted();
    const route=this.router.route({...message,text:message.text||'/'+command},{...options,defaultMode:this.configFile.value.defaultMode,sharedDM:this.configFile.value.sharedDM});
    const origin={...route.message,bindingId:route.binding.id};
    if(command==='answer')return this.bridge.answerText(origin,args);
    if(this.commandTasks.has(route.receiptKey))return this.commandTasks.get(route.receiptKey);
    const record=this.bridge.store.command(route.receiptKey,options.idempotencyPayload??message,{origin,binding:route.binding,create:options.create??{},mode:route.inboundMode});
    if(record.result)return {...record.result,duplicate:true};
    const task=(async()=>{
      const {origin,binding,create,mode}=record.request;
      if(command==='stop')await this.controller.cancel({sessionId:binding.sessionId});
      let sessionId=binding.sessionId;
      let text=command==='stop'?'已按 DSH 原生行为停止当前轮次。':command==='session'?'当前会话：'+sessionId:'渠道已连接；输入方式：'+mode;
      if(command==='status'&&this.statusCenter)text=await this.statusCenter.channelStatus(sessionId,{provider:origin.provider,accountId:origin.accountId},mode);
      if(command==='new'){
        if(args.trim())throw new CoreError('new-command-arguments');
        sessionId='session-'+deliveryKey([route.receiptKey,'new']).slice(0,32);
        await this.controller.create({...create,sessionId});
        this.store.rebindScope(binding.sessionId,sessionId,binding.scope);
        text='已创建新会话：'+sessionId;
      }else if(command==='session'&&args.trim()){
        sessionId=args.trim();
        if(!this.sessions(origin,binding).includes(sessionId))throw new CoreError('session-not-owned-by-channel');
        this.store.rebindScope(binding.sessionId,sessionId,binding.scope);
        text='已切换会话：'+sessionId;
      }
      this.bridge.reply(origin,{id:deliveryKey([route.receiptKey,'reply']),text,status:'completed',final:true});
      const result={accepted:true,sessionId};this.bridge.store.finishCommand(route.receiptKey,result);return result;
    })();
    this.commandTasks.set(route.receiptKey,task);
    try{return await task;}finally{this.commandTasks.delete(route.receiptKey);}
  }
  sessions(origin,binding){
    const rows=this.store.db.prepare('SELECT request,result FROM channel_commands WHERE result IS NOT NULL ORDER BY created_at DESC LIMIT 1000').all();
    const ids=[binding.sessionId];
    for(const row of rows){const request=JSON.parse(row.request),result=JSON.parse(row.result),from=request.origin;
      if(from&&from.provider===origin.provider&&from.accountId===origin.accountId&&from.conversationId===origin.conversationId&&(from.threadId??'')===(origin.threadId??'')&&JSON.stringify(request.binding.scope)===JSON.stringify(binding.scope)&&result.sessionId)ids.push(result.sessionId);
    }
    return [...new Set(ids)].slice(0,25);
  }
  channelSessions(message,options){const route=this.router.route({...message,text:'/session'},{...options,defaultMode:this.configFile.value.defaultMode,sharedDM:this.configFile.value.sharedDM});return this.sessions(route.message,route.binding);}
}

// Apply the public standard-decorator API without a build step or private metadata.
const remoteInitializers = [];
for (const name of ['getConfig', 'setConfig','bindingCatalog','previewBindings','applyBindings','cancelBindings']) {
  Remote(ChannelCore.prototype[name], { kind: 'method', name, static: false, private: false,
    addInitializer: initialize => remoteInitializers.push(initialize),
  });
}
