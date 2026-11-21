import test from 'node:test';
import assert from 'node:assert/strict';
import { createCardKitChannel } from '../cardkit.js';
import { createTransport, card, finalCards, finalizeCardKitMessage } from '../transport.js';
import { schema } from '../config.js';

const origin={provider:'feishu',accountId:'default',conversationId:'chat-concurrency',messageId:'user-1',kind:'dm',userId:'owner'};
const gate=()=>{let release;const promise=new Promise(resolve=>{release=resolve;});return {promise,release};};
function fixture(hooks={},streaming={mode:'partial'}){
 const kit=[],im=[];
 let created=0,messages=0;
 const record=(type,request)=>{kit.push({type,request});return {code:0};};
 const rawClient={
  cardkit:{v1:{
   card:{
    async create(request){const n=++created;record('create',request);await hooks.create?.(request,n);return {code:0,data:{card_id:'card-'+n}};},
    async update(request){record('update',request);await hooks.update?.(request);return {code:0};},
    async settings(request){record('settings',request);await hooks.settings?.(request);return {code:0};},
   },
   cardElement:{async content(request){record('content',request);await hooks.content?.(request);return {code:0};}},
  }},
  im:{v1:{message:{
   async reply(request){record('reply',request);await hooks.reply?.(request);return {code:0,data:{message_id:'message-'+ ++messages}};},
   async create(request){record('im-create',request);return {code:0,data:{message_id:'message-'+ ++messages}};},
  }}},
 };
 const channel={
  rawClient,on(){return ()=>{};},async connect(){},async disconnect(){},
  async send(chatId,body){im.push({type:'send',body});await hooks.send?.(chatId,body);return {messageId:'legacy-'+im.length};},
  async updateCard(messageId,payload){im.push({type:'update',messageId,payload});await hooks.updateCard?.(messageId,payload);},
 };
 const sdk={createLarkChannel:()=>channel,Domain:{Feishu:'feishu',Lark:'lark'}};
 return {kit,im,rawClient,create:()=>createTransport({
   config:schema.validate({streaming}),credentials:['placeholder'],signal:new AbortController().signal,
   receive:async()=>{},state:hooks.state??(()=>{}),action:async()=>{},
 },sdk)};
}
const live=text=>({status:'generating',text,activity:{timeline:[]}});

test('CardKit adapter never decreases its local sequence on reverse completion',async()=>{
 const slow=gate();
 const raw={cardkit:{v1:{card:{
  create:async()=>({code:0,data:{card_id:'x'}}),update:async()=>({code:0}),
  settings:async()=>({code:0}),
 },cardElement:{content:async()=>{await slow.promise;return {code:0};}}}},im:{v1:{message:{reply:async()=>({code:0,data:{message_id:'m'}})}}}};
 const api=createCardKitChannel({rawClient:raw}),record={cardId:'x',sequence:1,streaming:true,text:'initial'};
 const write=api.text(record,'new');
 const close=api.close(record);
 await close;
 assert.equal(record.sequence,3);
 slow.release();
 await write;
 assert.equal(record.sequence,3,'late response must not rewind the counter');
 assert.equal(record.streaming,false);
});

test('Steer waits for an in-flight CardKit text update, then freezes the previous snapshot',async()=>{
 const started=gate(),blocked=gate();let writes=0;
 const f=fixture({content:async()=>{if(++writes===1){started.release();await blocked.promise;}}}),t=await f.create();
 try{
  await t.progress(origin,live('first'));
  const pending=t.progress(origin,live('second'));
  await started.promise;
  const cut=t.cutProgress({previousOrigin:origin});
  assert.equal(f.kit.filter(x=>x.type==='settings').length,0,'close cannot outrun text');
  blocked.release();
  await pending;await cut;
  const ops=f.kit.map(x=>x.type);
  assert.deepEqual(ops.slice(-3),['content','settings','update']);
  const frozen=JSON.parse(f.kit.at(-1).request.data.card.data);
  assert.match(frozen.body.elements[0].content,/first/);
  assert.doesNotMatch(frozen.body.elements[0].content,/second/);
  await t.progress(origin,live('third'));
  assert.equal(f.kit.filter(x=>x.type==='create').length,2,'old progress Map must not reappear');
 }finally{blocked.release();await t.close();}
});

test('Steer during create/reply closes the orphaned streaming card',async()=>{
 const started=gate(),blocked=gate();
 const f=fixture({reply:async()=>{started.release();await blocked.promise;}}),t=await f.create();
 try{
  const first=t.progress(origin,live('first'));
  await started.promise;
  const cut=t.cutProgress({previousOrigin:origin});
  blocked.release();
  await first;await cut;
  const ops=f.kit.map(x=>x.type);
  assert.deepEqual(ops.slice(0,3),['create','reply','settings'],'orphan is closed after send');
  await t.progress(origin,live('next'));
  assert.equal(f.kit.filter(x=>x.type==='create').length,2);
 }finally{blocked.release();await t.close();}
});

test('slow CardKit writes coalesce intermediate snapshots and prioritize final delivery',async()=>{
 const started=gate(),blocked=gate();let writes=0;
 const f=fixture({content:async()=>{if(++writes===1){started.release();await blocked.promise;}}}),t=await f.create();
 try{
  await t.progress(origin,live('initial'));
  const first=t.progress(origin,live('in-flight'));
  await started.promise;
  const a=t.progress(origin,live('discard-1'));
  const b=t.progress(origin,live('discard-2'));
  const final=t.send(origin,{status:'completed',text:'DONE',final:true});
  blocked.release();
  await Promise.all([first,a,b,final]);
  assert.equal(f.kit.filter(x=>x.type==='content').length,1,'queued intermediate content should be discarded');
  const full=JSON.parse(f.kit.filter(x=>x.type==='update').at(-1).request.data.card.data);
  assert.equal(full.body.elements[0].content,'DONE');
  assert.equal(full.config.streaming_mode,false);
 }finally{blocked.release();await t.close();}
});

test('close failure retries before final update and never falsely marks an unclosed stream closed',async()=>{
 const calls=[],record={streaming:true};
 const api={
  async close(r){calls.push('close');if(calls.length===1)throw Error('temporary');r.streaming=false;},
  async update(r,payload){calls.push('update');assert.equal(payload.config.streaming_mode,false);},
 };
 const settled=await finalizeCardKitMessage(api,record,card({status:'completed',final:true,text:'done'}));
 assert.equal(settled.finalContentUpdated,true);
 assert.equal(settled.streamClosed,true);
 assert.deepEqual(calls,['close','close','update']);
 assert.equal(record.streaming,false);
 const unclosed={streaming:true};let updates=0;
 const partial=await finalizeCardKitMessage({
  async close(){throw Error('offline');},
  async update(){updates++;},
 },unclosed,card({status:'completed',final:true,text:'done'}));
 assert.equal(partial.finalContentUpdated,true);
 assert.equal(partial.streamClosed,false);
 assert.equal(unclosed.streaming,true);
 assert.equal(updates,1,'final content is confirmed without falsely acknowledging stream closure');
 await assert.rejects(finalizeCardKitMessage({
  async close(){throw Error('offline');},
  async update(){throw Object.assign(Error('down'),{code:'KIT_FAILURE'});},
 },{streaming:true},card({status:'completed',final:true,text:'done'})),{code:'KIT_FAILURE'});
});

test('transient CardKit create failure cools down and later allows another attempt',async()=>{
 const clock=Date.now;let fail=true;
 const f=fixture({create:async()=>{if(fail)throw Object.assign(Error('rate limit'),{status:429,code:429});}}),t=await f.create();
 try{
  await t.progress(origin,live('fallback'));
  assert.match(t.details().feishuCardEngine,/冷却中/);
  const another={...origin,messageId:'user-2'};
  await t.progress(another,live('during cooldown'));
  assert.equal(f.kit.filter(x=>x.type==='create').length,1);
  Date.now=()=>clock()+130000;fail=false;
  await t.progress({...origin,messageId:'user-3'},live('recovered'));
  assert.equal(f.kit.filter(x=>x.type==='create').length,2);
 }finally{Date.now=clock;await t.close();}
});

test('final-only grey footer escapes markup and does not leak into streaming updates',()=>{
 const config=schema.defaults.streaming;
 const partial=card({status:'generating',text:'working',footerText:'model <bad> & test'},[],config);
 assert.equal(partial.body.elements.length,1);
 const final=card({status:'completed',final:true,text:'done',footerText:'model <bad> & test'},[],config);
 assert.equal(final.body.elements.at(-2).tag,'hr');
 assert.equal(final.body.elements.at(-1).content,"<font color='grey'>model &lt;bad&gt; &amp; test</font>");
});

test('streaming config errors name the exact invalid field; enabled appId is required',()=>{
 for(const [input,field] of [
  [{progress:{maxLines:0}},'streaming.progress.maxLines'],
  [{footer:{model:'yes'}},'streaming.footer.model'],
  [{cardEngine:'wrong'},'streaming.cardEngine'],
 ]){
  assert.throws(()=>schema.validate({streaming:input}),error=>error.code==='invalid-config'&&error.message.includes(field));
 }
 assert.equal(schema.validate({enabled:true,appId:''}).appId,'','legacy settings remain loadable before credentials are entered');
 assert.throws(()=>schema.validate({appId:' app-id '}) );
 assert.equal(schema.validate({enabled:false,appId:''}).appId,'');
});


test('CardKit business error exposes sanitized message and circuit-breaks missing permissions for a bounded interval',async()=>{
 const raw={
  cardkit:{v1:{card:{
   create:async()=>({code:99991672,msg:'Missing application permission scopes'}),
   update:async()=>({code:0}),settings:async()=>({code:0}),
  },cardElement:{content:async()=>({code:0})}}},
  im:{v1:{message:{reply:async()=>({code:0,data:{message_id:'unused'}})}}},
 };
 const adapter=createCardKitChannel({rawClient:raw});
 await assert.rejects(adapter.create(origin,card(live('test'))),error=>{
  assert.equal(error.code,99991672);
  assert.equal(error.msg,'Missing application permission scopes');
  assert.equal(error.cardKitFallbackSafe,true);
  return true;
 });
 const now=Date.now;let attempts=0;
 const f=fixture({create:async()=>{attempts++;throw Object.assign(Error('forbidden'),{code:99991679,msg:'缺少应用权限'});}});
 const t=await f.create();
 try{
  await t.progress(origin,live('first'));
  assert.equal(attempts,1);
  await t.progress({...origin,messageId:'user-2'},live('second'));
  assert.equal(attempts,1,'permission circuit should not retry every progress message');
  Date.now=()=>now()+16*60*1000;
  await t.progress({...origin,messageId:'user-3'},live('third'));
  assert.equal(attempts,2,'the permission circuit has an eventual retry path');
 }finally{Date.now=now;await t.close();}
});

test('CardKit close uncertainty retains final text and sends remaining answer cards',async()=>{
 const notices=[];
 const f=fixture({settings:async()=>{throw Error('close-unavailable');},
  state:message=>notices.push(message)}),t=await f.create();
 try{
  await t.progress(origin,live('stream'));
  const answer='Long answer. '.repeat(1500);
  const cards=finalCards({status:'completed',final:true,text:answer},{});
  assert(cards.length>1,'the fixture needs multiple final cards');
  const delivered=await t.send(origin,{status:'completed',final:true,text:answer});
  assert(delivered.messageId,'the existing CardKit message remains the first final card');
  assert.equal(f.im.filter(item=>item.type==='send').length,cards.length-1,
   'later fragments must still be delivered after close uncertainty');
  assert.equal(f.kit.filter(item=>item.type==='settings').length,2);
  assert(notices.some(text=>text.includes('流式关闭未确认')),'the close outcome stays observable');
 }finally{await t.close();}
});

test('failed Steer stream close releases the old CardKit state and opens a new card',async()=>{
 const f=fixture({settings:async()=>{throw Error('close failed');}}),t=await f.create();
 try{
  const first=await t.progress(origin,live('first segment'));
  await t.cutProgress({previousOrigin:origin});
  const second=await t.progress(origin,live('second segment'));
  assert(second.messageId&&second.messageId!==first.messageId,
   'the abandoned first stream must not occupy the second segment');
  assert.equal(f.kit.filter(entry=>entry.type==='create').length,1,
   'a transient close failure should temporarily cool down further CardKit requests');
  assert.equal(f.im.filter(entry=>entry.type==='send').length,1,
   'the new segment must still have its own compatible progress card');
 }finally{await t.close();}
});

test('bounded question history never strands retired cards or permanently blocks later questions',async()=>{
 const f=fixture({updateCard:async()=>{throw Error('card recall denied');}}),t=await f.create();
 try{
  for(let i=0;i<525;i++){
   const current={...origin,messageId:'question-'+i};
   const answer=await t.question(current,{status:'waiting-user',text:'Question '+i},
    [{label:'Yes',token:'test-choice-'+i}]);
   assert(answer.messageId);
   await t.questionClosed(current,answer.messageId,'ASK_USER_INVALIDATED');
  }
  const fresh=await t.question({...origin,messageId:'after-525'},
   {status:'waiting-user',text:'Last question'},[{label:'Yes',token:'last-choice'}]);
  assert(fresh.messageId,'a bounded history must not exhaust the 512-slot live cap');
 }finally{await t.close();}
});

test('stale 24-hour non-active patch cards are reclaimed before the 512-state capacity check',async()=>{
 const base=Date.now;let current=base();Date.now=()=>current;
 const f=fixture({},{mode:'partial',cardEngine:'patch'}),t=await f.create();
 try{
  for(let i=0;i<512;i++)await t.progress({...origin,messageId:'patch-'+i},live('step '+i));
  await assert.rejects(t.progress({...origin,messageId:'overflow'},live('blocked')),
   {code:'feishu-card-state-capacity'});
  current+=24*60*60*1000+1000;
  const sent=await t.progress({...origin,messageId:'after-expiry'},live('new'));
  assert(sent.messageId,'stale inactive patch state must be reclaimed, without global lockout');
 }finally{Date.now=base;await t.close();}
});


test('abandoned unanswered cards expire after 24 hours without evicting fresh answerable cards',async()=>{
 const now=Date.now;let time=now();Date.now=()=>time;
 const f=fixture(),t=await f.create();
 try{
  for(let i=0;i<512;i++){
   const current={...origin,messageId:'pending-'+i};
   await t.question(current,{status:'waiting-user',text:'Pending '+i},
    [{label:'Confirm',token:'pending-choice-'+i}]);
  }
  await assert.rejects(t.question({...origin,messageId:'pending-overflow'},
   {status:'waiting-user',text:'Too many'},[{label:'Confirm',token:'overflow-choice'}]),
   {code:'feishu-card-state-capacity'});
  time+=24*60*60*1000+1000;
  const released=await t.question({...origin,messageId:'pending-after-ttl'},
   {status:'waiting-user',text:'After expiry'},[{label:'Confirm',token:'after-choice'}]);
  assert(released.messageId,'abandoned pending records must not permanently lock the channel');
 }finally{Date.now=now;await t.close();}
});

test('failed final patch releases per-turn transient state across more than 512 turns',async()=>{
 const f=fixture({updateCard:async()=>{throw Error('final-patch-failed');}},
  {mode:'partial',cardEngine:'patch'}),t=await f.create();
 try{
  for(let i=0;i<518;i++){
   const current={...origin,messageId:'failed-final-'+i};
   await t.progress(current,live('draft '+i));
   await assert.rejects(t.send(current,{status:'completed',text:'result '+i}),/final-patch-failed/);
  }
  const next=await t.progress({...origin,messageId:'after-errors'},live('still healthy'));
  assert(next.messageId,'failed terminal paths must not leak 512-state bookkeeping');
 }finally{await t.close();}
});


test('abandoned CardKit streams are best-effort closed after TTL instead of permanently consuming capacity',async()=>{
 const now=Date.now;let time=now();Date.now=()=>time;
 const f=fixture(),t=await f.create();
 try{
  for(let i=0;i<512;i++)
   await t.progress({...origin,messageId:'stream-'+i},live('active '+i));
  await assert.rejects(t.progress({...origin,messageId:'stream-overflow'},live('blocked')),
   {code:'feishu-card-state-capacity'});
  time+=24*60*60*1000+1000;
  const recovered=await t.progress({...origin,messageId:'stream-after-ttl'},live('fresh'));
  assert(recovered.messageId);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.kit.filter(call=>call.type==='settings').length,512,
   'every abandoned remote stream gets a best-effort close attempt');
 }finally{Date.now=now;await t.close();}
});


test('unsent question cards roll back context and cannot consume all 512 state slots',async()=>{
 const f=fixture({send:async()=>{throw Error('question-send-rejected');}}),t=await f.create();
 try{
  for(let i=0;i<518;i++){
   const current={...origin,messageId:'unsent-'+i};
   await assert.rejects(t.question(current,{status:'waiting-user',context:'Context '+i,text:'Question'},
    [{label:'Yes',token:'no-send-'+i}]),/question-send-rejected/);
  }
  await assert.rejects(t.question({...origin,messageId:'still-available'},
   {status:'waiting-user',context:'Final context',text:'Question'},
   [{label:'Yes',token:'last'}]),/question-send-rejected/,
   'new calls should reach the send operation, not a leaked capacity guard');
 }finally{await t.close();}
});
