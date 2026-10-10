import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {CoreStore} from '../lib/store.js';
import {isOwnerChannelSession} from '../lib/memory-access.js';
import {schema as discord} from '../channels/discord/config.js';
import {schema as feishu} from '../channels/feishu/config.js';
import {allowed} from '../lib/channel-runtime.js';

const dm=(provider,userId,accountId='default')=>({kind:'dm',provider,accountId,userId,conversationId:'dm-'+userId,messageId:'m1',text:'hello'});
const binding=(store,message,sessionId)=>store.putBinding(message.provider+'-'+message.userId,{...message,sessionId,scope:{workspaceId:'test',presetId:'agent'},delivery:'origin'});

test('first private message wins; group, later users and repeated attempts cannot take over',()=>{
 const store=new CoreStore(':memory:');
 try{
   assert.equal(store.claimOwner({...dm('discord','group-user'),kind:'group'}),null);
   assert.equal(store.owner('discord','default'),null);
   assert.equal(store.claimOwner(dm('discord','user-a')).userId,'user-a');
   assert.equal(store.claimOwner(dm('discord','user-b')).userId,'user-a');
   assert.equal(store.owner('discord','default').source,'first-dm');
   binding(store,dm('discord','user-a'),'session-A');
   binding(store,dm('discord','user-b'),'session-B');
   assert.equal(isOwnerChannelSession(store,'session-A','owner'),true);
   assert.equal(isOwnerChannelSession(store,'session-B','owner'),false);
 }finally{store.close();}
});

test('owners persist on disk across Core restarts and remain independent by channel',()=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-channel-owner-')),file=path.join(tmp,'state.sqlite');
 try{
   const first=new CoreStore(file);
   first.claimOwner(dm('discord','d-owner'));
   first.claimOwner(dm('feishu','f-owner'));
   binding(first,dm('discord','d-owner'),'discord-session');
   binding(first,dm('feishu','f-owner'),'feishu-session');
   first.close();
   const second=new CoreStore(file);
   assert.equal(second.owner('discord','default').userId,'d-owner');
   assert.equal(second.owner('feishu','default').userId,'f-owner');
   assert.equal(isOwnerChannelSession(second,'discord-session','owner'),true);
   assert.equal(isOwnerChannelSession(second,'feishu-session','owner'),true);
   second.claimOwner(dm('discord','late-arrival'));
   assert.equal(second.owner('discord','default').userId,'d-owner');
   second.close();
 }finally{fs.rmSync(tmp,{recursive:true,force:true});}
});

test('manual owner can be reassigned; previous owner immediately loses private memory access',()=>{
 const store=new CoreStore(':memory:');
 try{
   store.claimOwner(dm('discord','first'));
   binding(store,dm('discord','first'),'first-session');
   binding(store,dm('discord','new'),'new-session');
   assert.equal(isOwnerChannelSession(store,'first-session','owner'),true);
   store.setOwner('discord','default','new');
   assert.equal(isOwnerChannelSession(store,'first-session','owner'),false);
   assert.equal(isOwnerChannelSession(store,'new-session','owner'),true);
   assert.equal(store.owner('discord','default').source,'manual');
   store.claimOwner(dm('discord','first'));
   assert.equal(store.owner('discord','default').userId,'new');
 }finally{store.close();}
});

test('new owner fields are compatible with legacy configs and displayed on both settings pages',()=>{
 for(const schema of [discord,feishu]){
   const config=schema.validate({enabled:true});
   assert.equal(config.ownerMode,'first-dm');
   assert.equal(config.ownerUserId,'');
   assert.equal(schema.validate({...config,ownerMode:'manual',ownerUserId:'user-123'}).ownerUserId,'user-123');
   assert.throws(()=>schema.validate({...config,ownerMode:'manual',ownerUserId:''}));
   assert.throws(()=>schema.validate({...config,ownerMode:'unknown'}));
 }
 const pages=JSON.parse(fs.readFileSync(new URL('../../_shared/plugin-settings/pages.json',import.meta.url),'utf8'));
 for(const channel of ['dsh-channel-core-discord','dsh-channel-core-feishu']){
   const fields=pages[channel].fields;
   for(const key of ['ownerMode','ownerUserId','ownerStatus'])assert(fields.some(item=>item.key===key),channel+': '+key);
 }
});

test('default auto claim only for a DM; existing allowlists remain restrictive',()=>{
 const d=discord.validate({enabled:true,dmPolicy:'allowlist'});
 assert.equal(allowed(dm('discord','first'),d),true);
 const scoped=discord.validate({...d,allowedUsers:['known']});
 assert.equal(allowed(dm('discord','stranger'),scoped),false);
 assert.equal(allowed(dm('discord','known'),scoped),true);
 assert.equal(allowed({...dm('discord','stranger'),kind:'group',mentionedBot:true},d),false);
 const f=feishu.validate({enabled:true,allowedUsers:[]});
 assert.equal(allowed(dm('feishu','first'),f),true);
 assert.equal(allowed(dm('feishu','other'),feishu.validate({...f,allowedUsers:['allowed']})),false);
});
