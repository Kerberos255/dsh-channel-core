import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { schema } from '../channels/discord/config.js';
import { createTransport } from '../channels/discord/transport.js';

// Use the Discord adapter bundled in the actual dsh-channel-core profile,
// not the retired independent dsh-channel-discord transport.
function fixture({deleteFailure=false}={}){
 const events=new EventEmitter(),calls=[],states=[];
 let failNextSend=false;
 const channel={
  isTextBased:()=>true,
  messages:{
   edit:async(id,body)=>{calls.push({type:'edit',id,body});return{id};},
   delete:async id=>{calls.push({type:'delete',id});if(deleteFailure)throw Object.assign(new Error('permission denied'),{code:'MISSING_PERMISSIONS'});}
  },
  send:async body=>{
   if(failNextSend){failNextSend=false;throw new Error('Discord delivery rejected');}
   const id='reply-'+calls.filter(c=>c.type==='send').length;
   calls.push({type:'send',id,body});return{id};
  }
 };
 class Client {
  constructor(){this.user={id:'bot'};this.application={commands:{create:async()=>{}}};this.channels={fetch:async()=>channel};}
  on(...args){events.on(...args);}off(...args){events.off(...args);}
  async login(){}async destroy(){}
 }
 const sdk={Client,Options:{cacheWithLimits:()=>()=>{}},GatewayIntentBits:{Guilds:1,GuildMessages:2,DirectMessages:3,MessageContent:4},Partials:{Channel:1}};
 const create=()=>createTransport({
  config:schema.validate({enabled:true,streaming:{mode:'progress'}}),credentials:['test'],signal:new AbortController().signal,
  receive:async()=>{},state:message=>states.push(message),action:async()=>{},sessions:async()=>[]
 },sdk);
 return{calls,states,create,failNext(){failNextSend=true;}};
}
const origin={conversationId:'private',messageId:'first',userId:'owner'};
const sent=fixture=>fixture.calls.filter(x=>x.type==='send');

test('native Steer: one editable progress stays on first message, final is posted after last Steer and old draft deleted',async()=>{
 const f=fixture(),t=await f.create();
 try{
  await t.progress(origin,{status:'thinking',text:'正在工作'});
  const original=sent(f)[0];
  assert.equal(sent(f).length,1);
  await t.progress(origin,{status:'tool-running',activity:{tools:[{name:'read',status:'running'}]}});
  assert.equal(sent(f).length,1);
  const steer={...origin,messageId:'second'};
  const result=await t.send(steer,{status:'completed',text:'最终答案',id:'final-1',progressOriginMessageId:'first'});
  assert.equal(sent(f).length,2,'one progress and one final, no second progress');
  assert.equal(result.messageId,sent(f)[1].id);
  assert.equal(sent(f)[1].body.reply.messageReference,'second');
  assert.equal(sent(f)[1].body.content,'最终答案');
  assert(!f.calls.some(x=>x.type==='edit'&&x.id===original.id&&x.body.content==='最终答案'));
  assert.deepEqual(f.calls.filter(x=>x.type==='delete').map(x=>x.id),[original.id]);
  assert(f.calls.findIndex(x=>x.type==='delete')>f.calls.findLastIndex(x=>x.type==='send'),'retire only AFTER the final');
 }finally{await t.close();}
});

test('without a Steer, final still edits the existing progress message',async()=>{
 const f=fixture(),t=await f.create();
 try{
  await t.progress(origin,{status:'thinking'});
  const first=sent(f)[0];
  const reply=await t.send(origin,{status:'completed',text:'普通回答',id:'final-2'});
  assert.equal(reply.messageId,first.id);
  assert.equal(sent(f).length,1);
  assert.equal(f.calls.filter(x=>x.type==='delete').length,0);
  assert(f.calls.some(x=>x.type==='edit'&&x.id===first.id&&x.body.content==='普通回答'));
 }finally{await t.close();}
});

test('Steer cleanup failure cannot reclassify a successful final as failed',async()=>{
 const f=fixture({deleteFailure:true}),t=await f.create();
 try{
  await t.progress(origin,{status:'thinking'});
  const reply=await t.send({...origin,messageId:'third'},{status:'completed',text:'最终成功',id:'final-3',progressOriginMessageId:'first'});
  assert.equal(reply.messageId,sent(f)[1].id);
  assert.equal(sent(f).length,2);
  assert.equal(f.calls.filter(x=>x.type==='delete').length,1);
  assert(f.states.some(x=>x.includes('清理失败')));
 }finally{await t.close();}
});

test('failed final send leaves the old progress draft untouched',async()=>{
 const f=fixture(),t=await f.create();
 try{
  await t.progress(origin,{status:'thinking'});
  f.failNext();
  await assert.rejects(t.send({...origin,messageId:'second'},{status:'completed',text:'should-not-arrive',progressOriginMessageId:'first'}),/Discord delivery rejected/);
  assert.equal(sent(f).length,1,'the original draft was the only successful send');
  assert.equal(f.calls.filter(x=>x.type==='delete').length,0,'do not remove progress before final is confirmed');
 }finally{await t.close();}
});

test('multiple Steers still deliver once and reply to the newest message',async()=>{
 const f=fixture(),t=await f.create();
 try{
  await t.progress(origin,{status:'thinking'});
  await t.progress(origin,{status:'tool-running',activity:{tools:[{name:'read',status:'completed'}]}});
  await t.send({...origin,messageId:'third'},{status:'completed',text:'最新回复',id:'last',progressOriginMessageId:'first'});
  assert.equal(sent(f).length,2);
  assert.equal(sent(f).at(-1).body.reply.messageReference,'third');
  assert.equal(f.calls.filter(x=>x.type==='delete').length,1);
 }finally{await t.close();}
});
