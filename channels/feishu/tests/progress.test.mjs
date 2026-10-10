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
  async connect(){},async disconnect(){},rawClient:behavior.rawClient
 };
 const sdk={createLarkChannel:()=>channel,Domain:{Lark:'lark',Feishu:'feishu'}};
 const create=()=>createTransport({config:schema.validate({streaming,...(behavior.config??{})}),credentials:['fixture'],signal:new AbortController().signal,receive:async()=>{},state:()=>{},action:async()=>{},host:behavior.host},sdk);
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
 assert.equal(rendered.header.title.content,'Agent · 正在执行工具');
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

test('long reply without drafts reuses progress for first card, then sends remaining answer cards',async()=>{
 const f=fixture(),t=await f.create();try{
  await t.progress(origin,{status:'thinking'});
  const original='中'.repeat(7600);
  await t.send(origin,{status:'completed',final:true,text:original});
  const edits=f.calls.filter(x=>x.type==='update'),sends=f.calls.filter(x=>x.type==='send');
  assert.equal(edits.length,1);
  assert(sends.length>1);
  const pieces=[edits[0].payload.body.elements[0].content,...sends.slice(1).map(x=>x.body.card.body.elements[0].content)];
  assert.equal(pieces.join(''),original);
  assert(pieces.every(x=>Buffer.byteLength(x,'utf8')<=9000));
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

test('final Feishu presentation keeps collapsed draft card separate from answer card',async()=>{
 const {draftCard,finalCards}=await import('../transport.js');
 const streaming=schema.validate({streaming:{mode:'progress',progress:{narration:true}}}).streaming;
 const body={final:true,status:'completed',drafts:['草稿一','草稿二'],text:'完整正文'};
 const folded=draftCard(body),answers=finalCards(body,streaming);
 assert.equal(folded.body.elements.length,1);
 assert.equal(folded.body.elements[0].tag,'collapsible_panel');
 assert.equal(folded.body.elements[0].expanded,false);
 assert(folded.body.elements[0].elements[0].content.includes('草稿一'));
 assert.deepEqual(answers.map(x=>x.body.elements[0].content),['完整正文']);
 assert.equal(answers[0].body.elements.length,1);
 const f=fixture(streaming),t=await f.create();
 try{
  await t.progress(origin,{status:'thinking',activity:{timeline:[{type:'draft',text:'草稿一'}],activeDraft:'草稿二'}});
  const result=await t.send({...origin,kind:'dm'},body);
  const changed=f.calls.filter(x=>x.type==='update'),sent=f.calls.filter(x=>x.type==='send');
  assert.equal(changed.length,1,'the progress card is edited in place into the collapsed draft');
  assert.equal(changed[0].payload.body.elements[0].tag,'collapsible_panel');
  assert.equal(sent.length,2,'one initial progress card and one independent answer card');
  assert.equal(sent[1].body.card.body.elements[0].content,'完整正文');
  assert.equal(result.messageId,'card-2');
 }finally{await t.close()}
});

test('two Feishu cards reuse the progress card and retain the complete long final answer',async()=>{
 const streaming=schema.validate({streaming:{mode:'progress',progress:{narration:true}}}).streaming;
 const f=fixture(streaming),t=await f.create();
 try{
  const dm={...origin,kind:'dm'};
  await t.progress(dm,{status:'thinking'});
  const original='长'.repeat(7600);
  const out=await t.send(dm,{status:'completed',final:true,drafts:['草稿一','草稿二'],text:original});
  const updates=f.calls.filter(x=>x.type==='update'),answers=f.calls.filter(x=>x.type==='send').slice(1);
  assert.equal(updates.length,1);
  assert.equal(updates[0].payload.body.elements[0].tag,'collapsible_panel');
  assert.equal(updates[0].payload.body.elements[0].expanded,false);
  assert(answers.length>1);
  assert(answers.every(x=>x.body.card.body.elements.every(elem=>elem.tag==='markdown')));
  assert.equal(answers.map(x=>x.body.card.body.elements[0].content).join(''),original);
  assert(answers.every(x=>Buffer.byteLength(JSON.stringify(x.body.card),'utf8')<=24000));
  assert.equal(out.messageId,answers[0].body.card?'card-2':null);
 }finally{await t.close()}
});

test('Feishu final text splits Unicode and escaped content by actual serialized byte budget',async()=>{
 const {finalCards,draftCard}=await import('../transport.js');
 const source=('😀中文\\\\\"quoted\"'+'句'.repeat(80)+'\n').repeat(130);
 const cards=finalCards({status:'completed',text:source,final:true},schema.defaults.streaming);
 assert(cards.length>2);
 assert(cards.every(x=>Buffer.byteLength(JSON.stringify(x),'utf8')<=24000));
 assert.equal(cards.map(x=>x.body.elements[0].content).join(''),source);
 const veryLongDraft=draftCard({status:'completed',final:true,drafts:['较早草稿'.repeat(3000),'最新草稿']});
 assert(Buffer.byteLength(JSON.stringify(veryLongDraft),'utf8')<=24000);
 assert(veryLongDraft.body.elements[0].elements[0].content.includes('较早思考已省略'));
 assert(veryLongDraft.body.elements[0].elements[0].content.includes('最新草稿'));
});

test('final reasoning card keeps chronological independent thoughts but omits repeated answer paragraphs',async()=>{
 const {distinctReasoning,draftCard}=await import('../transport.js');
 const repeated='命令运行正常，工具调用全部完成，可以继续处理。';
 const drafts=['第一段：先验证配置。\n\n'+repeated,'第二段：确认与任务有关的独立风险。\n\n'+repeated];
 const answer=repeated+'\n\n正文最终答复。';
 const clean=distinctReasoning(drafts,answer);
 assert.deepEqual(clean,['第一段：先验证配置。','第二段：确认与任务有关的独立风险。']);
 const folded=draftCard({status:'completed',text:answer,drafts});
 const content=folded.body.elements[0].elements[0].content;
 assert(content.indexOf('第一段：')<content.indexOf('第二段：'),'preserve original reasoning sequence');
 assert(!content.includes(repeated),'do not duplicate final answer');
 assert.equal(folded.body.elements[0].header.title.content,'💭 思考');
 assert.equal(distinctReasoning([repeated],answer).length,0);
});

test('when reasoning entirely repeats the answer, Feishu reuses progress card for final instead of sending duplicate card',async()=>{
 const repeating='执行结束，三个工具均已成功完成，当前工作区检查正常。';
 const streaming=schema.validate({streaming:{mode:'progress',progress:{narration:true}}}).streaming;
 const f=fixture(streaming),t=await f.create();
 try{
   await t.progress({...origin,kind:'dm'},{sessionId:'session',status:'thinking'});
   await t.send({...origin,kind:'dm'},{sessionId:'session',status:'completed',text:repeating,drafts:[repeating],final:true});
   const sent=f.calls.filter(x=>x.type==='send');
   const edited=f.calls.filter(x=>x.type==='update');
   assert.equal(sent.length,1,'no second standalone reply card');
   assert.equal(edited.length,1);
   assert.equal(edited[0].payload.body.elements[0].content,repeating);
   assert(!JSON.stringify(edited[0].payload).includes('collapsible_panel'));
 }finally{await t.close();}
});

test('Feishu title resolves real Agent name and footer only renders grounded session metrics',async()=>{
 const modelCalls=[];
 const f=fixture({mode:'progress'},{
   host:{defaultAgentName:()=> '小虎鲸',runtimeMetrics:async sessionId=>{
     modelCalls.push(sessionId);
     return {agentName:'小虎鲸',model:'opencode-go/deepseek-v4-flash',contextTokens:335700,contextLimitTokens:1000000};
   }}
 }),t=await f.create();
 try{
   await t.progress(origin,{sessionId:'s1',status:'thinking',activity:{timeline:[]}});
   const first=f.calls[0].body.card;
   assert.equal(first.header.title.content,'小虎鲸 · 正在思考');
   const footer=first.body.elements.at(-1);
   assert.equal(footer.text_size,'notation');
   assert(footer.content.includes('opencode-go/deepseek-v4-flash'));
   assert(footer.content.includes('335.7k/1M'));
   await t.send(origin,{sessionId:'s1',status:'completed',text:'任务完成',durationMs:2000});
   const final=f.calls.at(-1).payload;
   assert.equal(final.header.title.content,'小虎鲸 · 已完成');
   assert(final.body.elements.at(-1).content.includes('opencode-go/deepseek-v4-flash'));
   assert.deepEqual(modelCalls,['s1','s1']);
 }finally{await t.close();}
});

test('Feishu final multi-part answer puts a single footer only on last card and keeps original content',async()=>{
 const {finalCards}=await import('../transport.js');
 const original='中文'.repeat(5000);
 const body={status:'completed',final:true,agentName:'小虎鲸',text:original,footerText:'模型 · 上下文 20k/1M'};
 const cards=finalCards(body,schema.defaults.streaming);
 assert(cards.length>1);
 assert.equal(cards.map(x=>x.body.elements[0].content).join(''),original);
 for(const c of cards.slice(0,-1))assert.equal(c.body.elements.length,1);
 assert.equal(cards.at(-1).body.elements.at(-1).content,'模型 · 上下文 20k/1M');
 assert(cards.every(x=>Buffer.byteLength(JSON.stringify(x),'utf8')<=24000));
});

test('Feishu footer settings accept partial migration and reject unknown/incorrect values',()=>{
 const current=schema.defaults.streaming;
 assert.deepEqual(current.footer,{status:false,elapsed:false,model:true,context:true,tokens:false,cache:false});
 assert.equal(schema.validate({streaming:{mode:'progress',footer:{elapsed:true}}}).streaming.footer.elapsed,true);
 for(const footer of [{model:'yes'},{unknown:true},[],null])
   assert.throws(()=>schema.validate({streaming:{mode:'progress',footer}}));
});

test('Feishu sends the final answer before attempting to collapse the previous progress card',async()=>{
 const streaming=schema.validate({streaming:{progress:{narration:true}}}).streaming;
 const f=fixture(streaming),t=await f.create();
 try{
   const dm={...origin,kind:'dm'};
   await t.progress(dm,{status:'thinking'});
   await t.send(dm,{status:'completed',text:'完整答复',drafts:['独立推理过程：先检查工具调用和返回结果。']});
   assert.deepEqual(f.calls.map(x=>x.type),['send','send','update'],'final is confirmed before folding prior progress');
   assert.equal(f.calls[1].body.card.body.elements[0].content,'完整答复');
   assert.equal(f.calls[2].payload.body.elements[0].tag,'collapsible_panel');
 }finally{await t.close()}
});

test('Feishu final answer survives failure to update the retained reasoning card',async()=>{
 const streaming=schema.validate({streaming:{progress:{narration:true}}}).streaming;
 const f=fixture(streaming,{failUpdate:500}),t=await f.create();
 try{
   const dm={...origin,kind:'dm'};
   await t.progress(dm,{status:'thinking'});
   const result=await t.send(dm,{status:'completed',text:'重要的最终答复',drafts:['与正文不同的内部验证记录，请保留以便查阅。']});
   assert.equal(result.messageId,'card-2');
   assert.equal(f.calls.filter(x=>x.type==='send').length,2,'answer already delivered');
   assert.equal(f.calls.filter(x=>x.type==='update').length,1,'failed thought patch does not trigger duplicate delivery');
 }finally{await t.close()}
});

test('Feishu without a preceding progress message never adds a trailing thinking card after the answer',async()=>{
 const streaming=schema.validate({streaming:{progress:{narration:true}}}).streaming;
 const f=fixture(streaming),t=await f.create();
 try{
   await t.send({...origin,kind:'dm'},{status:'completed',text:'快速答复',drafts:['独立的思考片段：提前完成快速检查。']});
   assert.equal(f.calls.length,1);
   assert.equal(f.calls[0].body.card.body.elements[0].content,'快速答复');
 }finally{await t.close()}
});

test('deleted old progress is not recreated as a trailing thought card after the final answer',async()=>{
 const streaming=schema.validate({streaming:{progress:{narration:true}}}).streaming;
 const f=fixture(streaming,{failUpdate:404}),t=await f.create();
 try{
   const dm={...origin,kind:'dm'};
   await t.progress(dm,{status:'thinking'});
   const result=await t.send(dm,{status:'completed',text:'先送达最终答复',drafts:['独立记录：先检查脚本执行是否成功。']});
   assert.equal(result.messageId,'card-2');
   assert.equal(f.calls.filter(x=>x.type==='send').length,2,'only initial progress and final response were sent');
   assert.equal(f.calls.filter(x=>x.type==='update').length,1,'missing old progress is not recreated');
 }finally{await t.close();}
});

function fakeCardKit(overrides={}){
 const calls=[];
 const ok=()=>({code:0});
 const rawClient={
  cardkit:{v1:{
   card:{
    create:async request=>{calls.push({type:'kit-create',request});if(overrides.create)throw overrides.create;return {code:0,data:{card_id:'kit-1'}};},
    update:async request=>{calls.push({type:'kit-update',request});return ok();},
    settings:async request=>{calls.push({type:'kit-settings',request});return ok();},
   },
   cardElement:{content:async request=>{calls.push({type:'kit-content',request});if(overrides.content)throw overrides.content;return ok();}},
  }},
  im:{v1:{message:{
   reply:async request=>{calls.push({type:'kit-reply',request});if(overrides.reply)throw overrides.reply;return {code:0,data:{message_id:'om-kit'}};},
   create:async request=>{calls.push({type:'kit-send',request});return {code:0,data:{message_id:'om-kit'}};},
  }}},
 };
 return {calls,rawClient};
}

test('CardKit is the default Feishu engine, with an explicit IM Patch compatibility mode',()=>{
 assert.equal(schema.defaults.streaming.cardEngine,'cardkit');
 assert.equal(schema.validate({streaming:{cardEngine:'patch'}}).streaming.cardEngine,'patch');
 assert.throws(()=>schema.validate({streaming:{cardEngine:'invalid'}}));
});

test('CardKit uses streaming element updates, monotonic sequences and finalizes the original IM card',async()=>{
 const kit=fakeCardKit(),f=fixture({mode:'progress',progress:{narration:true}},{rawClient:kit.rawClient}),t=await f.create();
 try{
  const base={sessionId:'session',status:'thinking',activity:{timeline:[{type:'draft',text:'先检查模型'}]}};
  await t.progress(origin,base);
  await t.progress(origin,{...base,activity:{timeline:[{type:'draft',text:'先检查模型，再看输出'}]}});
  await t.progress(origin,{...base,status:'tool-running',activity:{timeline:[{type:'tool',activity:{name:'read_file',status:'completed',detail:'README.md'}}]}});
  const final=await t.send(origin,{sessionId:'session',status:'completed',text:'最后答复',final:true});
  assert.equal(final.messageId,'om-kit');
  assert.deepEqual(kit.calls.map(c=>c.type),['kit-create','kit-reply','kit-content','kit-update','kit-settings','kit-update']);
  const initial=JSON.parse(kit.calls[0].request.data.data);
  assert.equal(initial.config.streaming_mode,true);
  assert.equal(initial.body.elements[0].element_id,'dsh_progress_text');
  const replied=JSON.parse(kit.calls[1].request.data.content);
  assert.deepEqual(replied,{type:'card',data:{card_id:'kit-1'}});
  assert.equal(kit.calls[2].request.data.sequence,2);
  assert.equal(kit.calls[2].request.path.element_id,'dsh_progress_text');
  assert.equal(kit.calls[3].request.data.sequence,3);
  assert.equal(kit.calls[4].request.data.sequence,4);
  assert.equal(kit.calls[5].request.data.sequence,5);
  assert.equal(kit.calls[4].request.data.settings,'{"streaming_mode":false}');
  assert.equal(JSON.parse(kit.calls[5].request.data.card.data).body.elements[0].content,'最后答复');
  assert.equal(f.calls.length,0,'no legacy IM send or patch in healthy CardKit path');
 }finally{await t.close()}
});

test('CardKit sends the final answer before replacing the progress card with filtered reasoning',async()=>{
 const kit=fakeCardKit(),f=fixture({mode:'progress',progress:{narration:true}},{rawClient:kit.rawClient}),t=await f.create();
 try{
  const dm={...origin,kind:'dm'};
  await t.progress(dm,{status:'thinking',activity:{timeline:[{type:'draft',text:'独立的调查思路'}]}});
  const ret=await t.send(dm,{status:'completed',text:'实际结论',drafts:['独立的调查思路及验证过程']});
  assert.equal(ret.messageId,'card-1');
  assert.equal(f.calls.length,1);
  const events=[...kit.calls.map(c=>c.type)];
  assert.deepEqual(events,['kit-create','kit-reply','kit-settings','kit-update']);
  assert.equal(JSON.parse(kit.calls.at(-1).request.data.card.data).body.elements[0].tag,'collapsible_panel');
  assert.equal(f.calls[0].body.card.body.elements[0].content,'实际结论');
 }finally{await t.close()}
});

test('CardKit question closes streaming mode, keeps buttons and can start a new progress card',async()=>{
 const kit=fakeCardKit(),f=fixture({mode:'progress'},{rawClient:kit.rawClient}),t=await f.create();
 try{
  await t.progress(origin,{status:'thinking',activity:{timeline:[]}});
  await t.question(origin,{status:'waiting-user',text:'继续？'},[{label:'允许',token:'test-button'}]);
  const payload=JSON.parse(kit.calls.at(-1).request.data.card.data);
  assert.equal(payload.body.elements[1].value.dsh,'test-button');
  assert.equal(kit.calls.filter(c=>c.type==='kit-settings').length,1);
  // A new stream uses a fresh CardKit card; the button card remains interactive.
  await t.progress(origin,{status:'thinking',activity:{timeline:[]}});
  assert.equal(kit.calls.filter(c=>c.type==='kit-create').length,2);
 }finally{await t.close()}
});

test('CardKit failure before IM send safely falls back; ambiguous IM send failure never duplicates',async()=>{
 const denied=fakeCardKit({create:Object.assign(new Error('missing cardkit permission'),{code:403})});
 const f=fixture({mode:'progress'},{rawClient:denied.rawClient}),t=await f.create();
 try{
  await t.progress(origin,{status:'thinking',activity:{timeline:[]}});
  assert.deepEqual(denied.calls.map(x=>x.type),['kit-create']);
  assert.equal(f.calls.filter(x=>x.type==='send').length,1,'safe fallback to IM card');
 }finally{await t.close()}
 const uncertain=fakeCardKit({reply:new Error('socket closed after send')});
 const ff=fixture({mode:'progress'},{rawClient:uncertain.rawClient}),q=await ff.create();
 try{
  await assert.rejects(q.progress(origin,{status:'thinking',activity:{timeline:[]}}),/socket closed/);
  assert.equal(ff.calls.length,0,'do not retry a potentially delivered IM message');
 }finally{await q.close()}
});

test('CardKit streaming text error never blindly resends a duplicate IM card',async()=>{
 const kit=fakeCardKit({content:new Error('transient network error')});
 const f=fixture({mode:'progress'},{rawClient:kit.rawClient}),t=await f.create();
 try{
  await t.progress(origin,{status:'thinking',activity:{timeline:[]}});
  await assert.rejects(t.progress(origin,{status:'thinking',activity:{timeline:[{type:'tool',activity:{name:'read_file',status:'completed',detail:'README.md'}}]}}),/transient network/);
  assert.equal(f.calls.length,0);
  assert.equal(kit.calls.filter(x=>x.type==='kit-reply').length,1);
 }finally{await t.close()}
});

test('manual Feishu compatibility mode bypasses CardKit even with SDK support',async()=>{
 const kit=fakeCardKit(),f=fixture({mode:'progress',cardEngine:'patch'},{rawClient:kit.rawClient}),t=await f.create();
 try{
  await t.progress(origin,{status:'thinking'});
  await t.progress(origin,{status:'tool-running'});
  assert.equal(kit.calls.length,0);
  assert.equal(f.calls.filter(x=>x.type==='send').length,1);
  assert.equal(f.calls.filter(x=>x.type==='update').length,1);
  assert.equal(t.details().feishuCardEngine,'兼容模式');
 }finally{await t.close()}
});

test('CardKit absence auto-degrades without breaking final reply or Ask User',async()=>{
 const f=fixture({mode:'progress'}),t=await f.create();
 try{
  await t.progress(origin,{status:'thinking'});
  assert.match(t.details().feishuCardEngine,/兼容模式/);
  await t.question(origin,{status:'waiting-user',text:'继续吗？'},[{label:'继续',token:'yes'}]);
  await t.send(origin,{status:'completed',text:'安全送达'});
  assert.equal(f.calls.filter(c=>c.type==='send').length,1);
  assert.equal(f.calls.at(-1).payload.body.elements[0].content,'安全送达');
 }finally{await t.close()}
});

test('CardKit supports partial-mode cumulative body updates and preserves original long final output',async()=>{
 const kit=fakeCardKit(),f=fixture({mode:'partial'},{rawClient:kit.rawClient}),t=await f.create();
 try{
  await t.progress(origin,{status:'generating',text:'第一个片段'});
  await t.progress(origin,{status:'generating',text:'第一个片段，再加下一段'});
  const answer='正文'.repeat(4100);
  await t.send(origin,{status:'completed',text:answer});
  assert(kit.calls.some(c=>c.type==='kit-content'));
  assert.equal(kit.calls.filter(c=>c.type==='kit-reply').length,1);
  const last=kit.calls.filter(c=>c.type==='kit-update').at(-1);
  const first=JSON.parse(last.request.data.card.data).body.elements[0].content;
  const rest=f.calls.filter(c=>c.type==='send').map(c=>c.body.card.body.elements[0].content).join('');
  assert.equal(first+rest,answer);
 }finally{await t.close()}
});

test('Feishu progress shows emoji-only drafts, original paragraphs, thinking above draft and compact tool group',()=>{
 const streaming=schema.validate({streaming:{mode:'progress',progress:{narration:true,maxLines:5,draftMaxChars:600,maxLineChars:90}}}).streaming;
 const display=card({status:'tool-running',activity:{timeline:[
  {type:'public-draft',text:'阶段性说明的第一段。\n\n阶段性说明的第二段。'},
  {type:'tool',activity:{name:'read_file',status:'completed',detail:'note.md'}},
  {type:'draft',text:'推理的第一段。\n\n推理的第二段。'},
  {type:'tool',activity:{name:'pwsh',status:'running',detail:'npm test'}},
  {type:'tool',activity:{name:'grep',status:'completed',detail:'regex'}}
 ]}},[],streaming).body.elements[0].content;
 assert(display.startsWith('💭 推理的第一段。\n\n推理的第二段。\n\n📝 阶段性说明的第一段。\n\n阶段性说明的第二段。'));
 assert(!display.includes('📝 草稿'),'do not repeat label after emoji');
 assert(display.includes('✅ 读取文件 · note.md\n⏳ 执行命令 · npm test\n✅ 搜索内容 · regex'));
 assert(!display.includes('思考 1'));
});

test('Feishu preserves recent long drafts, constrains tools independently and removes numbered reasoning headers',async()=>{
 const streaming=schema.validate({streaming:{mode:'progress',progress:{narration:true,maxLines:5,draftMaxChars:600,maxLineChars:75}}}).streaming;
 const long='开头'.repeat(400)+'\n\n这里是最新自然段 🐋';
 const rendered=card({status:'thinking',activity:{timeline:[
  {type:'draft',text:long},
  {type:'public-draft',text:'准备开始第一步。\n\n接下来核对。'},
  {type:'tool',activity:{name:'read_file',status:'completed',detail:'x'.repeat(300)}}
 ]}},[],streaming).body.elements[0].content;
 assert(rendered.includes('💭 …'),'show retained latest thought tail');
 assert(rendered.includes('这里是最新自然段 🐋'));
 assert(rendered.includes('📝 准备开始第一步。\n\n接下来核对。'));
 const lastTool=rendered.split('\n').find(x=>x.startsWith('✅ '));
 assert(lastTool.length<=75);
 const {draftCard}=await import('../transport.js');
 const thoughts=draftCard({status:'completed',drafts:['第一段\n\n第二段','接着第三段'],text:'最终正文'});
 const thoughtContent=thoughts.body.elements[0].elements[0].content;
 assert.equal(thoughtContent,'第一段\n\n第二段\n\n接着第三段');
 assert(!thoughtContent.includes('**思考 1**'));
 assert(!thoughtContent.includes('思考 2'));
 assert.equal(thoughts.body.elements[0].header.title.content,'💭 思考');
});

test('Feishu progress config isolates draft length from tool limits',()=>{
 const value=schema.validate({streaming:{progress:{draftMaxChars:850,maxLineChars:90}}}).streaming;
 assert.equal(value.progress.draftMaxChars,850);
 assert.equal(value.progress.maxLineChars,90);
 assert.equal(schema.defaults.streaming.progress.draftMaxChars,600);
 for(const bad of [119,1001,500.2,'600',null])
   assert.throws(()=>schema.validate({streaming:{progress:{draftMaxChars:bad}}}));
});
