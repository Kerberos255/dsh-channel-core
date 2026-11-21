import test from 'node:test';
import assert from 'node:assert/strict';
import { createCardKitChannel } from '../cardkit.js';
import { createTransport, card, finalizeCardKitMessage } from '../transport.js';
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
  async send(chatId,body){im.push({type:'send',body});return {messageId:'legacy-'+im.length};},
  async updateCard(messageId,payload){im.push({type:'update',messageId,payload});},
 };
 const sdk={createLarkChannel:()=>channel,Domain:{Feishu:'feishu',Lark:'lark'}};
 return {kit,im,rawClient,create:()=>createTransport({
   config:schema.validate({streaming}),credentials:['placeholder'],signal:new AbortController().signal,
   receive:async()=>{},state:()=>{},action:async()=>{},
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
 await finalizeCardKitMessage(api,record,card({status:'completed',final:true,text:'done'}));
 assert.deepEqual(calls,['close','close','update']);
 assert.equal(record.streaming,false);
 const unclosed={streaming:true};let updates=0;
 await assert.rejects(finalizeCardKitMessage({
  async close(){throw Error('offline');},
  async update(){updates++;},
 },unclosed,card({status:'completed',final:true,text:'done'})),/stream-close-failed/);
 assert.equal(unclosed.streaming,true);
 assert.equal(updates,1,'best effort final content without a false close ACK');
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
