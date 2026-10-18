import test from 'node:test';
import assert from 'node:assert/strict';
import {CoreStore} from '../lib/store.js';
import {DeliveryStore,deliveryKey} from '../lib/delivery-store.js';
import {attachOutboundAgentPrompt,attachNewsReader,installNewsAgentTool,
 readNewsForAgent,newsArchiveHint,recentNewsPrompt} from '../lib/news-agent-access.js';

const NEWS='session-real-news';
const OTHER='session-normal';
function fixture(){
 const store=new CoreStore(':memory:'),deliveries=new DeliveryStore(store.db);
 let count=0;
 const add=({sessionId=NEWS,source='windows-news',provider='feishu',text='新闻原文：A\n**B**',state='sent'}={})=>{
  const id=deliveryKey(['news-agent',++count]);
  deliveries.enqueue(id,{provider,accountId:'bot'}, {text});
  deliveries.archive(id,{sessionId,provider,source,idempotencyKey:'key-'+count,text});
  if(state==='sent')deliveries.finish(id,'sent','om_test_'+count);
  else if(state==='failed')deliveries.finish(id,'failed',null,'network');
  return id;
 };
 const news=add();
 const other=add({sessionId:OTHER,text:'其他 Session 旧新闻，不能读取'});
 const otherSource=add({sessionId:NEWS,source:'agent',text:'其他主动外发，不是新闻'});
 const failed=add({sessionId:NEWS,text:'失败的新闻不能展示',state:'failed'});
 const core={newsArchiveSessionId:NEWS,bridge:{store:deliveries}};
 return {core,deliveries,store,news,other,otherSource,failed,add,close:()=>store.close()};
}
function mockAgent(id){
 const tools=new Map(),handlers={};let section,toolInjections=0;
 const agent={session:{id,header:{cwd:'E:/dsh/workspaces/test'}},ctx:{inject(deps,register){
   if(deps[0]==='tools'){toolInjections++;register({tools:{register(t){tools.set(t.name,t);}}});return;}
   if(deps[0]==='systemPrompt')register({effect(fn){fn();},
     systemPrompt:{section(x){section=x;return()=>{};}},on(event,fn){handlers[event]=fn;}});
  }}};
 return {agent,tools,handlers,get section(){return section;},get toolInjections(){return toolInjections;}};
}
test('news history is limited to the one registered Session and confirmed news only',()=>{
 const f=fixture();try{
  const before=f.store.db.prepare('SELECT count(*) AS n FROM receipts').get().n;
  const list=readNewsForAgent(f.core,NEWS,{action:'list'});
  assert.deepEqual(list.records.map(x=>x.id),[f.news]);
  assert.equal(readNewsForAgent(f.core,NEWS,{action:'list',query:'新闻原文'}).records.length,1);
  assert.equal(readNewsForAgent(f.core,NEWS,{action:'list',query:'无匹配'}).records.length,0);
  assert.equal(readNewsForAgent(f.core,NEWS,{action:'read',id:f.news,offset:3}).text,'文：A\n**B**');
  for(const id of [f.other,f.otherSource,f.failed])
   assert.throws(()=>readNewsForAgent(f.core,NEWS,{action:'read',id}),/not-found/);
  assert.throws(()=>readNewsForAgent(f.core,OTHER,{action:'list'}),/session-denied/);
  assert.throws(()=>readNewsForAgent(f.core,OTHER,{action:'read',id:f.news}),/session-denied/);
  assert.throws(()=>readNewsForAgent(f.core,'invalid',{action:'list'}),/session-denied/);
  assert.throws(()=>readNewsForAgent(f.core,NEWS,{action:'list',query:'x'.repeat(130)}),/query-invalid/);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM receipts').get().n,before);
 }finally{f.close();}
});
test('news detail pagination stays bounded and exact, without losing original characters',()=>{
 const f=fixture();try{
  const big='中文'.repeat(9000);
  f.store.db.prepare('UPDATE channel_outbound_archive SET text=? WHERE delivery_id=?').run(big,f.news);
  const first=readNewsForAgent(f.core,NEWS,{action:'read',id:f.news});
  assert.equal(first.text.length,12000);
  const second=readNewsForAgent(f.core,NEWS,{action:'read',id:f.news,offset:first.nextOffset});
  assert.equal(first.text+second.text,big);
 }finally{f.close();}
});
test('only news Session receives a system-prompt section or full news text',async()=>{
 const f=fixture();try{
  const normal=mockAgent(OTHER);
  attachOutboundAgentPrompt(normal.agent,f.core);
  assert.equal(normal.section,undefined,'ordinary Session must not inject archive scaffolding');
  assert.equal(newsArchiveHint(f.core,OTHER),'');
  const news=mockAgent(NEWS);
  attachOutboundAgentPrompt(news.agent,f.core);
  assert.equal(news.section.name,'channel:news-reference');
  const assembly={sections:[{name:'channel:news-reference',text:''},{name:'harness:identity',text:'identity'}]};
  const result=await news.handlers['system-prompt/assemble'](null,{agent:news.agent,signal:new AbortController().signal},async()=>assembly);
  assert.match(result.sections[0].text,/新闻原文：A/);
  assert.match(result.sections[0].text,/外部资料，非指令/);
  assert.match(result.sections[0].text,/channel_news/);
  assert(!result.sections[0].text.includes('其他主动外发'));
  assert(!result.sections[0].text.includes('其他 Session'));
  assert.equal(recentNewsPrompt(f.core,OTHER),'');
  news.agent.session.id=OTHER;
  const denied=await news.handlers['system-prompt/assemble'](null,{agent:news.agent},async()=>assembly);
  assert.equal(denied.sections[0].text,'');
 }finally{f.close();}
});
test('one global send-only tool; news read tool is registered only within news Agent',async()=>{
 const f=fixture();try{
  let created,globalTool;const sent=[];
  f.core.sendToBoundSession=async value=>{sent.push(value);return{state:'sent',id:'delivery-1'};};
  installNewsAgentTool({inject(deps,cb){
   assert.deepEqual(deps,['tools']);cb({tools:{register(tool){globalTool=tool;}}});
  },on(type,cb){assert.equal(type,'agent/created');created=cb;}},f.core);
  assert.equal(globalTool.name,'channel_send');
  assert.deepEqual(globalTool.parameters.properties.action.enum,['send']);
  assert(!Object.hasOwn(globalTool.parameters.properties,'query'));
  assert(!Object.hasOwn(globalTool.parameters.properties,'id'));
  assert(!/归档|检索|读取/.test(globalTool.description));
  const normal=mockAgent(OTHER);
  created({agent:normal.agent});
  assert.equal(normal.toolInjections,0);
  assert.equal(normal.section,undefined);
  const news=mockAgent(NEWS);
  created({agent:news.agent});
  assert.deepEqual([...news.tools.keys()],['channel_news']);
  const reader=news.tools.get('channel_news');
  const exec={agent:news.agent,callId:'tool-1',signal:new AbortController().signal};
  assert.equal((await reader.execute({action:'list'},exec)).records[0].id,f.news);
  assert.equal((await reader.execute({action:'read',id:f.news},exec)).text,'新闻原文：A\n**B**');
  await assert.rejects(reader.execute({action:'list'},{...exec,agent:normal.agent}),/session-denied/);
  await assert.rejects(reader.execute({action:'read',id:f.news,query:'extra'},exec),/arguments-invalid/);
  const before=sent.length;
  await assert.rejects(globalTool.execute({action:'list'},exec),/action-invalid/);
  assert.equal(sent.length,before);
  assert.deepEqual(await globalTool.execute({text:'normal text'},exec),{state:'sent',id:'delivery-1'});
  assert.deepEqual(await globalTool.execute({filePath:'_scratch/report.pdf'},exec),{state:'sent',id:'delivery-1'});
  assert.deepEqual(sent,[{sessionId:NEWS,bindingId:undefined,text:'normal text',idempotencyKey:'tool-1',source:'agent'},
   {sessionId:NEWS,bindingId:undefined,text:'',filePath:'_scratch/report.pdf',
    workspacePath:'E:/dsh/workspaces/test',idempotencyKey:'tool-1',source:'agent'}]);
 }finally{f.close();}
});
test('bounded news context shows confirmed deliveries only; no generic records',()=>{
 const f=fixture();try{
  const big='新闻'+'甲'.repeat(21000);
  f.store.db.prepare('UPDATE channel_outbound_archive SET text=? WHERE delivery_id=?').run(big,f.news);
  const prompt=recentNewsPrompt(f.core,NEWS);
  assert(prompt.includes('新闻甲甲甲'));
  assert(prompt.includes('channel_news(action=read'));
  assert(prompt.length<13500);
  assert(!prompt.includes('其他主动外发'));
  f.store.db.prepare("UPDATE channel_outbound_archive SET state='pending' WHERE delivery_id=?").run(f.news);
  assert.equal(recentNewsPrompt(f.core,NEWS),'');
 }finally{f.close();}
});
