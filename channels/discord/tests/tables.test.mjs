import test from 'node:test';
import assert from 'node:assert/strict';
import { convertMarkdownTables } from '../tables.js';

/** Mirror of the module's width rule, used only to assert rendered alignment. */
function width(text) {
  let total = 0;
  for (const char of text) {
    const code = char.codePointAt(0);
    total += (code >= 0x1100 && code <= 0x115f) || (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f)
      || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe6f)
      || (code >= 0xff00 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6)
      || (code >= 0x1f300 && code <= 0x1faff) || (code >= 0x20000 && code <= 0x3fffd) ? 2 : 1;
  }
  return total;
}

const tableLines = text => text.split('\n').filter(line => line.startsWith('|'));

test('a table becomes an aligned code block in place', () => {
  const input = '| a | bb |\n| --- | --- |\n| 1 | 2 |';
  assert.equal(convertMarkdownTables(input), '```\n| a   | bb  |\n| --- | --- |\n| 1   | 2   |\n```');
});

test('rows keep the surrounding prose and table order', () => {
  const input = 'before\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\nafter';
  const output = convertMarkdownTables(input);
  assert.equal(output, 'before\n\n```\n| a   | b   |\n| --- | --- |\n| 1   | 2   |\n```\n\nafter');
});

test('double-width characters stay column aligned', () => {
  const output = convertMarkdownTables('| 提供方 | 优先级 |\n| --- | --- |\n| SearXNG | 1 |\n| 电池 | 22 |');
  const lines = tableLines(output);
  assert.equal(lines.length, 4);
  assert.equal(new Set(lines.map(width)).size, 1);
  assert.match(output, /^\|\s提供方\s+\|/mu);
});

test('a table inside a fenced block is left alone', () => {
  const input = '```text\n| a | b |\n| --- | --- |\n```';
  assert.equal(convertMarkdownTables(input), input);
});

test('an escaped pipe stays inside its cell', () => {
  const output = convertMarkdownTables('| a\\|b | c |\n| --- | --- |\n| 1 | 2 |');
  assert.match(output, /\| a\|b \| c   \|/u);
});

test('prose pipes without a delimiter row are untouched', () => {
  const input = 'use a | b to pipe\nand 1 | 2 too';
  assert.equal(convertMarkdownTables(input), input);
});

test('cells containing backticks grow the fence', () => {
  const output = convertMarkdownTables('| a | b |\n| --- | --- |\n| ``` | 2 |');
  const fence = output.split('\n')[0];
  assert.equal(fence, '````');
  assert.ok(output.endsWith('````'));
});

test('ragged rows are padded to the header width', () => {
  const output = convertMarkdownTables('| a | b |\n| --- | --- |\n| 1 |\n| 2 | 3 |');
  const lines = tableLines(output);
  assert.equal(lines.length, 4);
  assert.equal(new Set(lines.map(width)).size, 1);
  assert.match(output, /\| 1\s+\|\s+\|/u);
});

test('a single-column table is still converted', () => {
  const output = convertMarkdownTables('| name |\n| --- |\n| a |');
  assert.equal(output, '```\n| name |\n| ---- |\n| a    |\n```');
});

test('text without pipes is returned unchanged', () => {
  assert.equal(convertMarkdownTables('plain text'), 'plain text');
  assert.equal(convertMarkdownTables(undefined), '');
});
