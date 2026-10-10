import test from 'node:test';
import assert from 'node:assert/strict';
import { toolDetail, summarizeCommand, urlDetail, cutDetail } from '../lib/tool-detail.js';
import { renderProgressLines } from '../lib/progress-lines.js';

test('command tools prefer the caller description over the raw command', () => {
  const detail = toolDetail('pwsh', { description: '检查 openclaw 是否有更新', command: "$env:HTTPS_PROXY='http://127.0.0.1:10808'; gh release list" });
  assert.equal(detail, '检查 openclaw 是否有更新');
});

test('without a description the command is unwrapped: env prefixes and pwsh wrapper go away', () => {
  const detail = toolDetail('pwsh', { command: "$env:HTTPS_PROXY='http://127.0.0.1:10808/'; $env:HTTP_PROXY='http://127.0.0.1:10808'; gh release view v2026.9.9 -R openclaw/openclaw --json body" });
  assert.match(detail, /^gh release view v2026\.9\.9/);
  assert.ok(!detail.includes('$env:'));
  assert.ok(!detail.includes('HTTP_PROXY'));
});

test('control-flow shells jump to the first real command inside the script', () => {
  const detail = summarizeCommand(`pwsh -NoProfile -NonInteractive -Command "foreach ($x in 1..2) { node --test tests/*.test.mjs }"`);
  assert.match(detail, /^node --test tests\/\*\.test\.mjs$/);
});

test('file tools show the basename and an optional line range', () => {
  assert.equal(toolDetail('read_file', { file_path: 'E:\\dsh\\cache\\temp\\tool-detail.js' }), 'tool-detail.js');
  assert.equal(toolDetail('read', { file_path: 'E:\\dsh\\x\\tool-detail.js', offset: 24, limit: 7 }), 'tool-detail.js:24-30');
});

test('web fetch keeps the whole URL and only shortens very long ones', () => {
  const url = 'https://raw.githubusercontent.com/openclaw/openclaw/v2026.9.9/CHANGELOG/2026.9.9.md';
  assert.equal(toolDetail('web_fetch', { url }), url);
  const long = 'https://example.com/' + 'segment/'.repeat(12) + 'final-report.md';
  const short = toolDetail('web_fetch', { url: long });
  assert.ok(short.length <= 110);
  assert.ok(short.includes('/…/'));
  assert.ok(short.endsWith('final-report.md'));
});

test('search keywords are quoted, credentials stay masked, results stay whole words', () => {
  assert.equal(toolDetail('web_search', { query: 'openclaw 9.9 更新' }), '"openclaw 9.9 更新"');
  assert.equal(toolDetail('grep', { pattern: 'narration', path: 'E:\\dsh\\dsh-plugins\\dsh-channel-core' }), '"narration" · dsh-channel-core');
  assert.equal(toolDetail('pwsh', { command: 'npm pack --token=SUPERSECRETVALUE' }), 'npm pack --token=***');
  const prose  = '一二三四五 六七八九十 甲乙丙丁戊 己庚辛壬癸 子丑寅卯辰 巳午未申酉 戌亥天地玄黄 日月盈昃辰宿列张 寒来暑往秋收冬藏 闰余成岁律吕调阳 云腾致雨露结为霜';
  const detail = toolDetail('pwsh', { description: prose });
  assert.ok(detail.endsWith('…'));
  assert.ok(detail.length <= 73);
  const withoutEllipsis = detail.slice(0, -1);
  assert.ok(prose.startsWith(withoutEllipsis));
  assert.ok(prose[withoutEllipsis.length] === ' ');
});

test('argument-less and array tools still say something useful', () => {
  assert.equal(toolDetail('todo_write', { todos: [1, 2, 3] }), '3 项');
  assert.equal(toolDetail('job_output', { job_id: '3f71a2' }), '作业 3f71a2');
  assert.equal(toolDetail('job_list', {}), '');
  assert.equal(toolDetail('schedule_list', {}), '');
  assert.equal(toolDetail('memory_dream', { kind: 'daily' }), 'daily');
  assert.equal(toolDetail('lcm_expand', { seq: 128 }), '事件 128');
  assert.equal(toolDetail('ask_user_question', { questions: [{ id: 'a' }] }), '1 个问题');
  assert.equal(toolDetail('send_message', { agent_id: '3f71' }), '子代理 3f71');
  assert.equal(toolDetail('present', { files: [{ path: 'a' }, { path: 'b' }] }), '2 个文件');
});

test('browser and desktop tools describe the target and the action', () => {
  assert.equal(toolDetail('browser_navigate', { url: 'https://example.com/a/b' }), 'https://example.com/a/b');
  assert.equal(toolDetail('browser_snapshot', {}), '整页');
  assert.equal(toolDetail('browser_click', { ref: 'e12', double: true }), '元素 e12 · 双击');
  assert.equal(toolDetail('browser_type', { ref: 'e7', submit: true }), '元素 e7 · 并提交');
  assert.equal(toolDetail('desktop_snapshot', { title: 'Discord' }), 'Discord');
});

test('progress rows use Chinese labels for every tool family and keep unknown names', () => {
  const options = { toolProgress: true, commentary: false, narration: false, toolDetail: true, maxLines: 6, maxLineChars: 80 };
  const rows = renderProgressLines({ activity: { tools: [
    { name: 'browser_navigate', status: 'completed', detail: 'https://example.com/a' },
    { name: 'todo_write', status: 'completed', detail: '3 项' },
    { name: 'lcm_grep', status: 'running', detail: '"部署方式"' },
    { name: 'brand_new_tool', status: 'completed', detail: 'target' },
  ] } }, options);
  assert.deepEqual(rows, [
    '✅ 打开网页 · https://example.com/a',
    '✅ 更新计划 · 3 项',
    '⏳ 上下文检索 · "部署方式"',
    '✅ brand_new_tool · target',
  ]);
});

test('URL trimming and word-boundary cuts never split a surrogate pair', () => {
  const emoji = urlDetail('https://例子.example/' + '🐋'.repeat(80) + '/报告.md');
  assert.ok(emoji.length <= 110);
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(emoji));
  const clipped = cutDetail('🐋'.repeat(60), 41);
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(clipped));
});
