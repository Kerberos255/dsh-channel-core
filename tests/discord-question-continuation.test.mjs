import test from 'node:test';
import assert from 'node:assert/strict';
import { createTransport } from '../channels/discord/transport.js';
import { afterPresentedContext } from '../channels/discord/question-context.js';

function fixture(){
 const messages=new Map(),history=[],removed=[],handlers=new Map();
 let current=0;
 const channel={
  isTextBased:()=>true,
  sendTyping:async()=>{},
  send:async payload=>{
   const id='bot-'+(++current),row={id,content:payload.content,components:payload.components??[],deleted:false};
   messages.set(id,row);history.push({type:'send',id,content:row.content});
   return{id};
  },
  messages:{
   edit:async (id,payload)=>{const row=messages.get(id);assert(row&&!row.deleted);Object.assign(row,{content:payload.content,components:payload.components??[]});history.push({type:'edit',id,content:row.content});return{id};},
   delete:async id=>{const row=messages.get(id);assert(row);row.deleted=true;removed.push(id);return{id};}
  }
 };
 class Client{
  user={id:'bot'};
  application={commands:{create:async()=>{}}};
  channels={fetch:async()=>channel};
  on(name,handler){handlers.set(name,handler);}
  off(name){handlers.delete(name);}
  async login(){return 'logged-in';}
  async destroy(){}
 }
 const sdk={Client,GatewayIntentBits:{Guilds:1,GuildMessages:2,DirectMessages:4,MessageContent:8},Partials:{Channel:0},Options:{cacheWithLimits:()=>({})}};
 const config={accountId:'bot-1',streaming:{mode:'progress',progress:{maxLines:4}},throttleMs:1,registerCommands:false};
 const origin={provider:'discord',accountId:'bot-1',conversationId:'private-dm',userId:'owner',messageId:'user-first',kind:'dm'};
 const controller=new AbortController();
 return{messages,history,removed,config,origin,sdk,signal:controller.signal,async create(){return createTransport({
  config,credentials:['synthetic-bot-token'],signal:controller.signal,
  receive:async()=>{},state:()=>{},action:async()=>{},sessions:async()=>[],host:{}
 },sdk);},close:()=>controller.abort(),
 visible:()=>[...messages.values()].filter(x=>!x.deleted).map(x=>x.content)};
}
const status='completed';
const question={status:'waiting-user',text:'1/1 · 选择下一步\n\n文字回答：/answer <token> 你的回答',final:false};
test('exact previously published Ask User text is stripped, but mismatches are not',()=>{
 assert.equal(afterPresentedContext('第一段\n\n第二段','第一段'),'第二段');
 assert.equal(afterPresentedContext('第一段','第一段'),'');
 assert.equal(afterPresentedContext('第一段又不同','第一段'),'第一段又不同');
 assert.equal(afterPresentedContext('新文','旧文'),'新文');
 assert.equal(afterPresentedContext('全文',''),'全文');
});
test('Ask User retains pre-question history once and sends only continuation on final',async()=>{
 const f=fixture(),t=await f.create();try{
  await t.progress(f.origin,{status:'generating',text:'前面已经说完'});
  await t.question(f.origin,{...question,context:'前面已经说完'},[{label:'继续',token:'mock'}]);
  assert.equal(f.visible().filter(x=>x==='前面已经说完').length,1);
  await t.send(f.origin,{status,text:'前面已经说完\n\n回答之后的新内容',final:true});
  assert.equal(f.visible().filter(x=>x==='前面已经说完').length,1);
  assert(f.visible().includes('回答之后的新内容'));
  assert(!f.visible().some(x=>x.includes('前面已经说完\n\n回答之后')));
 }finally{await t.close();f.close();}
});
test('two questions publish each committed delta once, final emits only unseen tail',async()=>{
 const f=fixture(),t=await f.create();try{
  const first='第一次提问前的说明',second=first+'\n\n两次提问之间的新文字';
  await t.question(f.origin,{...question,context:first},[{label:'好',token:'x'}]);
  await t.question(f.origin,{...question,text:'2/2 · 第二个问题',context:second},[{label:'确认',token:'y'}]);
  await t.send(f.origin,{status,text:second+'\n\n最终处理完成',final:true});
  const visible=f.visible().join('\n');
  assert.equal(visible.split(first).length-1,1);
  assert.equal(visible.split('两次提问之间的新文字').length-1,1);
  assert.equal(visible.split('最终处理完成').length-1,1);
 }finally{await t.close();f.close();}
});
test('steer after Ask User uses first-origin context to trim final sent to latest input',async()=>{
 const f=fixture(),t=await f.create();try{
  await t.question(f.origin,{...question,context:'前文已显示'},[{label:'继续',token:'x'}]);
  const latest={...f.origin,messageId:'user-steer'};
  await t.send(latest,{status,progressOriginMessageId:f.origin.messageId,text:'前文已显示\n\n只发送新的结论',final:true});
  assert(f.visible().includes('前文已显示'));
  assert(f.visible().includes('只发送新的结论'));
  assert(!f.visible().some(x=>x.includes('前文已显示\n\n只发送新的结论')));
  assert.equal(f.removed.length,1,'the old Ask User question is retired, not the preserved prefix');
 }finally{await t.close();f.close();}
});
test('without prior Ask User a final remains unchanged; exact-context final does not repeat it',async()=>{
 const f=fixture(),t=await f.create();try{
  await t.send(f.origin,{status,text:'正常最终回复',final:true});
  assert(f.visible().includes('正常最终回复'));
  const later={...f.origin,messageId:'user-second'};
  await t.question(later,{...question,context:'已告知全部信息'},[{label:'好',token:'x'}]);
  await t.send(later,{status,text:'已告知全部信息',final:true});
  assert.equal(f.visible().filter(x=>x==='已告知全部信息').length,1);
  assert(f.visible().includes('本轮已完成。'));
 }finally{await t.close();f.close();}
});
