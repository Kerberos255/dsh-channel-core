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
