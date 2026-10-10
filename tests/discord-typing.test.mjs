import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { schema } from '../channels/discord/config.js';
import { createTransport } from '../channels/discord/transport.js';

// Discord 的"正在输入"心跳：第一次进度点亮，之后每 8 秒续期，最终回复 /
// 等待用户回答 / 超时保险丝都会停。这里用假的 discord.js SDK 驱动适配器。
function fixture({typingFails=false}={}){
 const events=new EventEmitter(),calls=[];
 let typingCalls=0;
 const channel={
  isTextBased:()=>true,
  async sendTyping(){typingCalls+=1;if(typingFails)throw Object.assign(new Error('typing rejected'),{code:'MISSING_PERMISSIONS'});},
  messages:{edit:async(id,body)=>{calls.push({type:'edit',id,body});return{id};},delete:async id=>{calls.push({type:'delete',id});}},
  send:async body=>{const id='reply-'+calls.filter(c=>c.type==='send').length;calls.push({type:'send',id,body});return{id};}
 };
 class Client {
  constructor(){this.user={id:'bot'};this.application={commands:{create:async()=>{}}};this.channels={fetch:async()=>channel};}
  on(...args){events.on(...args);}off(...args){events.off(...args);}
  async login(){}async destroy(){}
 }
 const sdk={Client,Options:{cacheWithLimits:()=>()=>{}},GatewayIntentBits:{Guilds:1,GuildMessages:2,DirectMessages:3,MessageContent:4},Partials:{Channel:1}};
 const create=()=>createTransport({
  config:schema.validate({enabled:true,streaming:{mode:'progress'}}),credentials:['test'],signal:new AbortController().signal,
  receive:async()=>{},state:()=>{},action:async()=>{},sessions:async()=>[]
 },sdk);
 return{calls,create,get typingCalls(){return typingCalls;}};
}
const origin={conversationId:'private',messageId:'first',userId:'owner'};
// 心跳是异步的：让被 tick 唤醒的 ping 跑完它的 await 链。
const drain=async()=>{for(let i=0;i<8;i+=1)await Promise.resolve();};

test('第一次进度点亮"正在输入"，心跳续期，最终回复后停止',async t=>{
 t.mock.timers.enable({apis:['setInterval','Date']});
 const f=fixture(),transport=await f.create();
 await transport.progress(origin,{status:'thinking',text:'正在工作',final:false});
 await drain();
 assert.equal(f.typingCalls,1,'进度一开始就点亮');
 t.mock.timers.tick(8000);
 await drain();
 assert.equal(f.typingCalls,2,'8 秒后心跳续期');
 t.mock.timers.tick(8000);
 await drain();
 assert.equal(f.typingCalls,3,'再 8 秒继续续期');
 await transport.send(origin,{status:'completed',text:'最终答案',id:'final-1'});
 t.mock.timers.tick(24000);
 await drain();
 assert.equal(f.typingCalls,3,'最终回复发出后不再续期');
 await transport.close();
});

test('同一来源重复进度只点亮一次，不重复起心跳',async t=>{
 t.mock.timers.enable({apis:['setInterval','Date']});
 const f=fixture(),transport=await f.create();
 await transport.progress(origin,{status:'thinking',final:false});
 await transport.progress(origin,{status:'tool-running',activity:{tools:[{name:'read',status:'running'}]},final:false});
 await drain();
 assert.equal(f.typingCalls,1);
 t.mock.timers.tick(8000);
 await drain();
 assert.equal(f.typingCalls,2,'只有一个心跳在跑');
 await transport.close();
});

test('等待用户回答时停止"正在输入"',async t=>{
 t.mock.timers.enable({apis:['setInterval','Date']});
 const f=fixture(),transport=await f.create();
 await transport.progress(origin,{status:'thinking',final:false});
 await drain();
 assert.equal(f.typingCalls,1);
 await transport.question(origin,{status:'waiting-approval',text:'需要你批准'},[{label:'允许',token:'t1'}]);
 t.mock.timers.tick(24000);
 await drain();
 assert.equal(f.typingCalls,1,'提问期间不再续期');
 await transport.close();
});

test('心跳失败静默跳过，进度与最终回复照常',async t=>{
 t.mock.timers.enable({apis:['setInterval','Date']});
 const f=fixture({typingFails:true}),transport=await f.create();
 await transport.progress(origin,{status:'thinking',text:'正在工作',final:false});
 await drain();
 t.mock.timers.tick(8000);
 await drain();
 assert.equal(f.calls.filter(x=>x.type==='send').length,1,'进度卡片照常发出');
 const result=await transport.send(origin,{status:'completed',text:'最终答案',id:'final-2'});
 assert.equal(result.messageId,'reply-0','最终回复照常发出（就地改写进度消息）');
 await transport.close();
});

test('超时保险丝停掉长时间挂着的"正在输入"',async t=>{
 t.mock.timers.enable({apis:['setInterval','Date']});
 const f=fixture(),transport=await f.create();
 await transport.progress(origin,{status:'thinking',final:false});
 await drain();
 assert.equal(f.typingCalls,1);
 t.mock.timers.tick(10*60*1000+8000);
 await drain();
 const afterFuse=f.typingCalls;
 t.mock.timers.tick(60000);
 await drain();
 assert.equal(f.typingCalls,afterFuse,'超过上限后不再发送');
 await transport.close();
});

test('关闭适配器会清掉所有心跳',async t=>{
 t.mock.timers.enable({apis:['setInterval','Date']});
 const f=fixture(),transport=await f.create();
 await transport.progress(origin,{status:'thinking',final:false});
 await transport.progress({...origin,messageId:'second'},{status:'thinking',final:false});
 await drain();
 const before=f.typingCalls;
 await transport.close();
 t.mock.timers.tick(30000);
 await drain();
 assert.equal(f.typingCalls,before);
});
