import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { schema } from '../config.js';
import { renderProgress } from '../progress.js';
import { createTransport } from '../transport.js';

function fixture(streaming=schema.defaults.streaming){
 const events=new EventEmitter(),calls=[];
 const channel={isTextBased:()=>true,messages:{edit:async(id,body)=>{calls.push({type:'edit',id,body});return {id};}},send:async body=>{const id='reply-'+calls.length;calls.push({type:'send',id,body});return {id};}};
 class Client{constructor(){this.user={id:'bot'};this.application={commands:{create:async()=>{}}};this.channels={fetch:async()=>{calls.push({type:'fetch'});return channel;}};}on(...args){events.on(...args);}off(...args){events.off(...args);}async login(){}async destroy(){}}
 const sdk={Client,Options:{cacheWithLimits:()=>()=>{}},GatewayIntentBits:{Guilds:1,GuildMessages:2,DirectMessages:3,MessageContent:4},Partials:{Channel:1}};
 return {calls,events,create:()=>createTransport({config:schema.validate({streaming}),credentials:['test-fixture'],signal:new AbortController().signal,receive:async()=>{},state:()=>{},action:async()=>{},sessions:async()=>[]},sdk)};
}
const origin={conversationId:'private',messageId:'input',userId:'user'};

test('streaming settings migrate booleans, merge progress defaults and reject malformed input',()=>{
 assert.equal(schema.validate({streaming:true}).streaming.mode,'progress');assert.equal(schema.validate({streaming:false}).streaming.mode,'off');
 const value=schema.validate({dmPolicy:'all',groupPolicy:'all',streaming:{mode:'partial',progress:{maxLines:2}}});assert.equal(value.dmPolicy,'all');assert.equal(value.groupPolicy,'all');assert.equal(value.streaming.progress.maxLines,2);assert(value.streaming.progress.toolProgress);
 for(const streaming of [null,[],{mode:'block'},{mode:null},{mode:'progress',progress:null},{unexpected:true},{progress:{maxLines:0}},{progress:{maxLineChars:301}},{progress:{commentary:'yes'}},{progress:{narration:'yes'}},{progress:{toolDetail:'yes'}},{progress:{commandText:'raw'}}])assert.throws(()=>schema.validate({streaming}),error=>error.code==='invalid-config');
});

test('narration and tool detail are opt-in, bounded and scrubbed',()=>{
 const body={status:'tool-running',text:'',activity:{commentary:'',narration:'先看目录结构\n再读 DESIGN.md 确认',tools:[{name:'read',status:'running',detail:'DESIGN.md'},{name:'pwsh',status:'completed',detail:'npm pack'}]}};
 const quiet=schema.validate({streaming:{mode:'progress',progress:{maxLines:4,maxLineChars:60}}}).streaming;
 const text=renderProgress(body,quiet);
 assert(!text.includes('💭'));
 assert(text.includes('⏳ 读取文件 · DESIGN.md'));assert(text.includes('✅ 执行命令 · npm pack'));
 const narrated=schema.validate({streaming:{mode:'progress',progress:{narration:true,maxLines:4,maxLineChars:60}}}).streaming;
 assert(renderProgress(body,narrated).includes('💭 再读 DESIGN.md 确认'));
 const bare=schema.validate({streaming:{mode:'progress',progress:{toolDetail:false}}}).streaming;
 assert(!renderProgress(body,bare).includes('DESIGN.md'));
 const long=schema.validate({streaming:{mode:'progress',progress:{narration:true,maxLines:2,maxLineChars:40}}}).streaming;
 assert(renderProgress({...body,activity:{...body.activity,narration:'x'.repeat(500)}},long).split('\n').every(line=>line.length<=40));
});

test('progress rendering keeps recent tools within Unicode and message bounds',()=>{
 const settings=schema.validate({streaming:{mode:'progress',progress:{maxLines:3,maxLineChars:40}}}).streaming;
 const body={status:'tool-running',text:'PRIVATE-DRAFT',activity:{commentary:'公开说明\n'+ '🐋'.repeat(3000),tools:Array.from({length:20},(_,i)=>({name:'tool-'+i,status:i===19?'failed':'completed'}))}};
 const text=renderProgress(body,settings),lines=text.split('\n');
 assert.equal(lines.length,4);assert(lines.slice(1).every(line=>line.length<=40));assert(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(text));assert(text.includes('tool-18'));assert(text.includes('❌ tool-19'));assert(!text.includes('tool-17'));assert(!text.includes('PRIVATE-DRAFT'));
 const largest=schema.validate({streaming:{progress:{maxLines:12,maxLineChars:300}}}).streaming;
 const long=renderProgress({...body,activity:{tools:Array.from({length:20},()=>({name:'🐋'.repeat(400),status:'running'}))}},largest);assert(long.length<=1900);assert(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(long));
 const quiet=schema.validate({streaming:{progress:{toolProgress:false,commentary:false}}}).streaming;assert.equal(renderProgress(body,quiet).split('\n').length,1);
});

test('progress edits one message, coalesces identical updates, preserves questions and delivers final body',async()=>{
 const f=fixture(),transport=await f.create();try{
  await transport.progress(origin,{status:'generating',text:'draft-1'});
  for(let i=0;i<10;i++)await transport.progress(origin,{status:'generating',text:'draft-'+i});
  assert.equal(f.calls.filter(call=>call.type==='fetch').length,1);assert.equal(f.calls.filter(call=>call.type==='send').length,1);assert.equal(f.calls.filter(call=>call.type==='edit').length,0);
  const body={status:'tool-running',text:'PRIVATE-DRAFT',activity:{commentary:'检查中',tools:[{name:'web_search',status:'running'}]}};
  await transport.progress(origin,body);assert(f.calls.at(-1).body.content.includes('⏳ 网页搜索'));assert(!f.calls.at(-1).body.content.includes('PRIVATE-DRAFT'));
  await transport.question(origin,{status:'waiting-user',text:'请选择回答 @everyone'},[{label:'同意',token:'protected'}]);assert(f.calls.at(-1).body.content.includes('请选择回答'));assert.equal(f.calls.at(-1).body.components[0].components[0].custom_id,'dsh:protected');assert.deepEqual(f.calls.at(-1).body.allowedMentions.parse,[]);
  await transport.send(origin,{status:'completed',text:'完整最终回答',id:'final'});assert.equal(f.calls.at(-1).body.content,'完整最终回答');assert.deepEqual(f.calls.at(-1).body.components,[]);assert.equal(f.calls.filter(call=>call.type==='send').length,1);
  await transport.progress({...origin,messageId:'next'},{status:'thinking'});assert.equal(f.calls.filter(call=>call.type==='send').length,2);
 }finally{await transport.close();}assert.equal(f.events.eventNames().length,0);
});

test('partial streams public text while off keeps questions and final delivery',async()=>{
 const partial=fixture({mode:'partial'}),preview=await partial.create();try{await preview.progress(origin,{status:'generating',text:'正文第一段'});await preview.progress(origin,{status:'generating',text:'正文第二段'});assert(partial.calls.at(-1).body.content.includes('正文第二段'));assert.equal(partial.calls.filter(call=>call.type==='edit').length,1);}finally{await preview.close();}
 const off=fixture({mode:'off'}),quiet=await off.create();try{assert.equal(quiet.progress,undefined);await quiet.question(origin,{status:'waiting-approval',text:'确认执行？'},[]);await quiet.send(origin,{status:'cancelled',text:'本轮已停止。'});assert.equal(off.calls.filter(call=>call.type==='send').length,1);assert(off.calls.at(-1).body.content.includes('已停止'));}finally{await quiet.close();}
});
