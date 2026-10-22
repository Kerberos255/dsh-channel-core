import test from 'node:test';
import assert from 'node:assert/strict';
import { closeDetail } from '../transport.js';

const now = 1_000_000;

test('a Discord-side close keeps its code and reason', () => {
  const detail = closeDetail({ code: 4004, reason: 'Session expired' }, now - 7_200_000, now);
  assert.deepEqual(detail, { code: 4004, reason: 'Session expired', uptimeMs: 7_200_000 });
});

test('a broken transport is reported as code 1006 and stays distinguishable', () => {
  const detail = closeDetail({ code: 1006 }, now - 1_000, now);
  assert.equal(detail.code, 1006);
  assert.equal(detail.reason, null);
  assert.equal(detail.uptimeMs, 1_000);
});

test('missing metadata never becomes a fabricated number', () => {
  assert.deepEqual(closeDetail(undefined, undefined, now), { code: null, reason: null, uptimeMs: null });
  assert.deepEqual(closeDetail({ code: '4000' }, null, now), { code: null, reason: null, uptimeMs: null });
  assert.deepEqual(closeDetail({ code: 4000 }, now + 5_000, now), { code: 4000, reason: null, uptimeMs: 0 });
});

test('long reasons are bounded so a close event cannot bloat diagnostics', () => {
  const detail = closeDetail({ code: 4000, reason: 'x'.repeat(500) }, null, now);
  assert.equal(detail.reason.length, 120);
});
