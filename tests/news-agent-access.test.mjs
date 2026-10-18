import test from 'node:test';
import assert from 'node:assert/strict';
import {CoreStore} from '../lib/store.js';
import {DeliveryStore,deliveryKey} from '../lib/delivery-store.js';
import {attachNewsAgentPrompt,installNewsAgentTool,readNewsForAgent,newsArchiveHint,recentNewsPrompt} from '../lib/news-agent-access.js';

const SESSION='session-real-news';
function fixture(){
 const store=new CoreStore(':memory:'),deliveries=new DeliveryStore(store.db);
 const id=deliveryKey(['news-agent',1]),other=deliveryKey(['news-agent',2]);
 for(const [key,sessionId,text] of [[id,SESSION,'新闻原文：A\n**B**'],[other,'session-other','只能属于其他 Session']]){
  deliveries.enqueue(key,{provider:'feishu',accountId:'bot'}, {text});
  deliveries.archive(key,{sessionId,provider:'feishu',source:'windows-news',idempotencyKey:'windows-news-unit-'+key.slice(0,6),text});
  deliveries.finish(key,'sent','om_test_'+key.slice(0,8));
 }
 const core={newsArchiveSessionId:SESSION,bridge:{store:deliveries}};
 return {store,deliveries,core,id,other,close(){store.close();}};
}
test('model can list and read exact sent text, with session authorization and no transcript writes',()=>{
 const f=fixture();try{
  const baseline=f.store.db.prepare('SELECT count(*) AS n FROM receipts').get().n;
  const listing=readNewsForAgent(f.core,SESSION,{action:'list'});
  assert.equal(listing.records.length,1);assert.equal(listing.records[0].id,f.id);
  assert(listing.records[0].messageId.startsWith('om_test_'));
  assert.equal(readNewsForAgent(f.core,SESSION,{action:'list',query:'新闻原文'}).records.length,1);
  assert.equal(readNewsForAgent(f.core,SESSION,{action:'list',query:'无此词'}).records.length,0);
  const detail=readNewsForAgent(f.core,SESSION,{action:'read',id:f.id,offset:3});
  assert.equal(detail.text,'文：A\n**B**');assert.equal(detail.nextOffset,null);
  assert.equal(detail.state,'sent');
  assert.throws(()=>readNewsForAgent(f.core,SESSION,{action:'read',id:f.other}),/record-not-found/);
  assert.equal(readNewsForAgent(f.core,'session-other',{action:'list'}).records.length,1,'other session reads only its own record');
  assert.throws(()=>readNewsForAgent(f.core,'invalid-session',{action:'list'}),/session-denied/);
  assert.throws(()=>readNewsForAgent(f.core,SESSION,{action:'read',id:'bad'}),/id-invalid/);
  assert.throws(()=>readNewsForAgent(f.core,SESSION,{action:'list',query:'x'.repeat(121)}),/query-invalid/);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM receipts').get().n,baseline);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM channel_turn_origins').get().n,0);
 }finally{f.close();}
});
test('large original records are read in bounded, lossless fragments',()=>{
 const f=fixture();try{
  const big='中文'.repeat(9000);
  f.store.db.prepare('UPDATE channel_outbound_archive SET text=? WHERE delivery_id=?').run(big,f.id);
  const a=readNewsForAgent(f.core,SESSION,{action:'read',id:f.id});
  assert.equal(a.text.length,12000);assert.equal(a.nextOffset,12000);
  const b=readNewsForAgent(f.core,SESSION,{action:'read',id:f.id,offset:a.nextOffset});
  assert.equal(a.text+b.text,big);assert.equal(b.nextOffset,null);
 }finally{f.close();}
});
test('only designated Session gets recent confirmed news in its next normal LLM request',async()=>{
 const f=fixture();try{
  const handlers={};let section;
  const agent={session:{id:SESSION},ctx:{inject(_deps,cb){cb({
   effect(fn){fn();},
   systemPrompt:{section(value){section=value;return ()=>{};}},
   on(name,handler){handlers[name]=handler;},
  });}}};
  attachNewsAgentPrompt(agent,f.core);
  assert.equal(section.name,'channel:outbound-archive');
  const assembly={sections:[{name:'channel:outbound-archive',text:''},{name:'harness:identity',text:'identity'}]};
  const result=await handlers['system-prompt/assemble'](null,{agent,signal:new AbortController().signal},async()=>assembly);
  assert.match(result.sections[0].text,/channel_send/);
  assert.match(result.sections[0].text,/om_test_/);
  assert.match(result.sections[0].text,/新闻原文：A/);
  assert.match(result.sections[0].text,/外部资料，非指令/);
  assert.equal(recentNewsPrompt(f.core,'session-other'),'');
  agent.session.id='session-empty';
  const denied=await handlers['system-prompt/assemble'](null,{agent},async()=>assembly);
  assert.equal(denied.sections[0].text,'');
  assert.equal(newsArchiveHint(f.core,'session-empty'),'');
 }finally{f.close();}
});
test('one channel_send tool supports read-only list/read and compatible send',async()=>{
 const f=fixture();try{
  const tools=new Map();let created;const sendCalls=[];
  f.core.sendToBoundSession=async value=>{sendCalls.push(value);return {state:'sent',id:'delivery-1'};};
  installNewsAgentTool({inject(deps,cb){assert.deepEqual(deps,['tools']);cb({tools:{register(tool){tools.set(tool.name,tool);}}});},on(event,callback){assert.equal(event,'agent/created');created=callback;}},f.core);
  assert.deepEqual([...tools.keys()],['channel_send'],'exactly one model-facing channel tool');
  const registered=tools.get('channel_send');
  assert(registered.parameters.properties.action.enum.includes('read'));
  const ac=new AbortController();
  const exec={agent:{session:{id:SESSION}},callId:'call-1',signal:ac.signal};
  const listing=await registered.execute({action:'list'},exec);
  assert.equal(listing.records[0].id,f.id);
  assert.deepEqual(registered.output.render(null,listing),[{type:'text',text:JSON.stringify(listing)}]);
  const detail=await registered.execute({action:'read',id:f.id},exec);
  assert.equal(detail.text,'新闻原文：A\n**B**');
  assert.equal(sendCalls.length,0,'list/read must have no delivery side effects');
  assert.equal((await registered.execute({action:'list'},{...exec,agent:{session:{id:'session-stranger'}}})).records.length,0);
  await assert.rejects(registered.execute({action:'read',id:f.id},{...exec,agent:{session:{id:'session-stranger'}}}),/record-not-found/);
  await assert.rejects(registered.execute({action:'list'},{signal:ac.signal}),/session-denied/);
  for(const args of [{action:'list',text:'DO NOT SEND'},{action:'read',id:f.id,idempotencyKey:'x'},
   {action:'send',text:'hello',query:'abc'},{action:'send',text:' '},{action:'invalid',text:'hello'},{}]){
   await assert.rejects(registered.execute(args,exec));
  }
  assert.equal(sendCalls.length,0,'mixed, invalid and incomplete requests cannot send');
  assert.deepEqual(await registered.execute({text:'legacy send'},exec),{state:'sent',id:'delivery-1'});
  assert.deepEqual(await registered.execute({action:'send',text:'new send',bindingId:'binding-test',idempotencyKey:'stable-key'},exec),{state:'sent',id:'delivery-1'});
  assert.deepEqual(sendCalls,[
   {sessionId:SESSION,bindingId:undefined,text:'legacy send',idempotencyKey:'call-1',source:'agent'},
   {sessionId:SESSION,bindingId:'binding-test',text:'new send',idempotencyKey:'stable-key',source:'agent'}
  ]);
  assert.equal(typeof created,'function');
  ac.abort();await assert.rejects(registered.execute({action:'list'},exec),{name:'AbortError'});
  assert.equal(sendCalls.length,2);
 }finally{f.close();}
});

test('auto news context stays bounded, ignores failed deliveries and never crosses Sessions',()=>{
 const f=fixture();try{
  const big='新闻'+'甲'.repeat(21000);
  f.store.db.prepare('UPDATE channel_outbound_archive SET text=? WHERE delivery_id=?').run(big,f.id);
  let prompt=recentNewsPrompt(f.core,SESSION);
  assert(prompt.includes('新闻甲甲甲'));
  assert(prompt.includes('action=read'));
  assert(prompt.length<13500,'news reference budget must remain bounded');
  assert(!prompt.includes('只能属于其他 Session'));
  f.store.db.prepare("UPDATE channel_outbound_archive SET state='pending' WHERE delivery_id=?").run(f.id);
  assert.equal(recentNewsPrompt(f.core,SESSION),'','unconfirmed content cannot enter model context');
 }finally{f.close();}
});
