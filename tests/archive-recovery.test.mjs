import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CoreStore } from '../lib/store.js';
import { IdentityRouter,routeKeys } from '../lib/routing.js';
import { ArchivedSessionRecovery,isNativeArchived } from '../lib/archived-session-recovery.js';

const scope={workspaceId:'workspace',presetId:'agent',memoryNamespace:'private',scheduleNamespace:'private'};
const input=(provider,messageId)=>({provider,accountId:provider+'-bot',conversationId:provider+'-chat',userId:provider+'-owner',messageId,kind:'dm',text:'hello',attachments:[],timestamp:1791595200});
function setup(){
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-archive-recovery-')),storages=path.join(folder,'storages');
 fs.mkdirSync(storages,{recursive:true});
 const filename=path.join(storages,'workspace.json');
 const setArchived=ids=>fs.writeFileSync(filename,JSON.stringify({unit:{name:'workspace',version:2},global:{archivedSessionIds:ids}}));
 setArchived([]);
 const store=new CoreStore(':memory:'),router=new IdentityRouter(store,{scope}),created=[];
 const controller={async create(value){created.push(value);return{sessionId:value.sessionId}}};
 const homePath=(...parts)=>path.join(folder,...parts);
 const recovery=new ArchivedSessionRecovery({store,router,controller,homePath,getSharedDM:()=>true});
 const options={scope,sharedDM:true};
 return {folder,store,router,created,controller,recovery,options,setArchived,homePath,close(){store.close();fs.rmSync(folder,{recursive:true,force:true});}};
}
test('native archive detection uses the latest DSH workspace registry without mutating it',()=>{
 const f=setup();try{
  assert.equal(isNativeArchived(f.homePath,'a'),false);
  f.setArchived(['a']);assert.equal(isNativeArchived(f.homePath,'a'),true);
  f.setArchived([]);assert.equal(isNativeArchived(f.homePath,'a'),false);
  fs.writeFileSync(path.join(f.folder,'storages','workspace.json'),'not json');
  assert.throws(()=>isNativeArchived(f.homePath,'a'),{code:'native-archive-invalid'});
 }finally{f.close();}
});

test('an archived private Session is replaced once for linked Feishu and Discord, even under concurrent messages',async()=>{
 const f=setup();try{
  const feishu=input('feishu','f-1'),discord=input('discord','d-1');
  const first=f.router.route(feishu,f.options);
  f.store.verifyAlias(discord,first.binding.scope.identityId,'local-operator');
  const second=f.router.route(discord,f.options);
  assert.equal(first.binding.sessionId,second.binding.sessionId);
  f.setArchived([first.binding.sessionId]);
  const [a,b]=await Promise.all([
   f.recovery.recover(first,f.options,{cwd:f.folder,agentPreset:'agent'}),
   f.recovery.recover(second,f.options,{cwd:f.folder,agentPreset:'agent'}),
  ]);
  assert.equal(f.created.length,1);
  assert.notEqual(a.binding.sessionId,first.binding.sessionId);
  assert.equal(a.binding.sessionId,b.binding.sessionId);
  assert.equal(f.router.route(feishu,f.options).binding.sessionId,a.binding.sessionId);
  assert.equal(f.router.route(discord,f.options).binding.sessionId,a.binding.sessionId);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS count FROM audit WHERE kind=?').get('auto-archived-session-rebind').count,1);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS count FROM bindings WHERE session_id=?').get(first.binding.sessionId).count,0);
 }finally{f.close();}
});

test('non-archived input preserves its Session and does not create an extra Session',async()=>{
 const f=setup();try{
  const current=f.router.route(input('feishu','fresh'),f.options);
  const result=await f.recovery.recover(current,f.options,{cwd:f.folder});
  assert.equal(result.binding.sessionId,current.binding.sessionId);
  assert.equal(f.created.length,0);
 }finally{f.close();}
});

test('failed native session creation leaves archived bindings untouched and allows retry',async()=>{
 const f=setup();try{
  const msg=input('feishu','failure'),route=f.router.route(msg,f.options);
  f.setArchived([route.binding.sessionId]);
  f.controller.create=async()=>{throw new Error('native-create-rejected')};
  await assert.rejects(f.recovery.recover(route,f.options,{cwd:f.folder}),/native-create-rejected/);
  assert.equal(f.router.route(msg,f.options).binding.sessionId,route.binding.sessionId);
  f.controller.create=async data=>{f.created.push(data);return{sessionId:data.sessionId}};
  const result=await f.recovery.recover(route,f.options,{cwd:f.folder});
  assert.notEqual(result.binding.sessionId,route.binding.sessionId);
  assert.equal(f.created.length,1);
 }finally{f.close();}
});

test('group/thread routes heal independently and do not overwrite another scope',async()=>{
 const f=setup();try{
  const group={...input('discord','guild-1'),kind:'group',conversationId:'guild-a'};
  const thread={...group,messageId:'thread-1',kind:'thread',threadId:'topic-1'};
  const a=f.router.route(group,f.options),b=f.router.route(thread,f.options);
  assert.notEqual(a.binding.sessionId,b.binding.sessionId);
  f.setArchived([a.binding.sessionId,b.binding.sessionId]);
  const newGroup=await f.recovery.recover(a,f.options,{cwd:f.folder});
  assert.notEqual(newGroup.binding.sessionId,a.binding.sessionId);
  assert.equal(f.router.route(thread,f.options).binding.sessionId,b.binding.sessionId);
  const newThread=await f.recovery.recover(b,f.options,{cwd:f.folder});
  assert.notEqual(newThread.binding.sessionId,b.binding.sessionId);
  assert.notEqual(newThread.binding.sessionId,newGroup.binding.sessionId);
  assert.equal(f.created.length,2);
 }finally{f.close();}
});

test('normal Channel Core admission sends the triggering message into the newly created Session',async()=>{
 const f=setup();try{
  const { Coordinator }=await import('../lib/coordinator.js');
  const { default: ChannelCore }=await import('../lib/index.js');
  const message=input('feishu','trigger-1');
  const old=f.router.route(message,f.options).binding.sessionId;
  f.setArchived([old]);
  const prompted=[];
  const coordinator=new Coordinator(f.store,{prompt:async request=>{prompted.push(request);return{accepted:true};},cancel:()=>{}});
  try{
   const core={closed:false,store:f.store,router:f.router,controller:f.controller,archivedRecovery:f.recovery,coordinator,configFile:{value:{defaultMode:'steering',sharedDM:true}}};
   const accepted=await ChannelCore.prototype.receive.call(core,message,{scope,create:{cwd:f.folder,agentPreset:'agent'},workspaceScope:scope.workspaceId});
   assert.equal(accepted.accepted,true);
   assert.notEqual(accepted.sessionId,old);
   assert.equal(prompted.length,1);
   assert.equal(prompted[0].sessionId,accepted.sessionId);
   assert.deepEqual(prompted[0].content,[{type:'text',text:message.text}]);
   assert.equal(f.router.route(message,f.options).binding.sessionId,accepted.sessionId);
   const receipt=f.store.db.prepare('SELECT status,session_id FROM receipts LIMIT 1').get();
   assert.equal(receipt.status,'accepted');
   assert.equal(receipt.session_id,accepted.sessionId);
   assert(f.created.length>=1);
   assert(f.created.every(item=>item.sessionId===accepted.sessionId));
  }finally{await coordinator.close();}
 }finally{f.close();}
});

test('real channel sessionContext and archive recovery satisfy native create workspaceId/cwd exclusivity',async()=>{
 const f=setup();try{
  const {ChannelRuntime}=await import('../lib/channel-runtime.js');
  const {Coordinator}=await import('../lib/coordinator.js');
  const {default:ChannelCore}=await import('../lib/index.js');
  const config={workspacePath:'',agentPreset:'agent',memoryNamespace:'private'};
  const runtime={core:{resolveSessionWorkspace:async()=>({cwd:f.folder,workspaceId:'native-workspace',agentPreset:'agent'})}};
  const {create,scope:actualScope}=await ChannelRuntime.prototype.sessionContext.call(runtime,config);
  assert.deepEqual(create,{workspaceId:'native-workspace',agentPreset:'agent'});
  const message=input('feishu','native-contract-1'),routing={...f.options,scope:actualScope};
  const old=f.router.route(message,routing).binding.sessionId;
  f.setArchived([old]);
  f.controller.create=async options=>{
   if('cwd' in options&&'workspaceId' in options)throw new Error('session.create accepts workspaceId or cwd, not both');
   assert.equal(options.workspaceId,'native-workspace');
   f.created.push(options);return {sessionId:options.sessionId};
  };
  const queued=[];
  const coordinator=new Coordinator(f.store,{prompt:async req=>{queued.push(req);return {accepted:true}},cancel:()=>{}});
  try{
   const core={closed:false,store:f.store,router:f.router,controller:f.controller,archivedRecovery:f.recovery,coordinator,configFile:{value:{defaultMode:'steering',sharedDM:true}}};
   const outcome=await ChannelCore.prototype.receive.call(core,message,{scope:actualScope,create,workspaceScope:actualScope.workspaceId});
   assert.equal(outcome.accepted,true);
   assert.notEqual(outcome.sessionId,old);
   assert.equal(queued.length,1);
   assert.equal(queued[0].sessionId,outcome.sessionId);
   assert.equal(f.created.length,2,'native create and the idempotent admission reuse the same new Session');
   assert(f.created.every(item=>item.sessionId===outcome.sessionId));
  }finally{await coordinator.close()}
 }finally{f.close()}
});
