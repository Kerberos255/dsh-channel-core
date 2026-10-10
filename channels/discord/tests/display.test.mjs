import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { schema } from '../config.js';
import { renderFooter } from '../footer.js';
import { createTransport } from '../transport.js';
import { renderHeading,footerSuffix,renderProgress } from '../progress.js';

const origin={provider:'discord',accountId:'default',conversationId:'private',messageId:'input',userId:'u',kind:'dm'};
function fixture(streaming,stats={model:'deepseek/deepseek-v4',contextTokens:12000},configOverride={}){
 const events=new EventEmitter(),calls=[];
 const channel={isTextBased:()=>true,messages:{
   edit:async(id,body)=>{calls.push({kind:'edit',id,body});return {id};},
   delete:async id=>{calls.push({kind:'delete',id})}
 },send:async body=>{const id='bot-'+calls.length;calls.push({kind:'send',id,body});return {id};},sendTyping:async()=>{}};
 class Client{
   constructor(){this.user={id:'bot'};this.application={commands:{create:async()=>{}}};this.channels={fetch:async()=>channel};}
   on(...args){events.on(...args)}
   off(...args){events.off(...args)}
   async login(){}
   async destroy(){}
 }
 const sdk={Client,Options:{cacheWithLimits:()=>()=>{}},GatewayIntentBits:{Guilds:1,GuildMessages:2,DirectMessages:3,MessageContent:4},Partials:{Channel:1}};
 return {calls,create:()=>createTransport({config:schema.validate({streaming,...configOverride}),credentials:['mock'],signal:new AbortController().signal,
   receive:async()=>{},state:()=>{},action:async()=>{},sessions:async()=>[],host:{runtimeMetrics:async()=>stats,defaultAgentName:()=> '小虎鲸'}},sdk)};
}
const setup=()=>({mode:'progress',progress:{narration:true}});

test('Discord removed all alternate message styles and keeps runtime footer settings',()=>{
 const base=schema.defaults.streaming;
 assert(!Object.hasOwn(base,'style'));
 assert.deepEqual(base.footer,{status:false,elapsed:false,model:true,context:true,tokens:false,cache:false});
 for(const style of ['plain','embed','components-v2'])
   assert(!Object.hasOwn(schema.validate({streaming:{mode:'progress',style}}).streaming,'style'),'old settings are accepted but discarded');
 assert.equal(schema.validate({streaming:{footer:{elapsed:true}}}).streaming.footer.context,true);
 for(const value of [{style:'markdown'},{footer:{model:'yes'}},{footer:{unknown:true}},{style:0}])
   assert.throws(()=>schema.validate({streaming:value}),error=>error.code==='invalid-config');
});

test('footer renders only measured metrics and independently selected fields',()=>{
 const footer=schema.defaults.streaming.footer;
 assert.equal(renderFooter(footer,{status:'completed',durationMs:12900},{model:'deepseek/v4',contextTokens:12345}),'deepseek/v4 · 上下文 12.3k tokens');
 assert.equal(renderFooter(footer,{status:'completed',durationMs:10000},{}),'');
 assert.equal(renderFooter({...footer,status:true,elapsed:true,tokens:true,cache:true},{status:'completed',durationMs:12120},{model:'deepseek/v4',contextTokens:32000,inputTokens:123,outputTokens:77,cacheRead:0,cacheWrite:20}),
 '已完成 · 耗时 12.1s · deepseek/v4 · 上下文 32k tokens · Tokens 123 / 77 · 缓存 0 / 20');
 assert(renderFooter({model:true},{}, {model:'@everyone\nsecret'}).startsWith('\\@'));
});

test('plain progress shows model, context, drafts and tools; final becomes only answer and footer',async()=>{
 const f=fixture(setup()),t=await f.create();
 try{
   await t.progress(origin,{sessionId:'s1',status:'tool-running',durationMs:5000,activity:{timeline:[
     {type:'public-draft',text:'我先看项目'},
     {type:'tool',activity:{name:'pwsh',status:'running',detail:'npm test'}}
   ],activeTextDraft:'根据测试调整逻辑'}});
   const first=f.calls.find(x=>x.kind==='send').body;
   assert.equal(first.embeds,undefined);
   assert(first.content.includes('草稿 · 我先看项目'));
   assert(first.content.includes('草稿 · 根据测试调整逻辑'));
   assert(first.content.includes('npm test'));
   assert(first.content.includes('上下文 12k tokens'));
   assert(first.content.includes('deepseek/deepseek-v4'));
   assert.equal(t.showNarration,false,'no draft history in final replies');
   await t.send(origin,{sessionId:'s1',status:'completed',durationMs:12000,final:true,text:'最终正文'});
   const final=f.calls.find(x=>x.kind==='edit').body;
   assert(final.content.startsWith('最终正文'));
   assert(final.content.includes('上下文 12k tokens'));
   assert(!final.content.includes('npm test'));
   assert(!final.content.includes('草稿'));
   assert.deepEqual(final.components,[]);
 }finally{await t.close()}
});

test('plain Ask User buttons and long output remain supported without other card formats',async()=>{
 const f=fixture(setup()),t=await f.create();
 try{
   await t.progress(origin,{sessionId:'s',status:'thinking',activity:{}});
   await t.question(origin,{status:'waiting-user',text:'请批准'},[{label:'允许',token:'protected'}]);
   const question=f.calls.filter(x=>x.kind==='edit').at(-1).body;
   assert.equal(question.components[0].components[0].custom_id,'dsh:protected');
   assert(question.content.includes('请批准'));
   await t.send(origin,{sessionId:'s',status:'completed',text:'长句'.repeat(2300),final:true});
   const changes=f.calls.filter(x=>x.kind==='edit'),extra=f.calls.filter(x=>x.kind==='send').slice(1);
   assert(changes.every(x=>x.body.flags===undefined&&x.body.embeds===undefined));
   assert(extra.every(x=>x.body.flags===undefined&&x.body.embeds===undefined));
   assert(changes.at(-1).body.content.length<=1900);
   assert(extra.at(-1).body.content.includes('deepseek/deepseek-v4'));
 }finally{await t.close()}
});

test('no measurable metrics means no fabricated footer',async()=>{
 const f=fixture(setup(),{}),t=await f.create();
 try{
   await t.progress(origin,{sessionId:'s1',status:'thinking',activity:{}});
   assert(!f.calls.find(x=>x.kind==='send').body.content.includes('上下文'));
   await t.send(origin,{sessionId:'s1',status:'completed',text:'答复'});
   assert.equal(f.calls.find(x=>x.kind==='edit').body.content,'答复');
 }finally{await t.close()}
});

test('native usage projections provide real model, context window, token and cache metrics',async()=>{
 const {readSessionMetrics}=await import('../../../lib/channel-components.js');
 const ctx={
   sessionController:{
     projections:async()=>({values:{
       modelSelection:{lastUsed:{provider:'deepseek',model:'flash'}},
       contextPressure:{pressureTokens:32000,projectedTokens:34000,contextWindow:1000000},
       tokenUsage:{uncachedInputTokens:1000,outputTokens:240,cacheReadTokens:6500,cacheWriteTokens:300}
     }}),
     modelCatalog:async()=>({default:{provider:'fallback',model:'fallback'}})
   },
   get:name=>name==='sessions'?{get:()=>({id:'s'})}:name==='tokenMeter'?{measure:()=>({totalTokens:36200})}:undefined
 };
 const stats=await readSessionMetrics(ctx,'s');
 assert.deepEqual(stats,{model:'deepseek/flash',contextTokens:36200,contextLimitTokens:1000000,inputTokens:1000,outputTokens:240,cacheRead:6500,cacheWrite:300});
 const footer=renderFooter({model:true,context:true,tokens:true,cache:true}, {},stats);
 assert(footer.includes('上下文 36.2k/1M tokens'));
 assert(footer.includes('Tokens 1,000 / 240')===false);
 assert(footer.includes('缓存 6.5k / 300'));
});

test('missing provider usage never shows fabricated tokens or cache values',async()=>{
 const {readSessionMetrics}=await import('../../../lib/channel-components.js');
 const ctx={sessionController:{projections:async()=>({values:{tokenUsage:{uncachedInputTokens:0,outputTokens:0,cacheReadTokens:0,cacheWriteTokens:0}}}),modelCatalog:async()=>({default:{provider:'deepseek',model:'flash'}})},get:()=>undefined};
 const stats=await readSessionMetrics(ctx,'session');
 assert.equal(stats.model,'deepseek/flash');
 assert(!Object.hasOwn(stats,'inputTokens'));
 assert(!Object.hasOwn(stats,'cacheRead'));
 assert.equal(renderFooter({tokens:true,cache:true}, {},stats),'');
});

test('custom Discord icon is validated; role heading uses role name rather than model or preset ID',()=>{
 assert.equal(schema.defaults.displayIcon,'🐋');
 assert.equal(schema.validate({displayIcon:'🐈‍⬛'}).displayIcon,'🐈‍⬛');
 for(const icon of ['', '@everyone','foo\nbar','<'+'mention'+'>','🚀'.repeat(35)])
   assert.throws(()=>schema.validate({displayIcon:icon}));
 assert(renderHeading('tool-running',{icon:'🐱',name:'小虎鲸'}).startsWith('**🐱 小虎鲸 · '));
 assert(!renderHeading('thinking',{name:'@everyone\n*bad*'}).includes('@everyone'));
 assert(renderHeading('thinking').includes('Agent'));
});

test('Discord footer uses whitespace and native small text, without a decorative divider',()=>{
 assert.equal(footerSuffix(''),'');
 assert.equal(footerSuffix('deepseek/v4 · 上下文 32k/1M tokens'),'\n\n-# deepseek/v4 · 上下文 32k/1M tokens');
 const settings=schema.defaults.streaming;
 const content=renderProgress({status:'thinking',activity:{timeline:[]}},settings,'模型名称 · 上下文 8k',{icon:'🌱',name:'小虎鲸'});
 assert(content.startsWith('**🌱 小虎鲸 · '));
 assert(content.endsWith('-# 模型名称 · 上下文 8k'));
 assert(!renderProgress({status:'thinking',activity:{timeline:[]}},settings).includes('────────'));
});

test('custom icon and resolved role name appear in Discord progress and questions; completed reply stays plain',async()=>{
 const f=fixture(setup(),{model:'deepseek/v4',agentName:'小虎鲸',contextTokens:32500,contextLimitTokens:1000000},{displayIcon:'🪼'}),t=await f.create();
 try{
   await t.progress(origin,{sessionId:'role-session',status:'tool-running',activity:{timeline:[{type:'tool',activity:{name:'read_file',status:'running'}}]}});
   const progress=f.calls.find(x=>x.kind==='send').body.content;
   assert(progress.startsWith('**🪼 小虎鲸 · '));
   assert(!progress.includes('DeepSeek ·'));
   assert(progress.includes('\n\n-# deepseek/v4 · 上下文 32.5k/1M tokens'));
   await t.question(origin,{status:'waiting-user',text:'继续？'},[{label:'继续',token:'safe'}]);
   const question=f.calls.filter(x=>x.kind==='edit').at(-1).body.content;
   assert(question.startsWith('**🪼 小虎鲸 · '));
   await t.send(origin,{sessionId:'role-session',status:'completed',text:'已经完成',final:true});
   const final=f.calls.filter(x=>x.kind==='edit').at(-1).body.content;
   assert(final.startsWith('已经完成'));
   assert(final.endsWith('-# deepseek/v4 · 上下文 32.5k/1M tokens'));
   assert(!final.includes('🪼 小虎鲸'));
 }finally{await t.close()}
});

test('session role name resolves from instruction-files profile and tracks chosen preset',async()=>{
 const {readSessionMetrics}=await import('../../../lib/channel-components.js');
 let selected='agent';
 const ctx={
   sessionController:{projections:async()=>({values:{agentPreset:selected}}),modelCatalog:async()=>({default:{provider:'deepseek',model:'flash'}})},
   get:name=>name==='instructionFilesSettings'?{configFile:{value:{profiles:[{preset:'agent',name:'小虎鲸'},{preset:'worker',name:'矿山助手'}]}}}:undefined,
 };
 const a=await readSessionMetrics(ctx,'session',{agentPreset:'worker'});
 assert.equal(a.agentName,'小虎鲸','native active session preset takes priority over channel default');
 selected='worker';
 assert.equal((await readSessionMetrics(ctx,'session',{agentPreset:'agent'})).agentName,'矿山助手');
 selected='missing';
 assert(!Object.hasOwn(await readSessionMetrics(ctx,'session',{agentPreset:'agent'}),'agentName'));
});

test('Ask User keeps the active session role rather than falling back to the configured default',async()=>{
 const f=fixture(setup(),{model:'deepseek/flash',agentName:'矿山助手'}, {displayIcon:'🍄'}),transport=await f.create();
 try{
   await transport.progress(origin,{sessionId:'worker-session',status:'thinking',activity:{timeline:[]}});
   await transport.question(origin,{status:'waiting-user',text:'现在继续吗？'},[{label:'继续',token:'yes'}]);
   const question=f.calls.filter(call=>call.kind==='edit').at(-1).body.content;
   assert(question.startsWith('**🍄 矿山助手 · '));
   assert(!question.includes('小虎鲸'));
 }finally{await transport.close()}
});

test('Discord transport opts into bridge-side latest-only progress coalescing',async()=>{
 const f=fixture(setup()),transport=await f.create();
 try{assert.equal(transport.coalesceProgress,true);}finally{await transport.close();}
});


test('actual Discord completed delivery wraps committed public prelude in quote, leaving final Markdown normal',async()=>{
 const f=fixture(setup(),{model:'deepseek/v4',contextTokens:36000}),t=await f.create();
 try{
  const draft='先看配置。\n\n再执行测试。';
  const formal='**检查结果**\n\n- 测试通过\n- 代码已更新';
  await t.progress(origin,{status:'tool-running',activity:{timeline:[]}});
  await t.send(origin,{sessionId:'session',status:'completed',text:draft+'\n\n'+formal,draftPrelude:draft,finalReplyText:formal});
  const message=f.calls.filter(call=>call.kind==='edit').at(-1).body.content;
  assert(message.includes('**📝 过程草稿**\n\n> 先看配置。\n> \n> 再执行测试。'));
  assert(message.includes('**✅ 正式回复**\n\n**检查结果**\n\n- 测试通过'));
  assert(message.endsWith('-# deepseek/v4 · 上下文 36k tokens'));
  assert.equal(f.calls.filter(call=>call.kind==='send').length,1);
 }finally{await t.close();}
});


test('Ask User already published context is not re-quoted or repeated in Discord completed answer',async()=>{
 const f=fixture(setup()),t=await f.create();
 try{
  await t.progress(origin,{status:'thinking',activity:{timeline:[]}});
  await t.question(origin,{status:'waiting-user',text:'请确认',context:'已发布的阶段内容'},[{label:'确认',token:'test-option'}]);
  await t.send(origin,{status:'completed',text:'已发布的阶段内容\n\n最终答案',
    draftPrelude:'已发布的阶段内容',finalReplyText:'最终答案'});
  const final=f.calls.filter(call=>call.kind==='edit').at(-1).body.content;
  assert(final.startsWith('最终答案'));
  assert(!final.includes('过程草稿'));
 }finally{await t.close();}
});
