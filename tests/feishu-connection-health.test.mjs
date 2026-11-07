import test from 'node:test';
import assert from 'node:assert/strict';
import { feishuConnectionHealth } from '../lib/feishu-connection-health.js';

test('Feishu SDK connected status is healthy even with no incoming messages', () => {
  const channel = { getConnectionStatus: () => ({ state:'connected', lastConnectTime:123 }) };
  assert.deepEqual(feishuConnectionHealth(channel), { ready:true, recovering:false, terminal:false, code:null });
});

test('Feishu SDK connecting and reconnecting are not mistaken for ready', () => {
  for (const state of ['connecting','reconnecting']) {
    const health = feishuConnectionHealth({ getConnectionStatus: () => ({ state }) });
    assert.equal(health.ready,false);
    assert.equal(health.recovering,true);
    assert.equal(health.terminal,false);
  }
});

test('Feishu SDK failed state is transient and eligible for recovery after grace', () => {
  const result = feishuConnectionHealth({ getConnectionStatus: () => ({ state:'failed' }) });
  assert.deepEqual(result, { ready:false, recovering:false, terminal:false, code:'feishu-sdk-failed' });
});

test('Feishu SDK idle socket does not remain reported as healthy', () => {
  assert.deepEqual(feishuConnectionHealth({ getConnectionStatus: () => ({ state:'idle' }) }),
    { ready:false, recovering:false, terminal:false, code:null });
});

test('Feishu missing SDK status and status-check errors degrade safely', () => {
  assert.equal(feishuConnectionHealth({}).ready,false);
  assert.deepEqual(feishuConnectionHealth({ getConnectionStatus(){ throw new Error('fixture'); } }),
    { ready:false, recovering:false, terminal:false, code:'feishu-health-check-failed' });
});

test('Feishu shutdown never reports an active connection', () => {
  const signal = new AbortController();
  signal.abort();
  assert.deepEqual(feishuConnectionHealth({ getConnectionStatus: () => ({ state:'connected' }) },signal.signal),
    { ready:false, recovering:false, terminal:false, code:null });
});
