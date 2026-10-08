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
 const context=await ChannelRuntime.prototype.sessionContext.call(runtime,config,signal);assert.equal(context.create.cwd,cwd);assert.equal(context.create.agentPreset,'agent');assert.deepEqual(context.scope,channelScope({...config,workspacePath:cwd}));assert.notEqual(context.scope.workspaceId,'default');
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
