import test from 'node:test';
import assert from 'node:assert/strict';
import {installOutboundAgentTool} from '../lib/outbound-agent-tool.js';

const SESSION='session-news-or-normal';
function registered(){
 const calls=[];let tool;
 const core={sendToBoundSession:async x=>{calls.push(x);return{id:'sent-1',state:'sent'};}};
 const ctx={inject(deps,cb){
  assert.deepEqual(deps,['tools']);cb({tools:{register(t){assert(!tool);tool=t;}}});
 },on(){throw Error('unexpected agent hook; news readers must not exist')}};
 installOutboundAgentTool(ctx,core);
 return {tool,calls};
}
const exec={agent:{session:{id:SESSION,header:{cwd:'E:/dsh/workspaces/xiaohujing'}}},callId:'call-1',signal:new AbortController().signal};
test('channel_send is the only model-facing channel tool; no news history or prompt is injected',async()=>{
 const {tool,calls}=registered();
 assert.equal(tool.name,'channel_send');
 assert.deepEqual(Object.keys(tool.parameters.properties).sort(),
 ['text','imagePath','filePath','bindingId','idempotencyKey'].sort());
 assert(!/新闻|归档|历史|list|read/.test(tool.description));
 await assert.rejects(tool.execute({action:'list'},exec));
 assert.equal(calls.length,0);
 assert.deepEqual(await tool.execute({text:'Hello'},exec),{id:'sent-1',state:'sent'});
 assert.deepEqual(await tool.execute({filePath:'_scratch/report.pdf'},exec),{id:'sent-1',state:'sent'});
 assert.deepEqual(await tool.execute({imagePath:'_scratch/photo.png',idempotencyKey:'photo-1'},exec),{id:'sent-1',state:'sent'});
 assert.deepEqual(calls,[
  {sessionId:SESSION,bindingId:undefined,text:'Hello',idempotencyKey:'call-1',source:'agent'},
  {sessionId:SESSION,bindingId:undefined,text:'',filePath:'_scratch/report.pdf',workspacePath:'E:/dsh/workspaces/xiaohujing',idempotencyKey:'call-1',source:'agent'},
  {sessionId:SESSION,bindingId:undefined,text:'',imagePath:'_scratch/photo.png',workspacePath:'E:/dsh/workspaces/xiaohujing',idempotencyKey:'photo-1',source:'agent'}
 ]);
});
test('tool refuses missing Session and empty request',async()=>{
 const {tool,calls}=registered();
 await assert.rejects(tool.execute({},exec),/text-or-attachment/);
 await assert.rejects(tool.execute({text:'hello'},{...exec,agent:{session:{}}}),/session-denied/);
 assert.equal(calls.length,0);
});
