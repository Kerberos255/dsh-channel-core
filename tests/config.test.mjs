import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ConfigFile, DEFAULT_CONFIG, configPath, validateConfig } from '../lib/config.js';

async function temporary(run, options) {
  const directory = fs.mkdtempSync(path.resolve('test-config-'));
  let store;
  try {
    store = new ConfigFile(path.join(directory, 'config.json'), options);
    await run(store, directory);
  } finally {
    store?.close();
    assert.ok(fs.realpathSync(directory).startsWith(fs.realpathSync(process.cwd()) + path.sep));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
const until = async predicate => {
  const end = Date.now() + 2500;
  while (!predicate()) {
    if (Date.now() > end) throw new Error('config watcher timed out');
    await new Promise(done => setTimeout(done, 20));
  }
};

test('fresh install creates the steering config outside installed code', () => temporary(store => {
  assert.deepEqual(store.value, DEFAULT_CONFIG);
  assert.deepEqual(JSON.parse(fs.readFileSync(store.filename)), DEFAULT_CONFIG);
  assert.equal(configPath('E:\\dsh\\home'), 'E:\\dsh\\plugins\\dsh-channel-core\\config.json');
  assert.notEqual(configPath('E:\\dsh\\home'), configPath('E:\\dsh\\staging\\isolated\\home'));
}));

test('complete validation rejects typos, coercion, unknown versions and malformed types', () => {
  for (const value of [null, [], 'queue', { defaultMode: 'steer' }, { sharedDM: 'false' }, { schemaVersion: 2 }, { inputMode: 'queue' }]) {
    assert.throws(() => validateConfig(value), { name: 'CoreError' });
  }
  assert.deepEqual(validateConfig({ defaultMode: 'queue' }), { ...DEFAULT_CONFIG, defaultMode: 'queue' });
});

test('revision prevents another page and manual edits from being overwritten', () => temporary(store => {
  const original = store.snapshot();
  const saved = store.save({ ...original.value, defaultMode: 'queue' }, original.revision);
  assert.equal(saved.value.defaultMode, 'queue');
  assert.throws(() => store.save(original.value, original.revision), { code: 'config-conflict' });
  fs.writeFileSync(store.filename, JSON.stringify({ ...DEFAULT_CONFIG, sharedDM: false }));
  assert.throws(() => store.save(original.value, saved.revision), { code: 'config-conflict' });
  assert.equal(store.reload().value.sharedDM, false);
}));

test('invalid edits preserve live policy; an explicit valid save repairs the same file', () => temporary(store => {
  store.save({ defaultMode: 'interrupt' }, store.snapshot().revision);
  fs.writeFileSync(store.filename, '{');
  const invalid = store.reload();
  assert.equal(invalid.error.code, 'invalid-config');
  assert.equal(store.value.defaultMode, 'interrupt');
  const repaired = store.save({ defaultMode: 'queue' }, invalid.revision);
  assert.equal(repaired.error, null);
  assert.equal(store.value.defaultMode, 'queue');
  assert.deepEqual(fs.readdirSync(path.dirname(store.filename)), ['config.json']);
}));

test('directory watcher follows atomic replacement and survives invalid then corrected JSON', () => temporary(async (store, directory) => {
  const replacement = path.join(directory, 'editor.tmp');
  fs.writeFileSync(replacement, JSON.stringify({ defaultMode: 'queue' }));
  fs.renameSync(replacement, store.filename);
  await until(() => store.value.defaultMode === 'queue');
  fs.writeFileSync(store.filename, JSON.stringify({ sharedDM: 'false' }));
  await until(() => store.error?.code === 'invalid-config');
  assert.equal(store.value.defaultMode, 'queue');
  fs.writeFileSync(store.filename, '\uFEFF' + JSON.stringify({ defaultMode: 'interrupt', sharedDM: false }));
  await until(() => store.value.defaultMode === 'interrupt' && !store.error);
  assert.equal(store.value.sharedDM, false);
}, { debounceMs: 20 }));

test('deleting config keeps active values and explicit save restores it', () => temporary(store => {
  store.save({ defaultMode: 'queue' }, store.snapshot().revision);
  fs.unlinkSync(store.filename);
  const missing = store.reload();
  assert.equal(missing.revision, 'missing');
  assert.equal(missing.value.defaultMode, 'queue');
  assert.equal(missing.error.code, 'config-missing');
  assert.equal(store.save(missing.value, missing.revision).error, null);
}));

test('stale process lock is recovered and a live writer lock is preserved', () => temporary(store => {
  const lock = store.filename + '.lock';
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid }));
  assert.throws(() => store.save({ defaultMode: 'queue' }, store.snapshot().revision), { code: 'config-busy' });
  assert.equal(fs.existsSync(lock), true);
  fs.writeFileSync(lock, JSON.stringify({ pid: 2147483647 }));
  assert.equal(store.save({ defaultMode: 'queue' }, store.snapshot().revision).value.defaultMode, 'queue');
}));

test('startup refuses corrupt or unsupported config without replacing the file', () => temporary(store => {
  store.close();
  const raw = '{"schemaVersion":2}';
  fs.writeFileSync(store.filename, raw);
  assert.throws(() => new ConfigFile(store.filename), { code: 'invalid-config' });
  assert.equal(fs.readFileSync(store.filename, 'utf8'), raw);
}));

test('dispose closes watcher, listeners and future saves', () => temporary(async store => {
  let events = 0;
  store.subscribe(() => events++);
  store.close();
  assert.equal(store.listeners.size, 0);
  assert.equal(store.watcher.isPersistent?.() ?? false, false);
  fs.writeFileSync(store.filename, JSON.stringify({ defaultMode: 'queue' }));
  await new Promise(done => setTimeout(done, 250));
  assert.equal(events, 0);
  assert.equal(store.value.defaultMode, 'steering');
  assert.throws(() => store.save(DEFAULT_CONFIG, store.snapshot().revision), { code: 'config-closed' });
}));
