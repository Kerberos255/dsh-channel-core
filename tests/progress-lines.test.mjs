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

test('reasoning tail is opt-in, not entire narration; public commentary remains separate',()=>{
 const body={activity:{narration:'先思考\n最后一行',commentary:'安全的公开说明',tools:[]}};
 assert.deepEqual(renderProgressLines(body,options),['💬 安全的公开说明']);
 assert.deepEqual(renderProgressLines(body,{...options,narration:true}),['💭 最后一行','💬 安全的公开说明']);
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
