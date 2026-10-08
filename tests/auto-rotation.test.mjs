import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {CoreStore} from '../lib/store.js';
import {routeKeys} from '../lib/routing.js';
import {rotateTrustedDM} from '../lib/safe-rotate.js';
import {isOwnerChannelSession} from '../lib/memory-access.js';

function harness({extraScope=false,pending=false,seq=28}={}){
 const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-binding-auto-'));
 const dreamText='confirmed dream report';
 fs.writeFileSync(path.join(cwd,'DREAMS.md'),dreamText);
 const artifactHash=createHash('sha256').update(dreamText).digest('hex');
 const memoryRunId='memory-run-1234';
 const memoryRow={state:'completed',result:JSON.stringify({state:'completed',staged:0,promoted:0,rejected:0,artifacts:[{path:'DREAMS.md',hash:artifactHash}]})};
 const memoryDreaming={configFile:{value:{enabled:true,autoPromote:true,ownerIdentityId:'owner'}},memory:{scope(){return'scope-test';},db:{prepare(){return {get(){return memoryRow;}};}}}};
 const store=new CoreStore(':memory:');
 const previous='session-old-12345',next='session-new-12345';
 const scope={workspaceId:'default',presetId:'agent',identityId:'identity-common',memoryNamespace:'private',scheduleNamespace:'private'};
 const key=routeKeys({kind:'dm'},scope,true).routeKey;
 store.db.prepare('INSERT INTO scope_sessions VALUES(?,?)').run(key,previous);
 for(const [provider,userId] of [['feishu','u-feishu'],['discord','u-discord']]){
  store.setOwner(provider,'bot-'+provider,userId);
  const msg={kind:'dm',provider,accountId:'bot-'+provider,conversationId:'conversation-'+provider,userId};
  store.putBinding(routeKeys(msg,scope,true).bindingKey,{...msg,scope,sessionId:previous});
 }
 if(extraScope){
  const other={...scope,identityId:'identity-different'};
  const msg={kind:'dm',provider:'discord',accountId:'other-bot',conversationId:'different',userId:'other'};
  store.setOwner('discord','other-bot','other');
  store.putBinding(routeKeys(msg,other,true).bindingKey,{...msg,scope:other,sessionId:previous});
 }
 if(pending)store.claim({key:'receipt-key',requestId:'request-key',sessionId:previous,origin:{},payload:{x:1}});
 const query={async observeSession(id){return{header:{id,cwd,agentPreset:'agent'},projections:{values:{agentPreset:'agent'}},events:[{seq}], [Symbol.dispose](){} }}};
 const core={closed:false,store,configFile:{value:{sharedDM:true}},coordinator:{tails:new Map()},commandTasks:new Map(),ctx:{get(name){return name==='sessionQuery'?query:name==='agents'?{get(){return{status:'idle',inbox:{hasPending(){return false;}}};}}:name==='memoryDreaming'?memoryDreaming:null;}}};
 return {cwd,store,core,scope,key,previous,next,artifactHash,memoryRunId,memoryRow,close(){store.close();fs.rmSync(cwd,{force:true,recursive:true});}};
}

test('atomic shared-DM switch moves Feishu and Discord together and preserves old native session',async()=>{
 const h=harness();
 try{
  const response=await rotateTrustedDM(h.core,{previous:h.previous,next:h.next,ownerIdentityId:'owner',cwd:h.cwd,preset:'agent',expectedSeq:28,memoryRunId:h.memoryRunId,artifactHash:h.artifactHash});
  assert.equal(response.rotated,true);assert.equal(response.bindings,2);
  assert.equal(h.store.db.prepare('SELECT COUNT(*) AS n FROM bindings WHERE session_id=?').get(h.previous).n,0);
  assert.equal(h.store.db.prepare('SELECT COUNT(*) AS n FROM bindings WHERE session_id=?').get(h.next).n,2);
  assert.equal(h.store.db.prepare('SELECT session_id FROM scope_sessions WHERE scope_key=?').get(h.key).session_id,h.next);
  assert.equal(h.store.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE kind='auto-rotation'").get().n,1);
  assert.equal(h.store.db.prepare('SELECT COUNT(*) AS n FROM archived_dm_sessions WHERE session_id=?').get(h.previous).n,1);
  assert.equal(isOwnerChannelSession(h.store,h.previous,'owner'),true,'archived session keeps verified ownership for future memory source checks');
 }finally{h.close();}
});
test('mixed-identity bindings never partially switch',async()=>{
 const h=harness({extraScope:true});
 try{
  await assert.rejects(rotateTrustedDM(h.core,{previous:h.previous,next:h.next,ownerIdentityId:'owner',cwd:h.cwd,preset:'agent',expectedSeq:28,memoryRunId:h.memoryRunId,artifactHash:h.artifactHash}),/不同的共享会话范围/);
  assert.equal(h.store.db.prepare('SELECT COUNT(*) AS n FROM bindings WHERE session_id=?').get(h.previous).n,3);
  assert.equal(h.store.db.prepare('SELECT COUNT(*) AS n FROM bindings WHERE session_id=?').get(h.next).n,0);
 }finally{h.close();}
});
test('unsettled channel receipts block automatic switch',async()=>{
 const h=harness({pending:true});
 try{
  await assert.rejects(rotateTrustedDM(h.core,{previous:h.previous,next:h.next,ownerIdentityId:'owner',cwd:h.cwd,preset:'agent',expectedSeq:28,memoryRunId:h.memoryRunId,artifactHash:h.artifactHash}),/未确认的渠道输入/);
  assert.equal(h.store.db.prepare('SELECT COUNT(*) AS n FROM bindings WHERE session_id=?').get(h.next).n,0);
 }finally{h.close();}
});
test('observed transcript changes prevent rebinding',async()=>{
 const h=harness({seq:29});
 try{
  await assert.rejects(rotateTrustedDM(h.core,{previous:h.previous,next:h.next,ownerIdentityId:'owner',cwd:h.cwd,preset:'agent',expectedSeq:28,memoryRunId:h.memoryRunId,artifactHash:h.artifactHash}),/事件游标不匹配/);
  assert.equal(h.store.db.prepare('SELECT COUNT(*) AS n FROM bindings WHERE session_id=?').get(h.next).n,0);
 }finally{h.close();}
});

test('invalid Dream proof stops rebinding even for a trusted owner',async()=>{
 const h=harness();
 try{
  await assert.rejects(rotateTrustedDM(h.core,{previous:h.previous,next:h.next,ownerIdentityId:'owner',cwd:h.cwd,preset:'agent',expectedSeq:28,memoryRunId:h.memoryRunId,artifactHash:'0'.repeat(64)}),/校验值不匹配/);
  assert.equal(h.store.db.prepare('SELECT COUNT(*) AS n FROM bindings WHERE session_id=?').get(h.previous).n,2);
 }finally{h.close();}
});

test('revoked account owner invalidates historic source proof',async()=>{
 const h=harness();
 try{
  await rotateTrustedDM(h.core,{previous:h.previous,next:h.next,ownerIdentityId:'owner',cwd:h.cwd,preset:'agent',expectedSeq:28,memoryRunId:h.memoryRunId,artifactHash:h.artifactHash});
  assert.equal(isOwnerChannelSession(h.store,h.previous,'owner'),true);
  h.store.setOwner('discord','bot-discord','somebody-else');
  assert.equal(isOwnerChannelSession(h.store,h.previous,'owner'),false);
 }finally{h.close();}
});
