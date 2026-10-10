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
 assert(renderProgress(body,narrated).includes('💭 思考\n先看目录结构\n再读 DESIGN.md 确认'));
 const bare=schema.validate({streaming:{mode:'progress',progress:{toolDetail:false}}}).streaming;
 assert(!renderProgress(body,bare).includes('DESIGN.md'));
 const long=schema.validate({streaming:{mode:'progress',progress:{narration:true,maxLines:2,maxLineChars:40}}}).streaming;
 assert(renderProgress({...body,activity:{...body.activity,narration:'x'.repeat(500)}},long).length<=1900);
 assert(renderProgress({...body,activity:{...body.activity,narration:'x'.repeat(5000)}},long).includes('前文已截断'));
});

test('progress rendering keeps recent tools within Unicode and message bounds',()=>{
 const settings=schema.validate({streaming:{mode:'progress',progress:{maxLines:3,maxLineChars:40}}}).streaming;
 const body={status:'tool-running',text:'PRIVATE-DRAFT',activity:{commentary:'公开说明\n'+ '🐋'.repeat(3000),tools:Array.from({length:20},(_,i)=>({name:'tool-'+i,status:i===19?'failed':'completed'}))}};
 const text=renderProgress(body,settings),lines=text.split('\n');
 assert.equal(lines.filter(Boolean).length,4,'blank lines only separate visual sections');assert(lines.filter(Boolean).slice(1).every(line=>line.length<=40));assert(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(text));assert(text.includes('tool-18'));assert(text.includes('❌ tool-19'));assert(!text.includes('tool-17'));assert(!text.includes('PRIVATE-DRAFT'));
 const largest=schema.validate({streaming:{progress:{maxLines:12,maxLineChars:300}}}).streaming;
 const long=renderProgress({...body,activity:{tools:Array.from({length:20},()=>({name:'🐋'.repeat(400),status:'running'}))}},largest);assert(long.length<=1900);assert(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(long));
 const quiet=schema.validate({streaming:{progress:{toolProgress:false,commentary:false}}}).streaming;assert.equal(renderProgress(body,quiet).split('\n').length,1);
});

test('progress edits one message, coalesces identical updates, preserves questions and delivers final body',async()=>{
 const f=fixture(),transport=await f.create();try{
  await transport.progress(origin,{status:'generating',text:'draft-1'});
  for(let i=0;i<10;i++)await transport.progress(origin,{status:'generating',text:'draft-'+i});
  assert.equal(f.calls.filter(call=>call.type==='fetch').length,2,'typing heartbeat and first message each resolve the channel once');assert.equal(f.calls.filter(call=>call.type==='send').length,1);assert.equal(f.calls.filter(call=>call.type==='edit').length,0);
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

test('completed Discord progress edits to body only, with no preserved spoiler',async()=>{
 const streaming=schema.validate({streaming:{mode:'progress',progress:{narration:true}}}).streaming;
 const f=fixture(streaming),t=await f.create();
 try{
  const dm={...origin,kind:'dm'};
  await t.progress(dm,{status:'tool-running',activity:{timeline:[{type:'draft',text:'草稿一'},{type:'tool',activity:{name:'pwsh',status:'running'}}],activeDraft:'草稿二'}});
  await t.send(dm,{status:'completed',final:true,drafts:['PRIVATE-草稿一','PRIVATE-草稿二'],text:'完整正文'});
  const edits=f.calls.filter(call=>call.type==='edit');
  assert.equal(edits.length,1);
  assert.equal(edits[0].body.content,'完整正文');
  assert.deepEqual(edits[0].body.allowedMentions.parse,[]);
  assert.equal(f.calls.filter(call=>call.type==='send').length,1);
  assert(!JSON.stringify(f.calls.at(-1)).includes('PRIVATE'));
 }finally{await t.close()}
});

test('Discord final remains body-only in groups, and long answers split without leaking drafts',async()=>{
 const streaming=schema.validate({streaming:{mode:'progress',progress:{narration:true}}}).streaming;
 const f=fixture(streaming),t=await f.create();
 try{
  const group={...origin,kind:'group'};
  await t.progress(group,{status:'thinking'});
  const long='回答'.repeat(2000);
  await t.send(group,{status:'completed',final:true,drafts:['PRIVATE-DRAFT'],text:long});
  const outputs=[...f.calls.filter(x=>x.type==='edit').map(x=>x.body.content),...f.calls.filter(x=>x.type==='send').slice(1).map(x=>x.body.content)];
  assert.equal(outputs.join(''),long);
  assert(outputs.every(x=>x.length<=1900));
  assert(!JSON.stringify(f.calls).includes('PRIVATE-DRAFT'));
 }finally{await t.close()}
});

test('Discord safely fits a long draft/thought timeline into one message without hiding final tools or footer',()=>{
 const progress=schema.validate({streaming:{mode:'progress',progress:{narration:true,draftMaxChars:900,maxLines:5,maxLineChars:120}}}).streaming;
 const timeline=[
   {type:'draft',text:'思考'.repeat(500)},
   {type:'public-draft',text:'草稿'.repeat(500)},
   {type:'tool',activity:{name:'pwsh',status:'running',detail:'npm test'}},
   {type:'draft',text:'分析'.repeat(500)},
   {type:'public-draft',text:'结论'.repeat(500)},
   {type:'tool',activity:{name:'read_file',status:'completed',detail:'README.md'}},
 ];
 const footer='deepseek/v4 · 上下文 32k/1M tokens';
 const rendered=renderProgress({status:'tool-running',activity:{timeline}},progress,footer,{icon:'🐋',name:'小虎鲸'});
 assert(rendered.length<=1900,rendered.length);
 assert(rendered.startsWith('**🐋 小虎鲸 · '));
 assert(rendered.includes('README.md'),'newest tool entry must not be lost');
 assert(rendered.includes('📝 草稿 · '));
 assert(rendered.includes('💭 '));
 assert(rendered.endsWith('-# '+footer),'footer must remain complete');
 assert(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(rendered));
});
test('Discord can render an actual 600-character single draft without shrinking unnecessarily',()=>{
 const opts=schema.defaults.streaming;
 const words='模型运行进度'.repeat(75);
 const body={status:'generating',activity:{timeline:[{type:'public-draft',text:words}]}};
 const rendered=renderProgress(body,{...opts,progress:{...opts.progress,commentary:true}},'',{icon:'🐋',name:'小虎鲸'});
 assert(rendered.includes(words));
 assert(rendered.length<1900);
});

test('Discord configurable draft budget validates bounds without changing the tool-summary budget',()=>{
 assert.equal(schema.defaults.streaming.progress.draftMaxChars,600);
 assert.equal(schema.defaults.streaming.progress.maxLineChars,120);
 assert.equal(schema.validate({streaming:{progress:{draftMaxChars:1000}}}).streaming.progress.draftMaxChars,1000);
 for(const invalid of [0,119,1001,NaN,'600',600.1])
   assert.throws(()=>schema.validate({streaming:{progress:{draftMaxChars:invalid}}}));
});
test('Discord extreme 12-row narrative stream preserves header, last tools and footer within budget',()=>{
 const settings=schema.validate({streaming:{progress:{narration:true,draftMaxChars:1000,maxLines:12,maxLineChars:120}}}).streaming;
 const timeline=Array.from({length:12},(_,i)=>i%3===0?{type:'tool',activity:{name:'pwsh',detail:'tool-'+i,status:'completed'}}:{type:i%2===0?'draft':'public-draft',text:'🪼'.repeat(800)+'最后'+i});
 const footer='model · 上下文 158k/1M tokens';
 const rendered=renderProgress({status:'tool-running',activity:{timeline}},settings,footer,{name:'小虎鲸'});
 assert(rendered.length<=1900);
 assert(rendered.includes('tool-9'),'tool status should survive the budget');
 assert(rendered.includes('最后11'),'newest draft tail should survive the budget');
 assert(rendered.endsWith('-# '+footer));
 assert(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(rendered));
});

test('Discord progress uses readable paragraphs and grouped tools while keeping all section order',()=>{
 const settings=schema.validate({streaming:{progress:{narration:true,maxLines:5,draftMaxChars:600}}}).streaming;
 const activity={timeline:[
   {type:'public-draft',text:'段落一的文字\n\n段落二的文字'},
   {type:'tool',activity:{name:'read',status:'completed',detail:'A.md'}},
   {type:'draft',text:'先分析问题。\n\n再确定方案。'},
   {type:'tool',activity:{name:'pwsh',status:'running',detail:'npm test'}},
   {type:'tool',activity:{name:'glob',status:'completed',detail:'src/*.js'}},
 ]};
 const result=renderProgress({status:'thinking',activity},settings,'模型名 · 上下文 32k tokens',{name:'小虎鲸'});
 assert(result.startsWith('**🐋 小虎鲸 · 正在思考**\n\n'));
 assert(result.includes('💭 先分析问题。\n\n再确定方案。\n\n📝 草稿 · 段落一的文字\n\n段落二的文字'));
 assert(result.includes('📝 草稿 · 段落一的文字\n\n段落二的文字\n\n✅ 读取文件 · A.md'));
 assert(result.includes('✅ 读取文件 · A.md\n⏳ 执行命令 · npm test\n✅ 查找文件 · src/*.js'));
 assert(result.endsWith('\n\n-# 模型名 · 上下文 32k tokens'));
 assert(result.length<1900);
});
test('Discord preserves paragraph layout, last tool and footer under dense Unicode traffic',()=>{
 const settings=schema.validate({streaming:{progress:{narration:true,maxLines:12,draftMaxChars:1000}}}).streaming;
 const many=Array.from({length:12},(_,i)=>{
   if(i%3===0)return {type:'tool',activity:{name:'read_file',status:'completed',detail:'file-'+i}};
   return {type:i%2===0?'draft':'public-draft',text:'多行思考 🐋'.repeat(100)+'\n\n新段落'+i+'\n最新内容'+i};
 });
 const footer='opencode-go/deepseek-v4.1-flash · 上下文 335.7k/1M tokens';
 const result=renderProgress({status:'tool-running',activity:{timeline:many}},settings,footer,{name:'小虎鲸'});
 assert(result.length<=1900,result.length);
 assert(result.includes('file-9'),'retain latest tool summary');
 assert(result.includes('最新内容11'),'retain most recent draft');
 assert(result.includes('\n\n📝 草稿 · '),'show a visible break before draft');
 assert(result.endsWith('-# '+footer));
 assert(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(result));
});
