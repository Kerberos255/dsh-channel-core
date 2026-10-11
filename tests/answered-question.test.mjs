import test from 'node:test';
import assert from 'node:assert/strict';
import { completedAskUserText } from '../lib/answered-question.js';

test('shared Ask User receipt displays submitted question and selected options',()=>{
 const text=completedAskUserText([{question:'先做哪些？',selected:['同步插件','检查部署']}]);
 assert.equal(text,'✅ 已回答\n\n问题：先做哪些？\n已选：同步插件、检查部署');
 assert(!text.includes('/answer'));
});
test('shared receipt displays several questions and custom replies',()=>{
 const text=completedAskUserText([
  {question:'计划？',selected:['整理资料'],custom:'先不要重启'},
  {question:'时间？',selected:[],custom:'明早'}
 ]);
 assert(text.includes('问题 1：计划？'));
 assert(text.includes('已选：整理资料'));
 assert(text.includes('补充回答：先不要重启'));
 assert(text.includes('问题 2：时间？'));
 assert(text.includes('补充回答：明早'));
});
test('shared Ask User receipt does not include hidden identifiers and stays bounded',()=>{
 const text=completedAskUserText([{question:'问题',selected:['选择'],custom:'甲'.repeat(5000)}],1800);
 assert(text.length<=1800);
 assert(text.includes('问题：问题'));
 assert(text.endsWith('…（内容已截断）'));
 assert.equal(completedAskUserText(), '✅ 已回答');
});
