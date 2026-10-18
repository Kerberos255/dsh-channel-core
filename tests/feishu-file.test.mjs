import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {validateWorkspaceFile,verifyQueuedFile} from '../lib/outbound-file.js';
import {validateWorkspaceImage} from '../lib/outbound-image.js';
import {createTransport} from '../channels/feishu/transport.js';

const PDF=Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n');
const OFFICE=Buffer.concat([Buffer.from([0x50,0x4b,0x03,0x04]),Buffer.alloc(100)]);
function scratch(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-channel-file-'));
 fs.mkdirSync(path.join(root,'_scratch'));
 const put=(name,data)=>{const p=path.join(root,'_scratch',name);fs.writeFileSync(p,data);return p;};
 return {root,put,cleanup:()=>fs.rmSync(root,{recursive:true,force:true})};
}
test('PDF / Office / ZIP / text files pass workspace path, size and content validation',()=>{
 const f=scratch();try{
  for(const [name,data] of [['report.pdf',PDF],['工作簿.xlsx',OFFICE],['letter.docx',OFFICE],
    ['slides.pptx',OFFICE],['archive.zip',OFFICE],['notes.txt',Buffer.from('测试文件\n')],
    ['data.csv',Buffer.from('a,b\n1,2\n')]]){
   const image=f.put(name,data),value=validateWorkspaceFile(image,f.root);
   assert.equal(value.fileName,name);
   assert.equal(value.fileDigest.length,64);
   assert.deepEqual(verifyQueuedFile(value),{filePath:fs.realpathSync(image),fileName:name});
  }
 }finally{f.cleanup();}
});
test('file requests reject directory traversal, symlink escape, forbidden types, spoofing, empty and oversize files',()=>{
 const f=scratch(),external=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-outside-file-'));
 try{
  const valid=f.put('report.pdf',PDF);
  const info=validateWorkspaceFile(valid,f.root);
  fs.appendFileSync(valid,'changed');assert.throws(()=>verifyQueuedFile(info),{code:'outbound-file-content-changed'});
  const wrong=f.put('report-fake.pdf',Buffer.from('not-pdf'));assert.throws(()=>validateWorkspaceFile(wrong,f.root),{code:'outbound-file-magic-invalid'});
  const exe=f.put('danger.exe',Buffer.from('MZ'));assert.throws(()=>validateWorkspaceFile(exe,f.root),{code:'outbound-file-format-unsupported'});
  const binary=f.put('notes.txt',Buffer.from([65,0,66]));assert.throws(()=>validateWorkspaceFile(binary,f.root),{code:'outbound-file-magic-invalid'});
  const empty=f.put('empty.txt',Buffer.alloc(0));assert.throws(()=>validateWorkspaceFile(empty,f.root),{code:'outbound-file-size-invalid'});
  const large=path.join(f.root,'_scratch','large.pdf');fs.writeFileSync(large,PDF);fs.truncateSync(large,30*1024*1024+1);
  assert.throws(()=>validateWorkspaceFile(large,f.root),{code:'outbound-file-size-invalid'});
  const outside=path.join(external,'secret.txt');fs.writeFileSync(outside,'secrets');
  assert.throws(()=>validateWorkspaceFile(outside,f.root),{code:'outbound-file-outside-workspace'});
  const link=path.join(f.root,'_scratch','indirect.txt');
  fs.symlinkSync(outside,link);
  assert.throws(()=>validateWorkspaceFile(link,f.root),{code:'outbound-file-outside-workspace'});
 }finally{f.cleanup();fs.rmSync(external,{recursive:true,force:true});}
});
test('existing image path is unaffected by common-media refactor',()=>{
 const f=scratch();try{
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/afcAAAAASUVORK5CYII=','base64');
  const p=f.put('picture.png',png);
  assert.equal(validateWorkspaceImage(p,f.root).imageBytes,png.length);
 }finally{f.cleanup();}
});
test('Feishu SDK receives native file payload (fileName preserved), not a text link',async()=>{
 const f=scratch();try{
  const source=f.put('工作簿.xlsx',OFFICE),verified=validateWorkspaceFile(source,f.root),sent=[];
  const channel={send:async(...x)=>{sent.push(x);return {messageId:'om_file'};},on:()=>()=>{},disconnect:async()=>{},connect:async()=>{}};
  const config={throttleMs:120,streaming:{mode:'off',cardEngine:'patch',footer:{}},
   domain:'feishu',allowedUsers:[],allowedGroups:[],maxAttachmentMB:30};
  const transport=await createTransport({config,credentials:['id','secret'],signal:new AbortController().signal,
   receive:async()=>{},state:()=>{},action:async()=>{},host:{}},
   {createLarkChannel:()=>channel,Domain:{Feishu:'feishu'}});
  const result=await transport.send({conversationId:'chat-test',kind:'group'},verified);
  assert.equal(result.messageId,'om_file');
  assert.equal(sent.length,1);
  assert.deepEqual(sent[0][1],{file:{source:source,fileName:'工作簿.xlsx'}});
  await transport.close();
 }finally{f.cleanup();}
});
