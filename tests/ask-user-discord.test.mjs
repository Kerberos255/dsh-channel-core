import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { afterPresentedContext } from '../channels/discord/question-context.js';
import { createTransport } from '../channels/discord/transport.js';

function fixture(){
 const sent=[],edits=[],deletes=[],visible=new Map();
 let counter=0;
 const channel={
  isTextBased:()=>true,sendTyping:async()=>{},
  async send(payload){const msg={id:'output-'+(++counter),content:payload.content};sent.push(msg);visible.set(msg.id,msg.content);return msg;},
  messages:{
   async edit(id,payload){if(!visible.has(id))throw Error('unknown message');edits.push({id,content:payload.content});visible.set(id,payload.content);return{id};},
   async delete(id){deletes.push(id);visible.delete(id);},
  }
 };
 class MockClient extends EventEmitter{
  constructor(){super();this.user={id:'bot'};this.channels={fetch:async()=>channel};this.application={commands:{create:async()=>{}}};}
  async destroy(){}
  async login(){}
 }
 const sdk={Client:MockClient,GatewayIntentBits:{Guilds:1,GuildMessages:2,DirectMessages:4,MessageContent:8},Partials:{Channel:1},Options:{cacheWithLimits:()=>({})}};
 const config={accountId:'test',registerCommands:false,streaming:{mode:'progress',progress:{}},attachments:false};
 const abort=new AbortController();
 const origin={provider:'discord',accountId:'test',conversationId:'dm',messageId:'input-1',userId:'u1'};
 const make=()=>createTransport({config,credentials:[],signal:abort.signal,receive:async()=>{},state:()=>{},action:async()=>{},sessions:async()=>[]},sdk);
 return{channel,sent,edits,deletes,visible,config,abort,origin,make};
}

test('exact committed prefix is stripped and mismatch is never guessed',()=>{
 assert.equal(afterPresentedContext('A\n\nB','A'),'B');
 assert.equal(afterPresentedContext('A\n\nB','A\n\nB'),'');
 assert.equal(afterPresentedContext('A updated\n\nB','A'),'A updated\n\nB');
 assert.equal(afterPresentedContext('ABC','AB'),'ABC');
 assert.equal(afterPresentedContext('A\n\nB',''),'A\n\nB');
});

test('Ask User history is published once, then final only displays the continuation',async()=>{
 const f=fixture(),t=await f.make();
 try{
  await t.progress(f.origin,{status:'generating',text:'A'});
  await t.question(f.origin,{status:'waiting-user',context:'A',text:'1/1 · 继续吗？'},[]);
  await t.send(f.origin,{status:'completed',text:'A\n\nB'});
  const displayed=[...f.visible.values()];
  assert.deepEqual(displayed,['A','B']);
  assert.equal(f.sent.length,2,'no third copy of A');
 }finally{await t.close();}
});

test('two Ask User pauses incrementally publish each committed section once',async()=>{
 const f=fixture(),t=await f.make();
 try{
  await t.question(f.origin,{status:'waiting-user',context:'A',text:'第一问'},[]);
  await t.question(f.origin,{status:'waiting-user',context:'A\n\nB',text:'第二问'},[]);
  await t.send(f.origin,{status:'completed',text:'A\n\nB\n\nC'});
  assert.deepEqual([...f.visible.values()],['A','B','C']);
 }finally{await t.close();}
});

test('final mismatch keeps full source text and never drops content',async()=>{
 const f=fixture(),t=await f.make();
 try{
  await t.question(f.origin,{status:'waiting-user',context:'A',text:'问题'},[]);
  await t.send(f.origin,{status:'completed',text:'A was corrected\n\nB'});
  assert.equal([...f.visible.values()].at(-1),'A was corrected\n\nB');
 }finally{await t.close();}
});

test('Steer final from newer input can find prior Ask User context',async()=>{
 const f=fixture(),t=await f.make();
 try{
  await t.question(f.origin,{status:'waiting-user',context:'A',text:'问题'},[]);
  const newer={...f.origin,messageId:'input-2'};
  await t.send(newer,{status:'completed',text:'A\n\nB',progressOriginMessageId:f.origin.messageId});
  assert.equal([...f.visible.values()].at(-1),'B');
  assert(![...f.visible.values()].some(v=>v==='A\n\nB'));
 }finally{await t.close();}
});
