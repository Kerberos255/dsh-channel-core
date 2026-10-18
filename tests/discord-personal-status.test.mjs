import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createTransport} from '../channels/discord/transport.js';
import {ChannelRuntime} from '../lib/channel-runtime.js';
import {schema} from '../channels/discord/config.js';

function mock() {
 const events=new EventEmitter(),operations=[],received=[];
 class Client {
  constructor(){
   this.user={id:'bot'};
   this.application={commands:{create:async()=>{},fetch:async()=>new Map(),delete:async()=>{}}};
   this.channels={fetch:async()=>({isTextBased:()=>true,send:async()=>({id:'msg'})})};
  }
  on(...args){events.on(...args);}
  off(...args){events.off(...args);}
  async login(){}
  async destroy(){}
 }
 const sdk={Client,Options:{cacheWithLimits:()=>()=>{}},GatewayIntentBits:{Guilds:1,GuildMessages:2,DirectMessages:3,MessageContent:4},Partials:{Channel:1}};
 const panel={embeds:[{title:'📊 DSH 状态'}],allowedMentions:{parse:[]}};
 async function create(statusPanel) {
  return createTransport({config:schema.validate({}),credentials:['token'],signal:new AbortController().signal,receive:async()=>{received.push('ordinary')},state:()=>{},action:async()=>{},sessions:async()=>[],statusPanel},sdk);
 }
 function interaction({guildId='server',button=false,userId='owner'}={}){
  let latest;
  return {
   commandName:button?undefined:'status',customId:button?'dsh-private-status:refresh':undefined,
   guildId:guildId==='dm'?null:guildId,user:{id:userId},createdTimestamp:Date.now(),
   channel:{isThread:()=>false},channelId:'channel',id:'interaction',
   options:{getString:()=>null},isAutocomplete:()=>false,isChatInputCommand:()=>!button,
   isMessageComponent:()=>button,isButton:()=>button,
   async deferReply(value){operations.push({name:'deferReply',value});},
   async deferUpdate(){operations.push({name:'deferUpdate'});},
   async editReply(value){operations.push({name:'editReply',value});latest=value;return{id:'reply'};},
   get deferred(){return operations.some(x=>x.name==='deferReply'||x.name==='deferUpdate');},
   get replied(){return !!latest;},
   result:()=>latest
  };
 }
 return {events,operations,received,create,interaction,panel};
}
async function settle(){await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));}

test('Discord slash /status uses ephemeral embed, never dispatches a public Agent turn',async()=>{
 const f=mock(),lookups=[];
 const transport=await f.create(async event=>{lookups.push(event);return f.panel;});
 const interaction=f.interaction({guildId:'server'});
 try{
  f.events.emit('interactionCreate',interaction);
  await settle();
  assert.equal(f.operations[0].name,'deferReply');
  assert.deepEqual(f.operations[0].value,{flags:64});
  assert.equal(interaction.result().embeds[0].title,'📊 DSH 状态');
  assert.deepEqual(lookups,[{userId:'owner',kind:'group'}]);
  assert.equal(f.received.length,0);
 }finally{await transport.close();}
});
test('running /status again shows a fresh private dashboard without any buttons',async()=>{
 const f=mock();let calls=0;
 const transport=await f.create(async()=>{calls++;return f.panel;});
 try{
  const first=f.interaction({guildId:'dm'});
  f.events.emit('interactionCreate',first);await settle();
  const second=f.interaction({guildId:'dm'});
  f.events.emit('interactionCreate',second);await settle();
  assert.equal(calls,2);
  assert.deepEqual(first.result(),f.panel);
  assert.deepEqual(second.result(),f.panel);
  assert.equal(f.operations.filter(x=>x.name==='deferReply'&&x.value?.flags===64).length,2);
  assert.equal(f.operations.filter(x=>x.name==='deferUpdate').length,0);
  assert.equal(f.received.length,0);
 }finally{await transport.close();}
});
test('unauthorized viewer never receives a balance embed',async()=>{
 const f=mock();
 const transport=await f.create(async()=>null);
 try{
  const slash=f.interaction();
  f.events.emit('interactionCreate',slash);await settle();
  assert.match(slash.result().content,/仅已验证/);
  assert.equal(slash.result().embeds,undefined);
 }finally{await transport.close();}
});
test('Discord runtime requires matching configured owner and never exposes dashboard to strangers',async()=>{
 const runtime=Object.create(ChannelRuntime.prototype);
 runtime.provider='discord';runtime.closed=false;
 let calls=0,owner='owner';
 runtime.core={store:{owner:()=>owner?{userId:owner}:null},recentReplyAtForOwner:()=>12345,statusCenter:{discordPersonalStatus:async(viewer,at)=>{calls++;assert.equal(viewer.provider,'discord');assert.equal(at,12345);return{embeds:[{title:'📊 DSH 状态'}]};}}};
 const config={accountId:'default'},signal=new AbortController().signal;
 assert.equal((await runtime.discordStatusPanel({userId:'owner'},config,signal)).embeds[0].title,'📊 DSH 状态');
 assert.equal(await runtime.discordStatusPanel({userId:'stranger'},config,signal),null);
 owner=null;
 assert.equal(await runtime.discordStatusPanel({userId:'owner'},config,signal),null);
 assert.equal(calls,1);
});
