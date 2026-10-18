import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {validateWorkspaceImage,verifyQueuedImage} from '../lib/outbound-image.js';
import {finalizeCardKitMessage,createTransport} from '../channels/feishu/transport.js';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/afcAAAAASUVORK5CYII=','base64');
const scratch=()=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-channel-image-'));fs.mkdirSync(path.join(root,'_scratch'));const file=path.join(root,'_scratch','picture.png');fs.writeFileSync(file,png);return {root,file,cleanup:()=>fs.rmSync(root,{recursive:true,force:true})};};
test('workspace image paths are bounded, verified by actual file signature and content digest',()=>{
 const f=scratch();try{
  const image=validateWorkspaceImage(f.file,f.root);
  assert.equal(image.imagePath,fs.realpathSync(f.file));
  assert.equal(verifyQueuedImage(image),image.imagePath);
  assert.equal(image.imageBytes,png.length);
  assert.throws(()=>validateWorkspaceImage(path.resolve(f.root,'..','hidden.png'),f.root));
  fs.writeFileSync(f.file,Buffer.concat([png,Buffer.from('modified')]));
  assert.throws(()=>verifyQueuedImage(image),{code:'outbound-image-content-changed'});
  fs.writeFileSync(f.file,Buffer.alloc(16));
  assert.throws(()=>validateWorkspaceImage(f.file,f.root),{code:'outbound-image-magic-invalid'});
 }finally{f.cleanup()}
});
test('the Feishu SDK receives an actual image source, never a fake Markdown card',async()=>{
 const f=scratch();try{
  const image=validateWorkspaceImage(f.file,f.root);
  const sends=[];
  const channel={send:async(...args)=>{sends.push(args);return{messageId:'om_image'};},on:()=>()=>{},disconnect:async()=>{},connect:async()=>{}};
  const adapter=await createTransport({config:{throttleMs:120,streaming:{mode:'off',cardEngine:'patch',footer:{}},domain:'feishu',allowedUsers:[],allowedGroups:[],maxAttachmentMB:10},credentials:['id','secret'],signal:new AbortController().signal,receive:async()=>{},state:()=>{},action:async()=>{},host:{}},{createLarkChannel:()=>channel,Domain:{Feishu:'feishu'}});
  const result=await adapter.send({conversationId:'chat-1',kind:'group'},image);
  assert.equal(result.messageId,'om_image');
  assert.equal(sends.length,1);
  assert.deepEqual(sends[0][1],{image:{source:image.imagePath}});
  await adapter.close();
 }finally{f.cleanup()}
});
test('final card retries on SAME CardKit card without creating a second chat message',async()=>{
 const operations=[],record={streaming:true},payload={header:{title:{content:'completed'}}};
 const api={async close(){operations.push('close');throw Error('settings-not-ready')},async update(){operations.push('update')}};
 await finalizeCardKitMessage(api,record,payload);
 assert.deepEqual(operations,['close','update']);
 assert.equal(record.streaming,false);
 const errorApi={async close(){throw Error('failed')},async update(){throw Object.assign(Error('down'),{code:'KIT_FAILURE'})}};
 await assert.rejects(finalizeCardKitMessage(errorApi,{streaming:true},payload),{code:'KIT_FAILURE'});
});
