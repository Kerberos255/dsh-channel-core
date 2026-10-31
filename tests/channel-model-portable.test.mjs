import test from 'node:test';
import assert from 'node:assert/strict';
import { channelModelCommand } from '../lib/channel-model-command.js';

const catalog={groups:[{id:'go',name:'Go',models:[{id:'flash',name:'Flash',reasoning:{defaultEffort:'max',efforts:[{id:'low',name:'Low'},{id:'max',name:'Max'}]}}]},{id:'other',name:'Other',models:[{id:'pro',name:'Pro'},{id:'flash',name:'Flash'}]}]};
function host(){const writes=[];return{writes,controller:{modelCatalog:async()=>catalog,projections:async()=>({values:{modelSelection:{next:{provider:'go',model:'flash',reasoningEffort:'low'}}}}),selectModel:async data=>{writes.push(data);return{selected:data};}}};}
test('single-model provider shorthand changes only that model',async()=>{
 const a=host();const msg=await channelModelCommand(a.controller,'s','model','go');
 assert.match(msg,/已切换模型/);assert.deepEqual(a.writes,[{sessionId:'s',provider:'go',model:'flash',reasoningEffort:'max'}]);
});
test('multi-model provider and unknown id do not mutate the Session',async()=>{
 const a=host();const msg=await channelModelCommand(a.controller,'s','model','other');
 assert.match(msg,/2 个可选模型/);assert.match(msg,/other\/pro/);
 assert.match(await channelModelCommand(a.controller,'s','model','bad'),/未找到/);
 assert.equal(a.writes.length,0);
});
test('help puts command usage before candidates with stable plain-text bullets',async()=>{
 const a=host(),model=await channelModelCommand(a.controller,'s','model',''),think=await channelModelCommand(a.controller,'s','think','');
 assert(model.indexOf('使用 /model')<model.indexOf('可选模型：'));
 assert(think.indexOf('使用 /think')<think.indexOf('可选强度：'));
 assert(model.includes('• go/flash · Flash'));assert(think.includes('• max · Max'));
});
test('unpublished reasoning strengths are not applied',async()=>{
 const a=host();
 assert.match(await channelModelCommand(a.controller,'s','think','xhigh'),/不可用/);
 assert.equal(a.writes.length,0);
});

test('model listing and switching pass the request signal required by current Hosts',async()=>{
 const stop=new AbortController(),seen=[];
 const a=host();
 a.controller.projections=async(request,signal)=>{
  signal.throwIfAborted();seen.push({request,signal});
  return{values:{modelSelection:{next:{provider:'go',model:'flash'}}}};
 };
 assert.match(await channelModelCommand(a.controller,'s','model','',stop.signal),/可选模型/);
 await channelModelCommand(a.controller,'s','model','go',stop.signal);
 assert.equal(seen.length,2);
 assert.deepEqual(seen.map(x=>x.request),[{sessionId:'s'},{sessionId:'s'}]);
 assert(seen.every(x=>x.signal===stop.signal));
 assert.equal(a.writes.length,1);
});

test('standalone model helpers also supply a valid projection signal',async()=>{
 const a=host();
 a.controller.projections=async(_request,signal)=>{
  signal.throwIfAborted();assert(signal instanceof AbortSignal);return null;
 };
 assert.match(await channelModelCommand(a.controller,'s','model',''),/可选模型/);
});

test('cancellation before or during model reads never changes the selected model',async()=>{
 for(const phase of ['before','catalog','projections']){
  const stop=new AbortController(),a=host();
  a.controller.modelCatalog=async()=>{if(phase==='catalog')stop.abort();return catalog;};
  a.controller.projections=async(_request,signal)=>{
   signal.throwIfAborted();if(phase==='projections')stop.abort();return null;
  };
  if(phase==='before')stop.abort();
  await assert.rejects(channelModelCommand(a.controller,'s','model','go',stop.signal),{name:'AbortError'});
  assert.equal(a.writes.length,0,phase);
 }
});
