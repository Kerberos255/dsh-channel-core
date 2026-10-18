import test from 'node:test';
import assert from 'node:assert/strict';
import { CoreStore } from '../lib/store.js';
import { ChannelBridge } from '../lib/bridge.js';
import { ProactiveOutbound, renderProactiveToolResult } from '../lib/proactive-outbound.js';
import { routeKeys } from '../lib/routing.js';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';


const sessionId='session-proactive-test';
const scope={workspaceId:'w',presetId:'agent',memoryNamespace:'private',scheduleNamespace:'private',identityId:'i'};
const config={enabled:true,accountId:'bot',allowGroups:true,groupPolicy:'allowlist',allowedGroups:['chat-approved'],dmPolicy:'allowlist'};
function fixture(options={}){
 const store=new CoreStore(':memory:');
 const configs={feishu:{...config,...options.config},discord:{...config,...options.discordConfig}};
 const ctx={on(){return ()=>{}},get(name){
  if(name==='feishuChannelSettings')return {configFile:{value:configs.feishu}};
  if(name==='discordChannelSettings')return {configFile:{value:configs.discord}};
 }};
 const core={ctx,store,configFile:{value:{sharedDM:true}}};
 const bridge=new ChannelBridge(ctx,core);core.bridge=bridge;
 const outbound=new ProactiveOutbound(core),sent=[];
 function bind({provider='feishu',accountId='bot',conversationId='chat-approved',kind='group',userId,sessionId:session=sessionId}={}){
  const value={provider,accountId,conversationId,kind,...(userId?{userId}:{}),sessionId:session,scope};
  const key=routeKeys(value,scope,true).bindingKey;
  return store.putBinding(key,value);
 }
 function online(provider='feishu',accountId='bot',sender=async(origin,body)=>{sent.push({origin,body});return {messageId:'remote-'+sent.length};}){
  return bridge.register(provider,accountId,{send:sender});
 }
 return {core,bridge,outbound,store,bind,online,sent,configs,async close(){await bridge.close();store.close()}};
}
test('proactive sends through existing adapter and the durable delivery ledger',async()=>{
 const f=fixture();try{
  f.bind();f.online();
  const value=await f.outbound.send({sessionId,text:'今日行情',idempotencyKey:'run-1',source:'schedule'});
  assert.equal(value.state,'sent');assert.equal(value.messageId,'remote-1');
  assert.equal(f.sent.length,1);
  assert.equal(f.sent[0].origin.messageId,undefined,'proactive sends must not reply to an old inbound message');
  assert.equal(f.sent[0].body.text,'今日行情');
  const stored=f.bridge.store.get(value.id);assert.equal(stored.state,'sent');
 }finally{await f.close()}
});
test('the same idempotency key never sends twice or changes content',async()=>{
 const f=fixture();try{
  f.bind();f.online();const req={sessionId,text:'one',idempotencyKey:'run-1',source:'cron'};
  const results=await Promise.all([f.outbound.send(req),f.outbound.send(req)]);
  assert.equal(results[0].id,results[1].id);assert.equal(f.sent.length,1);
  await assert.rejects(f.outbound.send({...req,text:'changed'}),{code:'outbound-idempotency-conflict'});
 }finally{await f.close()}
});
test('unbound, disabled, and different-session destinations are rejected',async()=>{
 const f=fixture();try{
  const binding=f.bind();
  await assert.rejects(f.outbound.send({sessionId:'session-stranger',text:'secret',idempotencyKey:'x'}),{code:'outbound-target-unavailable'});
  await assert.rejects(f.outbound.send({sessionId,bindingId:'forged',text:'secret',idempotencyKey:'x'}),{code:'outbound-binding-denied'});
  f.configs.feishu.allowedGroups=[];
  await assert.rejects(f.outbound.send({sessionId,text:'secret',idempotencyKey:'x'}),{code:'outbound-target-unavailable'});
  assert.equal(f.bridge.store.get('bogus'),undefined);
  assert(binding.id);
 }finally{await f.close()}
});
test('ambiguous multiple bindings require an exact session-owned binding id',async()=>{
 const f=fixture();try{
  const feishu=f.bind();
  f.bind({provider:'discord'});
  f.online();
  await assert.rejects(f.outbound.send({sessionId,text:'news',idempotencyKey:'a'}),{code:'outbound-target-ambiguous'});
  const ok=await f.outbound.send({sessionId,bindingId:feishu.id,text:'news',idempotencyKey:'a'});
  assert.equal(ok.state,'sent');assert.equal(f.sent.length,1);
 }finally{await f.close()}
});
test('offline sends wait in the existing queue and drain exactly once after connection',async()=>{
 const f=fixture();try{
  f.bind();const queued=await f.outbound.send({sessionId,text:'offline',idempotencyKey:'a'});
  assert.equal(queued.state,'pending');assert.equal(f.sent.length,0);
  f.online();await f.bridge.idle();
  assert.equal(f.sent.length,1);assert.equal(f.bridge.store.get(queued.id).state,'sent');
  await f.outbound.send({sessionId,text:'offline',idempotencyKey:'a'});assert.equal(f.sent.length,1);
 }finally{await f.close()}
});
test('ambiguous transport failures remain uncertain and are never automatically retried',async()=>{
 const f=fixture();try{
  f.bind();f.online('feishu','bot',async()=>{throw Error('transport connection dropped')});
  const value=await f.outbound.send({sessionId,text:'ambiguous',idempotencyKey:'one'});
  assert.equal(value.state,'uncertain');
  const retry=await f.outbound.send({sessionId,text:'ambiguous',idempotencyKey:'one'});
  assert.equal(retry.state,'uncertain');assert.equal(f.bridge.store.pending('feishu','bot').length,0);
 }finally{await f.close()}
});
test('empty text, oversize payloads and missing stable keys cannot enter the send queue',async()=>{
 const f=fixture();try{
  f.bind();
  for(const req of [{text:'',idempotencyKey:'a'},{text:'x'.repeat(33000),idempotencyKey:'a'},{text:'good'}])
   await assert.rejects(f.outbound.send({sessionId,...req}));
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM channel_deliveries').get().n,0);
 }finally{await f.close()}
});

test('model tool returns native text blocks instead of a raw JSON string',()=>{
 const body=renderProactiveToolResult({}, {id:'key-1',state:'sent'});
 assert(Array.isArray(body));
 assert.deepEqual(body,[{type:'text',text:'{"id":"key-1","state":"sent"}'}]);
});

test('DM delivery rechecks the current allowlist; revoking a user blocks their old route',async()=>{
 const f=fixture({config:{allowedUsers:['alice'],dmPolicy:'allowlist',ownerMode:'manual',ownerUserId:'bob'}});
 try{
  f.bind({kind:'dm',conversationId:'p2p-alice',userId:'alice'});
  f.online();
  const ok=await f.outbound.send({sessionId,text:'hello',idempotencyKey:'before-revoke'});
  assert.equal(ok.state,'sent');
  f.configs.feishu.allowedUsers=[];
  await assert.rejects(f.outbound.send({sessionId,text:'after revoke',idempotencyKey:'after-revoke'}),{code:'outbound-target-unavailable'});
  assert.equal(f.sent.length,1);
 }finally{await f.close()}
});
test('claimed owner can receive a proactive DM without a separate user allowlist',async()=>{
 const f=fixture({config:{allowedUsers:[],dmPolicy:'allowlist',ownerMode:'first-dm'}});
 try{
  f.bind({kind:'dm',conversationId:'p2p-owner',userId:'owner'});
  f.store.claimOwner({kind:'dm',provider:'feishu',accountId:'bot',userId:'owner'});
  f.online();
  const ok=await f.outbound.send({sessionId,text:'owner notice',idempotencyKey:'owner-1'});
  assert.equal(ok.state,'sent');assert.equal(f.sent.length,1);
 }finally{await f.close()}
});

test('Feishu image outbound sends only a validated workspace image and reuses the same durable key',async()=>{
 const f=fixture(),root=mkdtempSync(path.join(os.tmpdir(),'dsh-outbound-picture-'));
 try{
  mkdirSync(path.join(root,'_scratch'));
  const imagePath=path.join(root,'_scratch','picture.png');
  writeFileSync(imagePath,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/afcAAAAASUVORK5CYII=','base64'));
  f.bind();f.online();
  const req={sessionId,imagePath,workspacePath:root,idempotencyKey:'image-test'};
  const sent=await f.outbound.send(req);
  assert.equal(sent.state,'sent');assert.equal(sent.contentType,'image');
  assert.equal(f.sent.length,1);
  assert.equal(f.sent[0].body.imagePath,imagePath);
  assert.equal(f.sent[0].body.imageDigest.length,64);
  assert.equal((await f.outbound.send(req)).state,'sent');
  assert.equal(f.sent.length,1,'same idempotency key must not upload again');
  const archived=f.bridge.store.db.prepare('SELECT text FROM channel_outbound_archive WHERE delivery_id=?').get(sent.id);
  assert.equal(archived.text,'[图片] picture.png');
  const outside=path.resolve(root,'..','image-outside.png');
  await assert.rejects(f.outbound.send({...req,imagePath:outside,idempotencyKey:'another'}));
  assert.equal(f.sent.length,1);
 }finally{await f.close();rmSync(root,{recursive:true,force:true})}
});
test('image sending is blocked before queuing if the bound provider is not Feishu',async()=>{
 const f=fixture(),root=mkdtempSync(path.join(os.tmpdir(),'dsh-outbound-picture-'));
 try{
  const file=path.join(root,'image.png');writeFileSync(file,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/afcAAAAASUVORK5CYII=','base64'));
  f.bind({provider:'discord'});f.online('discord');
  await assert.rejects(f.outbound.send({sessionId,imagePath:file,workspacePath:root,idempotencyKey:'image-discord'}),{code:'outbound-image-provider-unsupported'});
  assert.equal(f.sent.length,0);
 }finally{await f.close();rmSync(root,{recursive:true,force:true})}
});

test('file send uses the same durable outbound ledger and idempotency as images',async()=>{
 const f=fixture(),root=mkdtempSync(path.join(os.tmpdir(),'dsh-file-'));
 try{
  const filePath=path.join(root,'test-report.pdf');
  writeFileSync(filePath,Buffer.from('%PDF-1.7\n1 0 obj\nendobj\n%%EOF'));
  f.bind();f.online();
  const req={sessionId,filePath,workspacePath:root,idempotencyKey:'report-20261018'};
  const first=await f.outbound.send(req);
  assert.equal(first.state,'sent');assert.equal(first.contentType,'file');assert.equal(first.fileName,'test-report.pdf');
  assert.equal(f.sent.length,1);
  assert.equal(f.sent[0].body.filePath,filePath);
  assert.equal(f.sent[0].body.fileDigest.length,64);
  assert.equal((await f.outbound.send(req)).state,'sent');
  assert.equal(f.sent.length,1);
  const archived=f.bridge.store.db.prepare('SELECT text FROM channel_outbound_archive WHERE delivery_id=?').get(first.id);
  assert.equal(archived.text,'[文件] test-report.pdf');
  writeFileSync(filePath,Buffer.from('%PDF-1.7\n2 0 obj\nendobj\n%%EOF'));
  await assert.rejects(f.outbound.send(req),{code:'outbound-idempotency-conflict'});
  assert.equal(f.sent.length,1);
 }finally{await f.close();rmSync(root,{recursive:true,force:true});}
});
test('ordinary file send rejects unauthorized Discord targets, mixed attachments and file captions',async()=>{
 const f=fixture(),root=mkdtempSync(path.join(os.tmpdir(),'dsh-file-'));
 try{
  const filePath=path.join(root,'report.pdf');
  writeFileSync(filePath,Buffer.from('%PDF-1.4\nendobj\n%%EOF'));
  f.bind({provider:'discord'});f.online('discord');
  await assert.rejects(f.outbound.send({sessionId,filePath,workspacePath:root,idempotencyKey:'one'}),{code:'outbound-file-provider-unsupported'});
  await assert.rejects(f.outbound.send({sessionId,filePath,imagePath:filePath,workspacePath:root,idempotencyKey:'two'}),{code:'outbound-media-ambiguous'});
  await assert.rejects(f.outbound.send({sessionId,filePath,workspacePath:root,text:'Here is the file',idempotencyKey:'three'}),{code:'outbound-file-caption-unsupported'});
  assert.equal(f.sent.length,0);
 }finally{await f.close();rmSync(root,{recursive:true,force:true});}
});
