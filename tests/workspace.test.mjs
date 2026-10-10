import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ChannelCore from '../lib/index.js';
import { ChannelRuntime,channelScope } from '../lib/channel-runtime.js';

test('default channel workspace resolves the official registry path rather than Host startup directory',async()=>{
 const cwd=fs.realpathSync(process.cwd()),calls=[];
 const core={ctx:{workspaceController:{initializeDefault:async signal=>{calls.push(signal);return {workspace:{path:cwd}};}}}};
 const signal=new AbortController().signal;
 assert.equal(await ChannelCore.prototype.resolveWorkspace.call(core,{workspacePath:''},signal),cwd);assert.deepEqual(calls,[signal]);
 const config={workspacePath:'',agentPreset:'agent',memoryNamespace:'private'},runtime={ctx:{channelCore:{resolveWorkspace:(config,signal)=>ChannelCore.prototype.resolveWorkspace.call(core,config,signal)}}};
 const context=await ChannelRuntime.prototype.sessionContext.call(runtime,config,signal);assert.deepEqual(context.create,{cwd,agentPreset:'agent'},'fallback without native ID must use cwd only');assert.deepEqual(context.scope,channelScope({...config,workspacePath:cwd}));assert.notEqual(context.scope.workspaceId,'default');
});

test('explicit workspace is canonicalized and missing default never silently falls back',async()=>{
 const directory=fs.mkdtempSync(path.resolve('workspace-test-'));try{
  const link=path.join(directory,'alias'),target=path.join(directory,'actual');fs.mkdirSync(target);fs.symlinkSync(target,link,'junction');
  const core={ctx:{workspaceController:{initializeDefault:()=>assert.fail('explicit path must bypass default lookup')}}};
  assert.equal(await ChannelCore.prototype.resolveWorkspace.call(core,{workspacePath:link}),fs.realpathSync(target));
  await assert.rejects(ChannelCore.prototype.resolveWorkspace.call({ctx:{workspaceController:{initializeDefault:async()=>undefined}}},{workspacePath:''}),{code:'channel-workspace-required'});
  const abort=new AbortController();abort.abort();await assert.rejects(ChannelCore.prototype.resolveWorkspace.call(core,{workspacePath:target},abort.signal),{name:'AbortError'});
 }finally{assert(fs.realpathSync(directory).startsWith(fs.realpathSync(process.cwd())+path.sep));fs.rmSync(directory,{recursive:true,force:true});}
});

test('role-bound channel sessions use the native registered workspace ID and preset',async()=>{
 const cwd=fs.realpathSync(process.cwd()),id='native-role-workspace',signal=new AbortController().signal;
 const profile={preset:'whale',name:'小虎鲸',workspace:cwd};
 const services={instructionFilesSettings:{configFile:{value:{profiles:[profile]}}},workspaceRegistry:{list:()=>[{id,path:cwd,title:'小虎鲸'}]}};
 const core={ctx:{get:name=>services[name],workspaceController:{initializeDefault:()=>assert.fail('role path is explicit')}},resolveWorkspace(config,signal){return ChannelCore.prototype.resolveWorkspace.call(this,config,signal);}};
 const config={rolePreset:'whale',agentPreset:'agent',workspacePath:'',memoryNamespace:'private'};
 const resolved=await ChannelCore.prototype.resolveSessionWorkspace.call(core,config,signal);
 assert.deepEqual(resolved,{cwd,workspaceId:id,agentPreset:'whale'});
 const runtime={core:{resolveSessionWorkspace:(c,s)=>ChannelCore.prototype.resolveSessionWorkspace.call(core,c,s)}};
 const session=await ChannelRuntime.prototype.sessionContext.call(runtime,config,signal);
 assert.deepEqual(session.create,{workspaceId:id,agentPreset:'whale'},'native create must not send cwd along with workspaceId');
 assert.equal(session.scope.presetId,'whale');
 assert.notEqual(session.scope.workspaceId,id,'channel routing scope and native workspace id are intentionally distinct');
});

test('legacy channel preset automatically associates an existing registered workspace',async()=>{
 const cwd=fs.realpathSync(process.cwd()),id='native-legacy-workspace';
 const services={instructionFilesSettings:{configFile:{value:{profiles:[{preset:'agent',name:'小虎鲸',workspace:cwd}]}}},workspaceRegistry:{list:()=>[{id,path:cwd,title:'小虎鲸'}]}};
 const core={ctx:{get:name=>services[name],workspaceController:{initializeDefault:async()=>({workspace:{path:cwd}})}},resolveWorkspace(config,signal){return ChannelCore.prototype.resolveWorkspace.call(this,config,signal);}};
 const found=await ChannelCore.prototype.resolveSessionWorkspace.call(core,{rolePreset:'',agentPreset:'agent',workspacePath:''});
 assert.deepEqual(found,{cwd,workspaceId:id,agentPreset:'agent'});
});

test('explicit role binding fails closed when the role disappears',async()=>{
 const cwd=fs.realpathSync(process.cwd()),core={ctx:{get:()=>undefined,workspaceController:{initializeDefault:async()=>({workspace:{path:cwd}})}},resolveWorkspace(config,signal){return ChannelCore.prototype.resolveWorkspace.call(this,config,signal);}};
 await assert.rejects(ChannelCore.prototype.resolveSessionWorkspace.call(core,{rolePreset:'gone',agentPreset:'agent',workspacePath:''}),{code:'channel-role-unavailable'});
});

test('legacy channel without the roles plugin still uses its registered native workspace',async()=>{
 const cwd=fs.realpathSync(process.cwd());
 const services={workspaceRegistry:{list:()=>[{id:'native-default',path:cwd,title:'default'}]}};
 const core={ctx:{get:name=>services[name],workspaceController:{initializeDefault:async()=>({workspace:{path:cwd}})}},resolveWorkspace(config,signal){return ChannelCore.prototype.resolveWorkspace.call(this,config,signal);}};
 assert.deepEqual(await ChannelCore.prototype.resolveSessionWorkspace.call(core,{rolePreset:'',agentPreset:'agent',workspacePath:''}),{cwd,workspaceId:'native-default',agentPreset:'agent'});
});
