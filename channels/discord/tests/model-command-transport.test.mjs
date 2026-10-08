import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { schema } from '../config.js';
import { createTransport } from '../transport.js';

const catalog = {
  default: { provider: 'deepseek-account', model: 'deepseek-flash' },
  groups: [
    { id: 'deepseek-account', name: 'DeepSeek 账号', models: [
      { id: 'deepseek-flash', name: 'DeepSeek Flash', reasoning: { defaultEffort: 'max', efforts: [{ id: 'off', name: '关闭' }, { id: 'max', name: '最大' }] } },
      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
    ] },
  ],
};

async function fixture({ host, sessions = async () => ['session-1'] } = {}) {
  const events = new EventEmitter(), calls = [], registered = [];
  const channel = { isTextBased: () => true, messages: { edit: async () => ({ id: 'x' }) }, send: async () => ({ id: 'y' }) };
  class Client {
    constructor() { this.user = { id: 'bot' }; this.application = { commands: { create: async command => { registered.push(command.name); return command; } } }; this.channels = { fetch: async () => channel }; }
    on(...args) { events.on(...args); }
    off(...args) { events.off(...args); }
    async login() {}
    async destroy() {}
  }
  const sdk = { Client, Options: { cacheWithLimits: () => () => {} }, GatewayIntentBits: { Guilds: 1, GuildMessages: 2, DirectMessages: 3, MessageContent: 4 }, Partials: { Channel: 1 } };
  const transport = await createTransport({ config: schema.validate({}), credentials: ['fixture'], signal: new AbortController().signal, receive: async () => {}, state: () => {}, action: async () => {}, sessions, ...(host ? { host } : {}) }, sdk);
  return { calls, events, registered, transport };
}

function interaction({ commandName, query = '', strings = {} }) {
  const state = { replied: undefined, deferred: false };
  return {
    commandName, user: { id: 'user' }, guildId: null, createdTimestamp: Date.now(), channel: { isThread: () => false, id: 'dm' },
    options: { getFocused: () => query, getString: name => strings[name] ?? null },
    isAutocomplete: () => Boolean(strings.autocomplete),
    isChatInputCommand: () => !strings.autocomplete,
    isMessageComponent: () => false,
    get deferred() { return state.deferred; },
    get replied() { return state.replied !== undefined; },
    async deferReply() { state.deferred = true; },
    async editReply(body) { state.replied = body.content; return { id: 'reply' }; },
    async followUp(body) { state.replied = body.content; },
    async respond(choices) { state.replied = choices; },
    result: () => state,
  };
}

const hostFixture = overrides => ({
  modelCatalog: async () => catalog,
  projections: async () => ({ values: { modelSelection: { next: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'off' } } } }),
  selectModel: async request => ({ selected: request }),
  ...overrides,
});

test('the transport registers dsh, model and think and drives /model through the Host', async () => {
  const seen = [];
  const f = await fixture({ host: hostFixture({ selectModel: async request => { seen.push(request); return { selected: request }; } }) });
  try {
    await f.transport.start();
    assert.deepEqual(f.registered, ['dsh', 'model', 'think']);

    const autocomplete = interaction({ commandName: 'model', query: 'v4', strings: { autocomplete: '1' } });
    f.events.emit('interactionCreate', autocomplete);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(autocomplete.result().replied, [{ name: 'DeepSeek 账号 · DeepSeek V4 Flash', value: 'deepseek-account/deepseek-v4-flash' }]);

    const command = interaction({ commandName: 'model', strings: { model: 'deepseek-account/deepseek-flash' } });
    f.events.emit('interactionCreate', command);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(seen, [{ sessionId: 'session-1', provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'max' }]);
    assert.match(command.result().replied, /已切换模型：deepseek-account\/deepseek-flash（推理强度：最大）/u);
  } finally { await f.transport.close(); }
});

test('/think reuses the Session selection and reports models without efforts', async () => {
  const seen = [];
  const f = await fixture({ host: hostFixture({ selectModel: async request => { seen.push(request); return { selected: request }; } }) });
  try {
    const command = interaction({ commandName: 'think', strings: { effort: 'max' } });
    f.events.emit('interactionCreate', command);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(seen, [{ sessionId: 'session-1', provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'max' }]);
    assert.match(command.result().replied, /推理强度已更新/u);

    const flat = hostFixture({ projections: async () => ({ values: { modelSelection: { next: { provider: 'deepseek-account', model: 'deepseek-v4-flash' } } } }) });
    const g = await fixture({ host: flat });
    try {
      const blocked = interaction({ commandName: 'think', strings: { effort: 'max' } });
      g.events.emit('interactionCreate', blocked);
      await new Promise(resolve => setImmediate(resolve));
      assert.match(blocked.result().replied, /没有公布可选的推理强度/u);
    } finally { await g.transport.close(); }
  } finally { await f.transport.close(); }
});

test('model commands degrade when the channel has no session or the Host refuses', async () => {
  const f = await fixture({ sessions: async () => [], host: hostFixture() });
  try {
    const orphan = interaction({ commandName: 'model', strings: { model: 'deepseek-account/deepseek-flash' } });
    f.events.emit('interactionCreate', orphan);
    await new Promise(resolve => setImmediate(resolve));
    assert.match(orphan.result().replied, /还没有可用会话/u);
  } finally { await f.transport.close(); }

  const failing = await fixture({ host: hostFixture({ selectModel: async () => { throw new Error('session/model-unavailable: gone'); } }) });
  try {
    const refused = interaction({ commandName: 'model', strings: { model: 'deepseek-account/deepseek-flash' } });
    failing.events.emit('interactionCreate', refused);
    await new Promise(resolve => setImmediate(resolve));
    assert.match(refused.result().replied, /操作失败：session\/model-unavailable/u);
  } finally { await failing.transport.close(); }

  const bare = await fixture();
  try {
    const unsupported = interaction({ commandName: 'think', strings: { effort: 'max' } });
    bare.events.emit('interactionCreate', unsupported);
    await new Promise(resolve => setImmediate(resolve));
    assert.match(unsupported.result().replied, /不支持模型命令/u);
  } finally { await bare.transport.close(); }
});
