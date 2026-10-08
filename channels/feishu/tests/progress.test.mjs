import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { schema } from '../config.js';
import { card, createTransport } from '../transport.js';
import { ConfigFile } from '../../../lib/channel-plugin-settings/file-config.js';

const origin={provider:'feishu',accountId:'default',conversationId:'chat-test',userId:'user-test',messageId:'message-test'};

function fixture(streaming={mode:'progress'},behavior={}){
 const calls=[],listeners=new Map();
 const channel={
  on(name,fn){listeners.set(name,fn);return()=>listeners.delete(name);},
  async send(chatId,body,options){calls.push({type:'send',chatId,body,options});return {messageId:'card-'+calls.filter(c=>c.type==='send').length};},
  async updateCard(id,payload){calls.push({type:'update',id,payload});if(behavior.failUpdate){const error=new Error('mock-patch');error.status=behavior.failUpdate;throw error;}},
  async connect(){},async disconnect(){}
 };
 const sdk={createLarkChannel:()=>channel,Domain:{Lark:'lark',Feishu:'feishu'}};
 const create=()=>createTransport({config:schema.validate({streaming}),credentials:['fixture'],signal:new AbortController().signal,receive:async()=>{},state:()=>{},action:async()=>{}},sdk);
 return {calls,listeners,create,behavior};
}
const activity={tools:[{name:'read_file',status:'running',detail:'DESIGN.md'},{name:'pwsh',status:'completed',detail:'npm pack'}],commentary:'检查脚本',narration:'内部推理\n最后思考'};

test('schema migrates booleans, validates nested keys and defaults',()=>{
 assert.equal(schema.validate({streaming:true}).streaming.mode,'progress');
 assert.equal(schema.validate({streaming:false}).streaming.mode,'off');
 assert.equal(schema.defaults.streaming.progress.narration,false);
 assert.equal(schema.validate({streaming:{mode:'progress',progress:{maxLines:2}}}).streaming.progress.maxLines,2);
 for(const streaming of [null,[],{mode:'oops'},{progress:{narration:'yes'}},{progress:{maxLines:0}},{progress:{maxLineChars:301}},{other:true}])
  assert.throws(()=>schema.validate({streaming}),e=>e.code==='invalid-config');
});

test('progress card renders tool icons without leaking uncommitted draft',()=>{
 const config=schema.defaults.streaming;
 const body={status:'tool-running',text:'PRIVATE-DRAFT',final:false,activity};
 const rendered=card(body,[],config);
 const content=rendered.body.elements[0].content;
 assert(content.includes('⏳ 读取文件 · DESIGN.md'));assert(content.includes('✅ 执行命令 · npm pack'));
 assert(!content.includes('PRIVATE-DRAFT'));assert(!content.includes('内部推理'));
 assert.equal(rendered.header.title.content,'DeepSeek · 正在执行工具');
 const empty=card({status:'generating',text:'PRIVATE-DRAFT',activity:{}},[],config);
 assert.equal(empty.body.elements[0].content,'正在回复');
 const final=card({...body,final:true,text:'完整答复'},[],config);
 assert.equal(final.body.elements[0].content,'完整答复');
});

test('progress edits one card and skips identical payload; final replaces progress',async()=>{
 const f=fixture(),t=await f.create();try{
  const body={status:'tool-running',text:'DRAFT',final:false,activity};
  await t.progress(origin,body);await t.progress(origin,body);
  assert.equal(f.calls.filter(x=>x.type==='send').length,1);
  assert.equal(f.calls.filter(x=>x.type==='update').length,0);
  await t.progress(origin,{...body,activity:{...activity,tools:[{name:'read',status:'completed',detail:'notes.md'}]}});
  assert.equal(f.calls.filter(x=>x.type==='update').length,1);
  await t.question(origin,{status:'waiting-user',text:'请确认'},[{label:'允许',token:'fixture-token'}]);
  assert.equal(f.calls.at(-1).payload.body.elements[1].value.dsh,'fixture-token');
  await t.send(origin,{status:'completed',final:true,text:'已完成'});
  assert.equal(f.calls.at(-1).payload.body.elements.length,1);
  assert.equal(f.calls.at(-1).payload.body.elements[0].content,'已完成');
  await t.progress({...origin,messageId:'next'},{status:'thinking',text:'PRIVATE-DRAFT'});
  assert.equal(f.calls.filter(x=>x.type==='send').length,2);
 }finally{await t.close();}
});

test('partial mode emits public body, off removes progress but preserves final',async()=>{
 const f=fixture({mode:'partial'}),t=await f.create();try{
  await t.progress(origin,{status:'generating',text:'公开正文'});
  assert.equal(f.calls[0].body.card.body.elements[0].content,'公开正文');
 }finally{await t.close();}
 const quiet=fixture(false),q=await quiet.create();try{
  assert.equal(q.progress,undefined);
  await q.send(origin,{status:'completed',text:'最终答复'});
  assert.equal(quiet.calls[0].body.card.body.elements[0].content,'最终答复');
 }finally{await q.close();}
});

test('confirmed missing card falls back; unknown update failure never re-sends',async()=>{
 const gone=fixture({mode:'progress'},{failUpdate:404}),t=await gone.create();try{
  await t.progress(origin,{status:'thinking'});
  await t.progress(origin,{status:'generating'});
  assert.equal(gone.calls.filter(x=>x.type==='send').length,2);
 }finally{await t.close();}
 const unknown=fixture({mode:'progress'},{failUpdate:500}),q=await unknown.create();try{
  await q.progress(origin,{status:'thinking'});
  await assert.rejects(q.progress(origin,{status:'generating'}));
  assert.equal(unknown.calls.filter(x=>x.type==='send').length,1);
 }finally{await q.close();}
});

test('long final reply uses existing placeholder and plain markdown delivery',async()=>{
 const f=fixture(),t=await f.create();try{
  await t.progress(origin,{status:'thinking'});
  await t.send(origin,{status:'completed',final:true,text:'中'.repeat(7600)});
  assert(f.calls.some(x=>x.type==='update'));
  assert(f.calls.some(x=>x.type==='send'&&x.body.markdown?.length===7600));
 }finally{await t.close();}
});

test('legacy boolean is read/normalized/saved/reloaded using the actual ConfigFile',()=>{
 const here=path.dirname(fileURLToPath(import.meta.url));
 const temp=path.resolve(here,'../../../cache/temp');
 fs.mkdirSync(temp,{recursive:true});
 const directory=fs.mkdtempSync(path.join(temp,'feishu-progress-schema-'));
 const filename=path.join(directory,'config.json');
 fs.writeFileSync(filename,JSON.stringify({schemaVersion:1,streaming:true}));
 const config=new ConfigFile(filename,{...schema,watch:false});
 try{
  const before=config.snapshot();
  assert.equal(before.value.streaming.mode,'progress');
  const saved=config.save({...before.value,streaming:{...before.value.streaming,progress:{...before.value.streaming.progress,maxLines:4}}},before.revision);
  assert.equal(saved.value.streaming.progress.maxLines,4);
  assert.equal(JSON.parse(fs.readFileSync(filename,'utf8')).streaming.mode,'progress');
  const reloaded=config.reload();
  assert.equal(reloaded.value.streaming.progress.maxLines,4);
 }finally{config.close();}
});
