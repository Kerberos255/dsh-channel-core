import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ChannelRuntime, allowed } from '../lib/channel-runtime.js';
import { CoreStore } from '../lib/store.js';
import { IdentityRouter } from '../lib/routing.js';
import { schema } from '../channels/discord/config.js';
import { ConfigFile } from '../lib/channel-plugin-settings/file-config.js';

function fixture(extra={},configFile) {
  const config=configFile?.value??{enabled:true,allowedUsers:[],allowedGroups:[],allowGroups:true,requireMention:false,accountId:'test',identityLinks:[],agentPreset:'agent',workspacePath:'',memoryNamespace:'private',inputMode:'inherit',...extra};
  const callbacks=new Set(),calls=[],events=new Map();
  const settings={configFile:configFile??{value:config,subscribe(fn){callbacks.add(fn);return()=>callbacks.delete(fn);}}};
  const ctx={credentials:{async resolve(){return{value:'fixture'};}},channelCore:{resolveWorkspace:async config=>config.workspacePath||'E:\\dsh\\deepseek-harness\\default-workspace',networkReady:Promise.resolve(),runtimeNetwork:{source:'system'},store:{syncAliases(){},claimOwner(){return null;},setOwner(){return null;}},bridge:{register(){return()=>{};}},receive:async(message)=>{calls.push(message);return{accepted:true};}},on(name,fn){events.set(name,fn);return()=>events.delete(name);}};
  let transportArgs,starts=0;
  const runtime=new ChannelRuntime(ctx,settings,{provider:'discord',credentialRefs:()=>['DISCORD_BOT_TOKEN'],createTransport:async args=>{transportArgs=args;return{start:async()=>{starts++;},close:async()=>{},details:()=>({applicationId:'application-fixture'})};}});
  return{runtime,ctx,calls,settings,get starts(){return starts;},get transportArgs(){return transportArgs;}};
}
const group={kind:'group',userId:'any-member',conversationId:'any-channel',text:'hello',resources:[],mentionedBot:false};

test('empty allowlists permit bot login while unauthorized messages stay outside the agent',async()=>{
 const f=fixture();try{await f.runtime.reconfigure();assert.equal(f.starts,1);assert(f.runtime.details().connected);assert.match(f.runtime.details().receiveMessage,/尚未配置/);assert.equal(f.runtime.details().applicationId,'application-fixture');assert.deepEqual(await f.transportArgs.receive(group),{ignored:true});assert.equal(f.calls.length,0);}finally{await f.runtime.close();}
});
test('explicit all-server policy admits unknown channels and users while private scope remains separate',async()=>{
 const f=fixture({groupPolicy:'all'});try{await f.runtime.reconfigure();assert.deepEqual(await f.transportArgs.receive(group),{accepted:true});assert.deepEqual(await f.transportArgs.receive({...group,kind:'thread',threadId:'any-thread'}),{accepted:true});assert.deepEqual(await f.transportArgs.receive({...group,kind:'dm'}),{ignored:true});assert.equal(f.calls.length,2);}finally{await f.runtime.close();}
});
test('all-server policy still obeys receive and mention switches and legacy allowlists',()=>{
 const config={allowedUsers:[],allowedGroups:[],allowGroups:true,groupPolicy:'all',requireMention:true};
 assert(!allowed(group,config));assert(allowed({...group,mentionedBot:true},config));assert(!allowed({...group,mentionedBot:true},{...config,allowGroups:false}));
 const legacy={allowedUsers:['any-member'],allowedGroups:['any-channel'],allowGroups:true,requireMention:false};assert(allowed(group,legacy));assert(!allowed({...group,userId:'other'},legacy));
});

test('private all, allowlist and disabled policies remain independent of server permissions',()=>{
 const dm={...group,kind:'dm'},config={allowedUsers:['any-member'],allowedGroups:[],allowGroups:false,requireMention:true};
 assert(allowed(dm,config));assert(!allowed({...dm,userId:'stranger'},config));
 assert(allowed({...dm,userId:'stranger'},{...config,dmPolicy:'all',allowedUsers:[]}));
 assert(!allowed(dm,{...config,dmPolicy:'disabled'}));
 assert(!allowed(group,{...config,dmPolicy:'all',requireMention:false}));
 assert.equal(schema.validate({enabled:true}).dmPolicy,'allowlist');
 assert.throws(()=>schema.validate({dmPolicy:'unknown'}),{code:'invalid-config'});
});

test('all-private users reach the coordinator with separate identity sessions',async()=>{
 const store=new CoreStore(':memory:'),router=new IdentityRouter(store,{}),f=fixture({dmPolicy:'all',allowGroups:false});
 f.ctx.channelCore.receive=async(message,options)=>({accepted:true,sessionId:router.route(message,options).binding.sessionId});
 const dm={provider:'discord',accountId:'test',conversationId:'dm',userId:'first-user',messageId:'dm-1',kind:'dm',text:'test',attachments:[],resources:[],timestamp:1,mentionedBot:false};
 try{
  await f.runtime.reconfigure();
  const first=await f.transportArgs.receive(dm),second=await f.transportArgs.receive({...dm,userId:'second-user',messageId:'dm-2'});
  assert(first.accepted);assert(second.accepted);assert.notEqual(first.sessionId,second.sessionId);
  assert.equal((await f.transportArgs.receive({...dm,messageId:'dm-3'})).sessionId,first.sessionId);
 }finally{await f.runtime.close();store.close();}
});

test('saving private scope and editing JSON apply to the next input and retire stale connections',async()=>{
 const directory=fs.mkdtempSync(path.resolve('private-scope-test-')),filename=path.join(directory,'config.json');
 const configFile=new ConfigFile(filename,schema);configFile.save({...schema.defaults,enabled:true,ownerMode:'manual',ownerUserId:'allowed-owner'},configFile.revision);
 const f=fixture({},configFile),dm={...group,kind:'dm'};
 try{
  await f.runtime.reconfigure();assert.deepEqual(await f.transportArgs.receive(dm),{ignored:true});
  const stale=f.transportArgs.receive;
  configFile.save({...configFile.value,dmPolicy:'all'},configFile.revision);await f.runtime.tail;
  assert.deepEqual(await stale(dm),{ignored:true});assert.deepEqual(await f.transportArgs.receive(dm),{accepted:true});
  fs.writeFileSync(filename,JSON.stringify({...configFile.value,dmPolicy:'disabled'}));
  for(let i=0;i<100&&configFile.value.dmPolicy!=='disabled';i++)await new Promise(done=>setTimeout(done,10));
  assert.equal(configFile.value.dmPolicy,'disabled');await f.runtime.tail;
  assert.deepEqual(await f.transportArgs.receive(dm),{ignored:true});assert.equal(f.calls.length,1);
 }finally{
  await f.runtime.close();configFile.close();
  assert(fs.realpathSync(directory).startsWith(fs.realpathSync(process.cwd())+path.sep));fs.rmSync(directory,{recursive:true,force:true});
 }
});
test('reconnect state clears the online indicator and credential failures keep secrets private',async()=>{
 const f=fixture();try{await f.runtime.reconfigure();f.transportArgs.state('正在重连',false);assert(!f.runtime.details().connected);assert(f.runtime.details().lastDisconnectAt>0);f.transportArgs.state('正在重连',false);f.transportArgs.state('已重新连接',true);assert(f.runtime.details().connected);assert.equal(f.runtime.details().reconnects,1);f.transportArgs.state('已重新连接',true);assert.equal(f.runtime.details().reconnects,1);}finally{await f.runtime.close();}
 const disabled=fixture({enabled:false});try{await disabled.runtime.reconfigure();assert.equal(disabled.starts,0);}finally{await disabled.runtime.close();}
});
