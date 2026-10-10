import test from 'node:test';
import assert from 'node:assert/strict';
import { renderProgressLines } from '../lib/progress-lines.js';

const options={toolProgress:true,commentary:true,narration:false,toolDetail:true,maxLines:6,maxLineChars:80};

test('shared progress preserves tool order, icons, details and latest entries',()=>{
 const tools=Array.from({length:9},(_,i)=>({name:i%2?'pwsh':'read',status:i===8?'failed':i===7?'running':'completed',detail:'file-'+i}));
 const rows=renderProgressLines({activity:{commentary:'公开说明',tools}}, {...options,maxLines:3});
 assert.equal(rows.length,3);
 assert.equal(rows[0],'💬 公开说明');
 assert.equal(rows[1],'⏳ 执行命令 · file-7');
 assert.equal(rows[2],'❌ 读取文件 · file-8');
 assert(!rows.join('').includes('file-6'));
});

test('reasoning is opt-in, multiline, and distinct from public commentary',()=>{
 const body={activity:{narration:'先思考\n最后一行',commentary:'安全的公开说明',tools:[]}};
 assert.deepEqual(renderProgressLines(body,options),['💬 安全的公开说明']);
 assert.deepEqual(renderProgressLines(body,{...options,narration:true}),['💭 思考\n先思考\n最后一行','💬 安全的公开说明']);
});

test('long reasoning is bounded with visible truncation and intact UTF-16',()=>{
 const body={activity:{narration:'开头\n'+'🐋'.repeat(10000)+'\n收尾'}};
 const rendered=renderProgressLines(body,{...options,narration:true,reasoningMaxChars:1400})[0];
 assert(rendered.includes('前文已截断'));
 assert(rendered.includes('收尾'));
 assert(!rendered.includes('开头'));
 assert(rendered.length<1450);
 assert(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(rendered));
 const cached=renderProgressLines({activity:{narration:'后一段',narrationTruncated:true}},{...options,narration:true})[0];
 assert(cached.includes('前文已截断'));
});

test('disabled detail, bounded lines, and surrogate pairs',()=>{
 const rows=renderProgressLines({activity:{tools:[{name:'🐋'.repeat(100),status:'running',detail:'secret'}]}},{...options,toolDetail:false,maxLineChars:40});
 assert.equal(rows.length,1);assert(!rows[0].includes('secret'));
 assert(rows[0].length<=40);
 assert(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(rows[0]));
});

test('no available rows remains empty (transport must not display draft)',()=>{
 assert.deepEqual(renderProgressLines({status:'generating',text:'PRIVATE-DRAFT'},options),[]);
 assert.deepEqual(renderProgressLines({}, {...options,commentary:false,toolProgress:false}),[]);
});

test('rendering does not mutate bridge activity objects',()=>{
 const b={activity:{tools:[{name:'web_search',status:'running',detail:'search'}],commentary:'A'}};
 const before=JSON.stringify(b);assert.deepEqual(renderProgressLines(b,options),['💬 A','⏳ 网页搜索 · search']);assert.equal(JSON.stringify(b),before);
});

test('chronological draft/tool activity scrolls together with platform row limits',()=>{
 const timeline=[
  {type:'draft',text:'草稿一：先检查目录'},
  {type:'tool',activity:{name:'read_file',status:'completed',detail:'README.md'}},
  {type:'draft',text:'草稿二：继续执行命令'},
  {type:'tool',activity:{name:'pwsh',status:'running',detail:'npm test'}},
  {type:'draft',text:'草稿三：测试准备完毕'},
 ];
 const opts={...options,narration:true,maxLines:4,maxLineChars:60};
 const rows=renderProgressLines({activity:{timeline,activeDraft:'草稿四：最后检查'}},opts);
 assert.deepEqual(rows,['💭 草稿二：继续执行命令','⏳ 执行命令 · npm test','💭 草稿三：测试准备完毕','💭 草稿四：最后检查']);
 assert.deepEqual(renderProgressLines({activity:{timeline}}, {...opts,narration:false,maxLines:2}),['✅ 读取文件 · README.md','⏳ 执行命令 · npm test']);
 const narrow=renderProgressLines({activity:{timeline}}, {...opts,maxLineChars:12});
 assert(narrow.every(row=>row.length<=12));
});

test('live drafts, interim public messages and tools share one chronological rolling window',()=>{
 const body={status:'tool-running',activity:{timeline:[
   {type:'public-draft',text:'先看文档'},
   {type:'tool',activity:{name:'read_file',status:'completed',detail:'README.md'}},
   {type:'draft',text:'分析依赖'},
   {type:'tool',activity:{name:'pwsh',status:'running',detail:'npm test'}},
 ],activeTextDraft:'再检查测试反馈'}};
 const opt={toolProgress:true,commentary:true,narration:true,toolDetail:true,maxLines:5,maxLineChars:120};
 const rows=renderProgressLines(body,opt);
 assert.equal(rows.length,5);
 assert(rows[0].includes('草稿 · 先看文档'));
 assert(rows[1].includes('README.md'));
 assert(rows[2].includes('分析依赖'));
 assert(rows[3].includes('npm test'));
 assert(rows[4].includes('草稿 · 再检查测试反馈'));
 assert(!renderProgressLines(body,{...opt,narration:false}).some(x=>x.includes('再检查测试反馈')));
});

test('Discord draft retention: rapid tools do not push the most recent public draft off a five-line display',()=>{
 const activity={timeline:[
   {type:'public-draft',text:'先检查依赖并验证配置'},
   ...Array.from({length:9},(_,i)=>({type:'tool',activity:{name:'pwsh',status:'completed',detail:'run-'+i}})),
 ]};
 const opt={...options,maxLines:5,narration:true,pinDrafts:true};
 const actual=renderProgressLines({activity},opt);
 assert.equal(actual.length,5);
 assert(actual[0].includes('📝 草稿 · 先检查依赖'),actual.join('\n'));
 assert(actual.slice(1).every(row=>row.startsWith('✅')),actual.join('\n'));
 assert(actual.at(-1).includes('run-8'),actual.join('\n'));
 assert(!renderProgressLines({activity},{...opt,pinDrafts:false}).some(row=>row.includes('📝 草稿')));
});

test('Discord draft retention reserves lines for the latest real text draft and thinking, not fabricated content',()=>{
 const timeline=[
   {type:'draft',text:'推理片段一'},
   {type:'public-draft',text:'先把计划写出来'},
   ...Array.from({length:10},(_,i)=>({type:'tool',activity:{name:'pwsh',status:'completed',detail:'step-'+i}})),
 ];
 const opt={...options,maxLines:5,narration:true,pinDrafts:true};
 const actual=renderProgressLines({activity:{timeline}},opt);
 assert.equal(actual.length,5);
 assert(actual[0].includes('推理片段一'));
 assert(actual[1].includes('📝 草稿 · 先把计划'));
 assert(actual.slice(2).every(row=>row.startsWith('✅')));
 assert(actual.at(-1).includes('step-9'));
 const onlyTools=renderProgressLines({activity:{timeline:timeline.slice(2)}},opt);
 assert.equal(onlyTools.length,5);
 assert(onlyTools.every(row=>row.startsWith('✅')));
 const nonPrivate=renderProgressLines({activity:{timeline:timeline.filter(row=>row.type==='tool')}},opt);
 assert(nonPrivate.every(row=>!row.includes('草稿')));
});

test('Discord places the newest ongoing draft before tool rows',()=>{
 const activity={timeline:[
   ...Array.from({length:8},(_,i)=>({type:'tool',activity:{name:'read',status:'completed',detail:'file-'+i}})),
 ],activeTextDraft:'临时新段落'};
 const rows=renderProgressLines({activity},{...options,maxLines:5,narration:true,pinDrafts:true});
 assert.equal(rows.length,5);
 assert(rows[0].includes('📝 草稿 · 临时新段落'));
 assert(rows[1].includes('file-4'));
 assert(rows.at(-1).includes('file-7'));
});

test('Discord narrative text has its own 600-character budget and uses the latest text, while tool lines remain short',()=>{
 const long='旧'.repeat(780)+'此处是新的草稿末尾';
 const thinking='分析'.repeat(480)+'新的思考末尾';
 const body={activity:{timeline:[
   {type:'draft',text:thinking},
   {type:'public-draft',text:long},
   {type:'tool',activity:{name:'pwsh',detail:'command-'+('x'.repeat(200)),status:'running'}}
 ],activeTextDraft:'进一步分析'.repeat(140)+'现在正在输出'}};
 const opts={...options,narration:true,maxLines:5,maxLineChars:120,draftMaxChars:600};
 const lines=renderProgressLines(body,opts);
 assert.equal(lines.length,4);
 assert(lines[0].length<=600&&lines[0].includes('新的思考末尾')&&lines[0].startsWith('💭 …'));
 assert(lines[1].length<=600&&lines[1].includes('此处是新的草稿末尾')&&lines[1].startsWith('📝 草稿 · …'));
 assert(lines[2].length<=120&&lines[2].startsWith('⏳ 执行命令'));
 assert(lines[3].length<=600&&lines[3].endsWith('现在正在输出'));
 const old=renderProgressLines(body,{...opts,draftMaxChars:undefined});
 assert(old[0].length<=120&&old[1].length<=120,'Feishu / legacy renderer still follows its old limit');
 assert(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(lines.join('')));
});

test('Feishu legacy timeline remains prefix-clipped and does not inherit Discord-only tail behavior',()=>{
 const body={activity:{timeline:[{type:'draft',text:'开头'+('思考'.repeat(150))+'结尾'}]}};
 const rendered=renderProgressLines(body,{...options,narration:true,maxLineChars:80})[0];
 assert(rendered.startsWith('💭 开头'));
 assert(!rendered.includes('结尾'));
 assert.equal(rendered.length,80);
});

test('Discord always places thinking above drafts when both exist, independently of event arrival order',()=>{
 const timeline=[
   {type:'public-draft',text:'前一阶段公开文本'},
   {type:'tool',activity:{name:'read_file',status:'completed',detail:'A.txt'}},
   {type:'draft',text:'后来才收到的思考'},
   {type:'tool',activity:{name:'pwsh',status:'running',detail:'npm test'}},
 ];
 const activity={timeline,activeTextDraft:'正在生成的后续草稿'};
 const selected={...options,narration:true,commentary:true,maxLines:5,pinDrafts:true};
 const rows=renderProgressLines({activity},selected);
 assert.deepEqual(rows,[
   '💭 后来才收到的思考',
   '📝 草稿 · 前一阶段公开文本',
   '📝 草稿 · 正在生成的后续草稿',
   '✅ 读取文件 · A.txt',
   '⏳ 执行命令 · npm test'
 ]);
 const old=renderProgressLines({activity},{...selected,pinDrafts:false});
 assert(old[0].startsWith('📝 草稿'),'Feishu continues preserving original chronology');
 assert(old[2].startsWith('💭 '));
});
test('Discord thinking above draft also applies when tool overflow triggers pinning',()=>{
 const activity={timeline:[
   {type:'public-draft',text:'旧草稿'},
   ...Array.from({length:9},(_,i)=>({type:'tool',activity:{name:'pwsh',status:'completed',detail:'tool-'+i}})),
   {type:'draft',text:'新思考'},
 ]};
 const rows=renderProgressLines({activity},{...options,narration:true,commentary:true,maxLines:5,pinDrafts:true});
 assert.equal(rows.length,5);
 assert(rows[0].includes('💭 新思考'));
 assert(rows[1].includes('📝 草稿 · 旧草稿'));
 assert(rows.at(-1).includes('tool-8'));
});

test('Discord draft and thinking retain source paragraph breaks, unlike the compact tool summaries',()=>{
 const settings={...options,narration:true,draftMaxChars:600,pinDrafts:true};
 const activity={timeline:[
   {type:'draft',text:'先检查昨天的日记。\r\n\r\n再看记忆整理结果。\r\n\r\n\r\n最后准备测试。'},
   {type:'public-draft',text:'第一段：完成排查。\n\n第二段：做完验证。\n第三行单换行仍保留。'},
   {type:'tool',activity:{name:'read',status:'completed',detail:'path\\nnext'}},
 ]};
 const rows=renderProgressLines({activity},settings);
 assert(rows[0].includes('日记。\n\n再看'));
 assert(!rows[0].includes('\n\n\n'),'excessive whitespace is collapsed');
 assert(rows[1].includes('排查。\n\n第二段'));
 assert(rows[1].includes('验证。\n第三行'));
 assert(!rows[2].includes('\n'),'tool lines remain concise');
 const legacy=renderProgressLines({activity},{...settings,draftMaxChars:undefined,pinDrafts:false});
 assert(!legacy[0].includes('\n'),'Feishu still uses compact legacy formatting');
});
test('Discord paragraphs survive latest-tail clipping and preserve complete Unicode',()=>{
 const settings={...options,narration:true,draftMaxChars:220,pinDrafts:true};
 const text='旧正文'.repeat(120)+'\n\n新段落的开始\n第二行 🐋\n\n收尾';
 const [draft]=renderProgressLines({activity:{timeline:[{type:'public-draft',text}]}},settings);
 assert(draft.startsWith('📝 草稿 · …'));
 assert(draft.includes('\n\n收尾'));
 assert(draft.endsWith('收尾'));
 assert(draft.length<=220);
 assert(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(draft));
});
