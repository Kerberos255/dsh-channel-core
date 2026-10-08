import test from 'node:test';
import assert from 'node:assert/strict';
import { currentSelection, decodeModel, defaultEffort, describeSelection, effortChoices, encodeModel, modelChoices } from '../model-commands.js';

const catalog = {
  default: { provider: 'deepseek-account', model: 'deepseek-flash' },
  groups: [
    {
      id: 'deepseek-account',
      name: 'DeepSeek 账号',
      models: [
        { id: 'deepseek-flash', name: 'DeepSeek Flash', reasoning: { defaultEffort: 'max', efforts: [{ id: 'off', name: '关闭' }, { id: 'max', name: '最大' }] } },
        { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
      ],
    },
    {
      id: 'opencode-go',
      name: 'OpenCode Go',
      models: [{ id: 'minimax-m3', name: 'MiniMax-M3', reasoning: { efforts: [{ id: 'low', name: '低' }] } }],
    },
  ],
};

test('a model choice round-trips through its provider/model value', () => {
  assert.equal(encodeModel('deepseek-account', 'deepseek-flash'), 'deepseek-account/deepseek-flash');
  assert.deepEqual(decodeModel('deepseek-account/deepseek-flash'), { provider: 'deepseek-account', model: 'deepseek-flash' });
  assert.equal(decodeModel('no-slash'), undefined);
  assert.equal(decodeModel('/model'), undefined);
  assert.equal(decodeModel('provider/'), undefined);
  assert.equal(decodeModel(undefined), undefined);
});

test('model choices list every group and filter on the typed query', () => {
  const all = modelChoices(catalog);
  assert.deepEqual(all.map(choice => choice.value), ['deepseek-account/deepseek-flash', 'deepseek-account/deepseek-v4-flash', 'opencode-go/minimax-m3']);
  assert.equal(all[0].name, 'DeepSeek 账号 · DeepSeek Flash');
  assert.deepEqual(modelChoices(catalog, 'minimax').map(choice => choice.value), ['opencode-go/minimax-m3']);
  assert.deepEqual(modelChoices(catalog, 'OPENCODE').map(choice => choice.value), ['opencode-go/minimax-m3']);
  assert.deepEqual(modelChoices(catalog, 'v4').map(choice => choice.value), ['deepseek-account/deepseek-v4-flash']);
  assert.deepEqual(modelChoices(catalog, 'nothing-matches'), []);
});

test('model choices stop at the Discord limit and clip long labels', () => {
  const many = { groups: [{ id: 'p', name: 'P'.repeat(120), models: Array.from({ length: 40 }, (_, index) => ({ id: 'm' + index, name: 'M' + index })) }] };
  const choices = modelChoices(many);
  assert.equal(choices.length, 25);
  assert.ok(choices[0].name.length <= 100);
});

test('effort choices come from the model metadata only', () => {
  assert.deepEqual(effortChoices(catalog, 'deepseek-account', 'deepseek-flash').map(choice => choice.value), ['off', 'max']);
  assert.deepEqual(effortChoices(catalog, 'deepseek-account', 'deepseek-flash', '最大').map(choice => choice.value), ['max']);
  assert.deepEqual(effortChoices(catalog, 'deepseek-account', 'deepseek-v4-flash'), []);
  assert.deepEqual(effortChoices(catalog, 'missing', 'missing'), []);
});

test('the current selection prefers the pending choice, then the last used one, then the default', () => {
  assert.deepEqual(currentSelection(catalog, { values: { modelSelection: { next: { provider: 'p', model: 'm', reasoningEffort: 'low' }, lastUsed: { provider: 'x', model: 'y' } } } }), { provider: 'p', model: 'm', reasoningEffort: 'low' });
  assert.deepEqual(currentSelection(catalog, { values: { modelSelection: { next: null, lastUsed: { provider: 'x', model: 'y' } } } }), { provider: 'x', model: 'y' });
  assert.deepEqual(currentSelection(catalog, { values: {} }), catalog.default);
  assert.deepEqual(currentSelection(catalog, undefined), catalog.default);
});

test('default effort and description follow the catalog', () => {
  assert.equal(defaultEffort(catalog, 'deepseek-account', 'deepseek-flash'), 'max');
  assert.equal(defaultEffort(catalog, 'deepseek-account', 'deepseek-v4-flash'), undefined);
  assert.equal(describeSelection(catalog, { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'max' }), 'deepseek-account/deepseek-flash（推理强度：最大）');
  assert.equal(describeSelection(catalog, { provider: 'deepseek-account', model: 'deepseek-flash' }), 'deepseek-account/deepseek-flash（推理强度：默认）');
  assert.equal(describeSelection(catalog, { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'weird' }), 'deepseek-account/deepseek-flash（推理强度：weird）');
  assert.equal(describeSelection(catalog, undefined), '未知模型');
});
