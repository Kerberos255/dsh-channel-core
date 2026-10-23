import test from 'node:test';
import assert from 'node:assert/strict';
import { CoreStore } from '../lib/store.js';
import { ChannelBridge } from '../lib/bridge.js';
import { ProactiveOutbound } from '../lib/proactive-outbound.js';
import { routeKeys } from '../lib/routing.js';

const sessionId='session-retired-test';
const scope={workspaceId:'w',presetId:'agent',memoryNamespace:'private',scheduleNamespace:'private',identityId:'i'};
const config={enabled:true,accountId:'bot',allowGroups:true,groupPolicy:'allowlist',allowedGroups:['chat-approved'],dmPolicy:'allowlist'};

function fixture(options={}){
 const store=new CoreStore(':memory:');
 const configs={feishu:{...config,...options.config},discord:{...config,...options.discordConfig}};
 const ctx={on(){return ()=>{}},get(name){
  if(name==='feishuChannelSettings')return {configFile:{value:configs.feishu}};
  if(name==='discordChannelSettings')return {configFile:{value:configs.discord}};
 }};
 const core={ctx,store,configFile:{value:{sharedDM:true}}};
 const bridge=new ChannelBridge(ctx,core);core.bridge=bridge;
 const outbound=new ProactiveOutbound(core),sent=[];
 function bind({provider='feishu',accountId='bot',conversationId='chat-approved',kind='group',sessionId:session=sessionId}={}){
  const value={provider,accountId,conversationId,kind,sessionId:session,scope};
  const key=routeKeys(value,scope,true).bindingKey;
  return store.putBinding(key,value);
 }
 function online(sender=async(origin,body)=>{sent.push({origin,body});return {messageId:'remote-'+sent.length};}){
  return bridge.register('feishu','bot',{send:sender});
 }
 return {core,bridge,outbound,store,bind,online,sent,configs,async close(){await bridge.close();store.close()}};
}

test('a session keeps its delivery target after /new rebinds the route away',async()=>{
 const f=fixture();try{
  f.bind();f.online();
  const next='session-after-new';
  f.store.rebindScope(sessionId,next,scope);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS c FROM bindings WHERE session_id=?').get(sessionId).c,0);
  // The old session no longer owns the binding, but it served that route before.
  const value=await f.outbound.send({sessionId,text:'收盘报告',idempotencyKey:'k1',source:'schedule'});
  assert.equal(value.state,'sent');
  assert.equal(f.sent.length,1);
  assert.equal(f.sent[0].body.text,'收盘报告');
  // The new session still delivers directly.
  const other=await f.outbound.send({sessionId:next,text:'新会话报告',idempotencyKey:'k1',source:'schedule'});
  assert.equal(other.state,'sent');
  assert.equal(f.sent.length,2);
 }finally{await f.close()}
});

test('rebindScope records the retired route with its exact scope',async()=>{
 const f=fixture();try{
  const binding=f.bind();
  f.store.rebindScope(sessionId,'session-next',scope);
  const rows=f.store.routeHistory(sessionId);
  assert.equal(rows.length,1);
  assert.equal(rows[0].binding_key,Object.keys(rows[0]).length&&rows[0].binding_key);
  assert.equal(rows[0].scope_json,JSON.stringify(scope));
  assert(binding.id);
 }finally{await f.close()}
});

test('the fallback never bypasses channel permissions',async()=>{
 const f=fixture();try{
  f.bind();f.online();
  f.store.rebindScope(sessionId,'session-next',scope);
  f.configs.feishu.allowedGroups=[];
  await assert.rejects(f.outbound.send({sessionId,text:'secret',idempotencyKey:'k'}),{code:'outbound-target-unavailable'});
  f.configs.feishu.allowedGroups=['chat-approved'];
  f.configs.feishu.enabled=false;
  await assert.rejects(f.outbound.send({sessionId,text:'secret',idempotencyKey:'k'}),{code:'outbound-target-unavailable'});
  assert.equal(f.sent.length,0);
 }finally{await f.close()}
});

test('the fallback refuses a recorded route whose scope changed',async()=>{
 const f=fixture();try{
  f.bind();f.online();
  f.store.rebindScope(sessionId,'session-next',scope);
  f.store.db.prepare('UPDATE route_history SET scope_json=? WHERE session_id=?')
   .run(JSON.stringify({...scope,workspaceId:'other'}),sessionId);
  await assert.rejects(f.outbound.send({sessionId,text:'x',idempotencyKey:'k'}),{code:'outbound-target-unavailable'});
 }finally{await f.close()}
});

test('the fallback fails closed when the recorded binding is gone',async()=>{
 const f=fixture();try{
  f.bind();f.online();
  f.store.rebindScope(sessionId,'session-next',scope);
  f.store.db.prepare('DELETE FROM bindings').run();
  await assert.rejects(f.outbound.send({sessionId,text:'x',idempotencyKey:'k'}),{code:'outbound-target-unavailable'});
  assert.equal(f.sent.length,0);
 }finally{await f.close()}
});

test('switching back with /session restores the direct binding',async()=>{
 const f=fixture();try{
  f.bind();f.online();
  const next='session-next';
  f.store.rebindScope(sessionId,next,scope);
  f.store.rebindScope(next,sessionId,scope);
  const rows=f.store.db.prepare('SELECT session_id FROM bindings').all();
  assert.equal(rows.length,1);
  assert.equal(rows[0].session_id,sessionId);
  const value=await f.outbound.send({sessionId,text:'回到原会话',idempotencyKey:'k',source:'schedule'});
  assert.equal(value.state,'sent');
 }finally{await f.close()}
});

test('history is per session and cannot reach another session route',async()=>{
 const f=fixture();try{
  f.configs.feishu.allowedGroups=['chat-approved','chat-other'];
  f.bind();
  f.bind({conversationId:'chat-other',sessionId:'session-elsewhere'});
  f.online();
  f.store.rebindScope(sessionId,'session-next',scope);
  // A stranger that never served a route gets nothing.
  await assert.rejects(f.outbound.send({sessionId:'session-stranger',text:'x',idempotencyKey:'k'}),{code:'outbound-target-unavailable'});
  // A session that owns a direct binding keeps using it, never the fallback.
  const direct=await f.outbound.send({sessionId:'session-elsewhere',text:'direct',idempotencyKey:'k2',source:'schedule'});
  assert.equal(direct.state,'sent');
  assert.equal(direct.kind,'group');
 }finally{await f.close()}
});
