import { createHash,randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { CoreError,id,mode } from './validation.js';
import { routeKeys } from './routing.js';
import { validateConfig } from './config.js';
import { channelScope } from './channel-runtime.js';

const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const aliasKey=a=>JSON.stringify([a.provider,a.accountId,a.userId]);
const sameScope=(a,b)=>['workspaceId','presetId','memoryNamespace','scheduleNamespace'].every(key=>a[key]===b[key]);
const clean=value=>JSON.parse(JSON.stringify(value));
const fail=(code,message)=>{throw new CoreError(code,message);};

/** Authenticated Host management. Channel callers cannot reach these methods. */
export class BindingManager {
 constructor(core,{now=()=>Date.now()}={}){
  this.core=core;this.store=core.store;this.now=now;this.abort=new AbortController();this.tasks=new Set();this.queue=Promise.resolve();this.closed=false;
  this.store.db.exec(`CREATE TABLE IF NOT EXISTS binding_proposals(id TEXT PRIMARY KEY,created INTEGER NOT NULL,expires INTEGER NOT NULL,state TEXT NOT NULL,plan TEXT NOT NULL,result TEXT);`);
 }
 state(){
  const db=this.store.db,aliases=db.prepare('SELECT a.*,v.verified_at,v.verified_by FROM aliases a LEFT JOIN alias_verifications v ON a.provider=v.provider AND a.account_id=v.account_id AND a.user_id=v.user_id ORDER BY a.provider,a.account_id,a.user_id').all().map(row=>({provider:row.provider,accountId:row.account_id,userId:row.user_id,identityId:row.identity_id,verified:!!row.verified,verifiedAt:row.verified_at??null,verifiedBy:row.verified_by??null}));
  const configured=db.prepare('SELECT * FROM channel_alias_config ORDER BY provider,account_id,user_id').all(),bindings=db.prepare('SELECT * FROM bindings ORDER BY binding_key').all().map(row=>({...JSON.parse(row.data),key:row.binding_key,id:row.id,sessionId:row.session_id,revision:row.revision}));
  // Old bindings did not store their DM owner. Read only receipt metadata once
  // for those rows; no conversation text or cold Agent activation is needed.
  if(bindings.some(row=>row.kind==='dm'&&!row.userId)){
   const owners=db.prepare("SELECT DISTINCT json_extract(origin,'$.bindingId') AS bindingId,json_extract(origin,'$.userId') AS userId FROM receipts WHERE json_valid(origin)").all();
   for(const binding of bindings)if(binding.kind==='dm'&&!binding.userId){const ids=[...new Set(owners.filter(row=>row.bindingId===binding.id&&row.userId).map(row=>row.userId))];if(ids.length===1)binding.userId=ids[0];}
  }
  const maps=new Map(aliases.map(alias=>[aliasKey(alias),alias])),settings=this.core.configFile.snapshot();
  for(const alias of aliases)alias.source=configured.some(row=>row.provider===alias.provider&&row.account_id===alias.accountId&&row.user_id===alias.userId)?'channel-config':'host';
  const active=bindings.filter(binding=>{
   if(binding.kind!=='dm')return routeKeys(binding,binding.scope,settings.value.sharedDM).bindingKey===binding.key;
   const alias=maps.get(aliasKey(binding));return alias&&alias.identityId===binding.scope.identityId&&routeKeys(binding,binding.scope,settings.value.sharedDM).bindingKey===binding.key;
  });
  const channels=['discord','feishu'].map(provider=>this.core.ctx.get(provider+'ChannelSettings')?.configFile.snapshot().revision??null);
  const dbRevision=hash([aliases,bindings,db.prepare('SELECT * FROM scope_sessions ORDER BY scope_key').all(),configured,channels]);
  return {aliases,bindings,active,settings,dbRevision,revision:hash([dbRevision,settings.revision])};
 }
 async routingState(){
  const state=this.state(),scopes=new Map();
  for(const provider of ['discord','feishu']){
   const settings=this.core.ctx.get(provider+'ChannelSettings');if(!settings)continue;
   const config=settings.configFile.value,cwd=await this.core.resolveWorkspace(config,this.abort.signal);
   scopes.set(provider,{accountId:config.accountId,scope:channelScope({...config,workspacePath:cwd})});
  }
  this.check();if(this.state().revision!==state.revision)fail('binding-conflict','读取时渠道配置或绑定已变化，请刷新');
  state.historical=state.bindings.filter(binding=>!state.active.includes(binding)||scopes.has(binding.provider)&&(binding.accountId!==scopes.get(binding.provider).accountId||!sameScope(binding.scope,scopes.get(binding.provider).scope)));
  state.active=state.active.filter(binding=>!state.historical.includes(binding));return state;
 }
 async catalog(){
  this.check();const state=await this.routingState(),describe=binding=>({...binding,activity:this.core.ctx.get('agents')?.get(binding.sessionId)?.status??'inactive'});
  return clean({revision:state.revision,aliases:state.aliases.slice(0,500),bindings:state.active.slice(0,500).map(describe),historical:state.historical.slice(0,500).map(describe),aliasCount:state.aliases.length,bindingCount:state.active.length,truncated:state.aliases.length>500||state.active.length>500,proposals:this.store.db.prepare("SELECT id,created,expires,state,result FROM binding_proposals WHERE state='needs-review' ORDER BY created DESC LIMIT 20").all()});
 }
 check(){if(this.closed||this.core.closed)fail('management-closed','渠道管理已停用');this.abort.signal.throwIfAborted();}
 async operation(fn){this.check();const task=fn();this.tasks.add(task);try{return await task;}finally{this.tasks.delete(task);}}
 mutate(fn){const task=this.queue.then(()=>{this.check();return fn();});this.queue=task.catch(()=>{});return this.operation(()=>task);}
 checkHeader(scope,header){if(scope.workspaceId.startsWith('path-')&&channelScope({workspacePath:header.cwd,agentPreset:scope.presetId,memoryNamespace:scope.memoryNamespace}).workspaceId!==scope.workspaceId)fail('workspace-scope-mismatch','会话的实际工作区已改变，请重新核对渠道路径');if(scope.presetId!=='default'&&header.agentPreset!==scope.presetId)fail('preset-scope-mismatch','会话预设已改变，请在渠道页核对');}
 header(sessionId){return this.operation(async()=>{
  const query=this.core.ctx.get('sessionQuery');if(!query)fail('management-unavailable','原生会话查询服务尚未就绪');
  const observation=await query.observeSession(sessionId,{signal:this.abort.signal});
  try{if(!observation.header.cwd||observation.header.parentSession)fail('binding-session-invalid','目标必须是具有工作区的根会话');
   const cwd=fs.realpathSync(observation.header.cwd);if(!fs.statSync(cwd).isDirectory())fail('binding-workspace-invalid','会话工作区必须是目录');return {cwd,agentPreset:observation.projections.values.agentPreset??observation.header.agentPreset??''};
  }finally{observation[Symbol.dispose]?.();}
 });}
 history(members){
  const found=new Set(members.map(row=>row.sessionId)),rows=this.store.db.prepare("SELECT request,result FROM channel_commands WHERE result IS NOT NULL ORDER BY created_at DESC LIMIT 1000").all();
  for(const row of rows){const request=JSON.parse(row.request),result=JSON.parse(row.result);if(members.some(member=>request.origin?.provider===member.provider&&request.origin.accountId===member.accountId&&request.origin.conversationId===member.conversationId&&(request.origin.threadId??'')===(member.threadId??'')&&sameScope(request.binding.scope,member.scope)&&request.binding.scope.identityId===member.scope.identityId)){if(request.binding.sessionId)found.add(request.binding.sessionId);if(result.sessionId)found.add(result.sessionId);}}
  return [...found].slice(0,25);
 }
 async preview(request,revision){return this.operation(async()=>{
  const before=await this.routingState();if(before.revision!==revision)fail('binding-conflict','身份或会话绑定已变化，请重新读取');
  if(!request||typeof request!=='object'||!['link','unlink','binding','sharing'].includes(request.kind))fail('invalid-management','管理操作无效');
  const changes=[],map=new Map(before.aliases.map(alias=>[aliasKey(alias),alias.identityId]));let affected=[],shared=before.settings.value.sharedDM,modeChange=null;
  if(request.kind==='link'||request.kind==='unlink'){
   if(!Array.isArray(request.aliases)||!request.aliases.length||request.aliases.length>20||request.aliases.some(alias=>!alias||typeof alias!=='object')||request.kind==='unlink'&&request.aliases.length!==1)fail('invalid-alias-selection','请选择需要核验的账号');
   const keys=[...new Set(request.aliases.map(aliasKey))];if(keys.length!==request.aliases.length)fail('invalid-alias-selection','账号不能重复');
   const selected=keys.map(key=>{const alias=before.aliases.find(row=>aliasKey(row)===key);if(!alias)fail('alias-not-observed','请先让该账号向机器人发送消息，再选择已验证的渠道账号');if(alias.source==='channel-config')fail('alias-config-owned','此映射由渠道配置管理，请先在对应渠道页修改身份绑定');return alias;});
   const identityId=request.kind==='unlink'?'identity-'+randomUUID():request.identityId?.trim()||'identity-'+randomUUID();id(identityId,'identity');
   for(const alias of selected){changes.push({...alias,after:identityId,verified:request.kind!=='unlink'});map.set(aliasKey(alias),identityId);}
   if(request.kind==='link')for(const alias of before.aliases)if(alias.identityId===identityId&&!alias.verified&&!keys.includes(aliasKey(alias))){if(alias.source==='channel-config')fail('alias-config-owned','现有目标身份需要先在渠道配置中核验');changes.push({...alias,after:identityId,verified:true});}
   const involved=new Set([...keys,...before.aliases.filter(alias=>alias.identityId===identityId).map(aliasKey)]);affected=before.active.filter(row=>row.kind==='dm'&&involved.has(aliasKey(row)));
  }else if(request.kind==='sharing'){
   if(typeof request.sharedDM!=='boolean'||request.sharedDM===shared)fail('invalid-management','请选择不同的私聊共享设置');shared=request.sharedDM;affected=before.active.filter(row=>row.kind==='dm');
  }else{
   const binding=before.active.find(row=>row.id===request.bindingId);if(!binding)fail('binding-not-current','该绑定不是当前路由，请重新读取');
   if(request.inputMode!==undefined&&request.inputMode!=='inherit')mode(request.inputMode);
   modeChange=request.inputMode===undefined?null:{id:binding.id,value:request.inputMode};const key=JSON.parse(binding.key)[4];affected=before.active.filter(row=>JSON.parse(row.key)[4]===key);
  }
  if(affected.length>250)fail('management-limit','受影响绑定过多，请按账号分批管理');
  const groups=new Map();
  for(const member of affected){const scope={...member.scope,identityId:member.kind==='dm'?map.get(aliasKey(member)):member.scope.identityId},keys=routeKeys(member,scope,shared);let group=groups.get(keys.routeKey);
   if(!group){group={id:hash(keys.routeKey),routeKey:keys.routeKey,scope,members:[],options:[],newSessionId:'session-'+randomUUID()};groups.set(keys.routeKey,group);}
   group.members.push({...member,scope,nextKey:keys.bindingKey});
  }
  for(const group of groups.values()){
   const original=group.members.map(member=>before.active.find(row=>row.id===member.id));group.options=this.history(original);group.currentSessions=[...new Set(original.map(row=>row.sessionId))];
   const header=await this.header(group.currentSessions[0]);this.checkHeader(group.scope,header);group.header=header;
   for(const sessionId of group.currentSessions.slice(1)){const other=await this.header(sessionId);if(other.cwd.toLowerCase()!==header.cwd.toLowerCase()||other.agentPreset!==header.agentPreset)fail('workspace-scope-mismatch','受影响会话的实际工作区或预设不一致');}
  }
  if(this.state().revision!==before.revision)fail('binding-conflict','准备审阅时绑定已变化，请重新操作');
  const newConfig=request.kind==='sharing'&&request.config?validateConfig(request.config):{...before.settings.value,sharedDM:shared};if(newConfig.sharedDM!==shared)fail('invalid-management','共享设置不一致');
  const plan={kind:request.kind,changes,groups:[...groups.values()],modeChange,sharedDM:shared,newConfig,beforeDb:before.dbRevision,beforeConfig:before.settings,beforeRevision:before.revision};
  const proposalId=randomUUID(),expires=this.now()+600000;this.store.db.prepare("INSERT INTO binding_proposals VALUES(?,?,?,'pending',?,NULL)").run(proposalId,this.now(),expires,JSON.stringify(plan));
  this.store.db.prepare("DELETE FROM binding_proposals WHERE state IN ('pending','applied') AND expires<?").run(this.now()-86400000);
  return clean({id:proposalId,revision:before.revision,expires,kind:plan.kind,aliases:changes,groups:plan.groups.map(group=>({id:group.id,scope:group.scope,workspace:group.header.cwd,members:group.members.map(member=>({id:member.id,provider:member.provider,accountId:member.accountId,userId:member.userId??'',conversationId:member.conversationId,threadId:member.threadId??'',sessionId:member.sessionId,revision:member.revision})),options:group.options,currentSessions:group.currentSessions})),sharedDM:shared,modeChange});
 });}
 cancel(proposalId){return this.mutate(()=>{
  const row=this.store.db.prepare('SELECT state FROM binding_proposals WHERE id=?').get(proposalId);if(!row)fail('management-missing','审阅记录不存在');
  if(row.state==='cancelled')return {cancelled:true};
  if(!['pending','needs-review'].includes(row.state))fail('management-settled','此审阅已经应用或正在提交');
  this.store.db.prepare("UPDATE binding_proposals SET state='cancelled',result=NULL WHERE id=?").run(proposalId);return {cancelled:true};
 });}
 async apply(proposalId,decisions,confirmation){return this.mutate(async()=>{
  if(confirmation!==proposalId)fail('management-confirmation','请审阅受影响账号与会话后确认应用');
  const row=this.store.db.prepare('SELECT * FROM binding_proposals WHERE id=?').get(proposalId);if(!row)fail('management-missing','审阅记录不存在');if(row.state==='applied')return JSON.parse(row.result);
  if(row.state!=='pending'||row.expires<this.now())fail('management-expired','审阅记录已过期，请重新操作');const plan=JSON.parse(row.plan);
  if(this.state().revision!==plan.beforeRevision)fail('binding-conflict','身份、配置或绑定已变化，请重新审阅');
  if(!Array.isArray(decisions)||decisions.length!==plan.groups.length||new Set(decisions.map(value=>value?.id)).size!==decisions.length)fail('invalid-binding-decisions','请为每组选择已有会话或新会话');
  const used=new Map();for(const group of plan.groups){const choice=decisions.find(value=>value.id===group.id)?.sessionId;if(choice!=='new'&&!group.options.includes(choice))fail('binding-session-not-owned','只能选择受影响账号在同一范围内的已有会话');group.selected=choice==='new'?group.newSessionId:choice;
   if(used.has(group.selected)&&used.get(group.selected)!==group.routeKey)fail('binding-scope-collision','不同路由范围应选择各自的会话');used.set(group.selected,group.routeKey);
   if(choice!=='new'){const header=await this.header(choice);if(header.cwd.toLowerCase()!==group.header.cwd.toLowerCase()||header.agentPreset!==group.header.agentPreset)fail('workspace-scope-mismatch','目标会话的实际工作区或预设不一致');}
  }
  if(this.state().revision!==plan.beforeRevision)fail('binding-conflict','核验目标时绑定已变化，请重新审阅');
  this.store.db.prepare("UPDATE binding_proposals SET state='committing',plan=? WHERE id=? AND state='pending'").run(JSON.stringify(plan),proposalId);
  return this.commit(proposalId,plan);
 });}
 async commit(proposalId,plan,recovery=false){
  try{
   const initial=this.state();if(initial.dbRevision!==plan.beforeDb||![plan.beforeConfig.revision,hashConfig(plan.newConfig)].includes(initial.settings.revision))fail('binding-conflict','审阅后的绑定或配置已变化，请重新核对');
   for(const group of plan.groups)if(group.selected===group.newSessionId){
    // The preassigned ID survives a crash between native create and SQLite commit.
    const records=await this.core.ctx.get('sessionQuery')?.listSessions(this.abort.signal);const existing=records?.find(row=>row.header.id===group.selected);
    if(existing){const header=await this.header(group.selected);if(header.cwd.toLowerCase()!==group.header.cwd.toLowerCase()||header.agentPreset!==group.header.agentPreset)fail('workspace-scope-mismatch','准备中的会话被其他操作修改');}
    else await this.core.controller.create({sessionId:group.selected,cwd:group.header.cwd,...group.header.agentPreset?{agentPreset:group.header.agentPreset}:{}},this.abort.signal);
   }
   for(const group of plan.groups)if(group.selected!==group.newSessionId){const header=await this.header(group.selected);if(header.cwd.toLowerCase()!==group.header.cwd.toLowerCase()||header.agentPreset!==group.header.agentPreset)fail('workspace-scope-mismatch','目标会话的工作区或预设已改变');}
   const current=this.state(),newConfig=plan.newConfig,afterConfig=hashConfig(newConfig);
   if(current.dbRevision!==plan.beforeDb||![plan.beforeConfig.revision,afterConfig].includes(current.settings.revision))fail('binding-conflict','审阅后的绑定或配置已变化，请重新核对');
   if(current.settings.revision!==afterConfig&&plan.sharedDM!==plan.beforeConfig.value.sharedDM)this.core.configFile.save(newConfig,plan.beforeConfig.revision);
   this.check();const result={applied:true,id:proposalId,bindings:plan.groups.reduce((count,group)=>count+group.members.length,0),aliases:plan.changes.length,sharedDM:plan.sharedDM};
   this.store.tx(()=>{
    if(this.state().dbRevision!==plan.beforeDb)fail('binding-conflict','提交前绑定已变化');
    for(const alias of plan.changes){this.store.db.prepare('UPDATE aliases SET identity_id=?,verified=? WHERE provider=? AND account_id=? AND user_id=?').run(alias.after,alias.verified?1:0,alias.provider,alias.accountId,alias.userId);if(alias.verified)this.store.db.prepare('INSERT INTO alias_verifications VALUES(?,?,?,?,?) ON CONFLICT(provider,account_id,user_id) DO UPDATE SET verified_at=excluded.verified_at,verified_by=excluded.verified_by').run(alias.provider,alias.accountId,alias.userId,this.now(),'authenticated-web');else this.store.db.prepare('DELETE FROM alias_verifications WHERE provider=? AND account_id=? AND user_id=?').run(alias.provider,alias.accountId,alias.userId);}
    for(const group of plan.groups){for(const member of group.members){const previous=this.store.binding(member.nextKey),data={...member,sessionId:group.selected};for(const key of ['id','key','revision','nextKey'])delete data[key];if(plan.modeChange?.id===member.id){if(plan.modeChange.value==='inherit')delete data.inboundMode;else data.inboundMode=plan.modeChange.value;}
      this.store.db.prepare('INSERT INTO bindings VALUES(?,?,?,?,?) ON CONFLICT(binding_key) DO UPDATE SET session_id=excluded.session_id,data=excluded.data,revision=excluded.revision').run(member.nextKey,previous?.id??'binding-'+randomUUID(),group.selected,JSON.stringify(data),(previous?.revision??0)+1);
     }this.store.db.prepare('INSERT INTO scope_sessions VALUES(?,?) ON CONFLICT(scope_key) DO UPDATE SET session_id=excluded.session_id').run(group.routeKey,group.selected);}
    this.store.db.prepare('INSERT INTO audit(kind,detail,at) VALUES(?,?,?)').run('binding-management',JSON.stringify({operator:'authenticated-web',proposalId,kind:plan.kind,changes:plan.changes,decisions:plan.groups.map(group=>({scope:group.scope,sessionId:group.selected})),recovery}),this.now());
    this.store.db.prepare("UPDATE binding_proposals SET state='applied',result=? WHERE id=?").run(JSON.stringify(result),proposalId);
   });return result;
  }catch(error){this.store.db.prepare("UPDATE binding_proposals SET state='needs-review',result=? WHERE id=? AND state='committing'").run(JSON.stringify({error:error.message}),proposalId);throw error;}
 }
 async recover(){return this.mutate(async()=>{
  for(const row of this.store.db.prepare("SELECT * FROM binding_proposals WHERE state='committing' ORDER BY created").all()){const plan=JSON.parse(row.plan);try{await this.commit(row.id,plan,true);}catch{/* visible in management catalog; never replay a conflicting plan */}}
 });}
 async close(){if(this.closed)return;this.closed=true;this.abort.abort();await Promise.allSettled([...this.tasks]);}
}
function hashConfig(value){return createHash('sha256').update(JSON.stringify(value,null,2)+'\n').digest('hex');}
