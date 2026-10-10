import test from 'node:test';
import assert from 'node:assert/strict';
import { formatFinalWithQuotedDraft,quotePublicDraft } from '../final-format.js';

test('quote wrapper keeps every original paragraph inside the left-bar quote',()=>{
 assert.equal(quotePublicDraft('段落一\n\n段落二\r\n- 清单'),'> 段落一\n> \n> 段落二\n> - 清单');
 const parts=formatFinalWithQuotedDraft('检查配置\n\n第二段\n\n**结果**\n\n完成',{
  draftPrelude:'检查配置\n\n第二段',finalReplyText:'**结果**\n\n完成',
  footnote:'\n\n-# model · 上下文 20k'});
 assert.deepEqual(parts,[
  '**📝 过程草稿**\n\n> 检查配置\n> \n> 第二段\n\n**✅ 正式回复**\n\n**结果**\n\n完成\n\n-# model · 上下文 20k'
 ]);
});

test('single official answer, incomplete streaming and Ask User prefixes stay exactly as before',()=>{
 assert.deepEqual(formatFinalWithQuotedDraft('单条正式回答'),['单条正式回答']);
 assert.deepEqual(formatFinalWithQuotedDraft('正文', {draftPrelude:'已经公开的前缀',finalReplyText:'正文'}),
   ['正文'],'Ask User already displayed the prelude as standalone history');
 assert.deepEqual(formatFinalWithQuotedDraft('阶段性文字\n\n重新表述', {draftPrelude:'阶段性文字',finalReplyText:'不相符'}),
   ['阶段性文字\n\n重新表述'],'never guess textual draft boundaries');
});

test('very long multiline and fenced-code drafts split safely, without losing final markdown or footer',()=>{
 const draft='```js\nconst test = true;\n```\n\n'+('文字\n\n').repeat(420);
 const final='**正式回答**\n\n```ts\nconst ok = 1;\n```\n\n'+'长文字'.repeat(1600);
 const parts=formatFinalWithQuotedDraft(draft+'\n\n'+final,{
   draftPrelude:draft,finalReplyText:final,footnote:'\n\n-# 模型 · 上下文 100k'});
 assert(parts.length>4);
 assert(parts.every(part=>part.length<=1900));
 assert(parts[0].startsWith('**📝 过程草稿**\n\n> '));
 assert(parts.some(part=>part.startsWith('**✅ 正式回复**')));
 assert(parts.at(-1).endsWith('\n\n-# 模型 · 上下文 100k'));
 assert(!parts.join('\n').includes('PRIVATE-REASONING'));
});

test('draft quoting never uses reasoning metadata or body.drafts when explicit public boundary is absent',()=>{
 const value=formatFinalWithQuotedDraft('正常答复', {drafts:['仅思考内部'],footnote:'\n\n-# model'});
 assert.equal(value[0],'正常答复\n\n-# model');
});
