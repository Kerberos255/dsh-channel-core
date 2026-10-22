import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelBridge } from '../lib/bridge.js';
import { CoreStore } from '../lib/store.js';

function fixture() {
  const store = new CoreStore(':memory:'), events = new Map();
  const ctx = { on(name, fn) { events.set(name, fn); return () => events.delete(name); } };
  const bridge = new ChannelBridge(ctx, { store }), session = { id: 'test-session' }, agent = { session };
  store.setOwner('feishu', 'live', 'owner');
  return { store, bridge, ctx, events, session, agent, async close() { await bridge.close(); store.close(); } };
}

const settle = async f => { await new Promise(done => setTimeout(done, 15)); await f.bridge.idle(); };

function claim(f, key, origin, turn = 1) {
  f.store.claim({ key, requestId: key, sessionId: f.session.id, origin, payload: key });
  f.bridge.claimed(f.session, key, turn);
}

test('Feishu Steer freezes the earlier card and moves the active origin to the newest message', async () => {
  const f = fixture();
  const cuts = [];
  const off = f.bridge.register('feishu', 'live', {
    throttleMs: 1,
    progress: async () => {},
    cutProgress: async args => { cuts.push(args); return {}; },
    send: async () => ({ messageId: 'reply-1' }),
  });
  try {
    const first = { provider: 'feishu', accountId: 'live', conversationId: 'chat-1', messageId: 'feishu-a', userId: 'owner' };
    claim(f, 'f-a', first);
    claim(f, 'f-b', { ...first, messageId: 'feishu-b' });
    await settle(f);

    assert.equal(cuts.length, 1, 'exactly one card transition');
    assert.equal(cuts[0].previousOrigin.messageId, 'feishu-a');
    assert.equal(cuts[0].nextOrigin.messageId, 'feishu-b');
    assert.equal(cuts[0].turn, 1);

    const targets = f.bridge.outputOrigins(f.session.id, 1).filter(item => item.provider === 'feishu');
    assert.deepEqual(targets.map(item => item.messageId), ['feishu-b'], 'progress continues on the newest message');

    const state = f.bridge.state(f.session.id, 1);
    assert.ok(state.steerCut, 'cut recorded');
    assert.equal(typeof state.steerCut.seq, 'number');
    assert.ok(state.timeline.some(item => item.type === 'steer-boundary'));
  } finally {
    await off(); await f.close();
  }
});

test('two interjections in one Turn freeze twice and chain the anchors', async () => {
  const f = fixture();
  const cuts = [];
  const off = f.bridge.register('feishu', 'live', {
    throttleMs: 1,
    progress: async () => {},
    cutProgress: async args => { cuts.push(args); return {}; },
    send: async () => ({ messageId: 'reply-1' }),
  });
  try {
    const first = { provider: 'feishu', accountId: 'live', conversationId: 'chat-1', messageId: 'm1', userId: 'owner' };
    claim(f, 'c1', first);
    claim(f, 'c2', { ...first, messageId: 'm2' });
    await settle(f);
    claim(f, 'c3', { ...first, messageId: 'm3' });
    await settle(f);

    assert.equal(cuts.length, 2, 'one transition per interjection');
    assert.deepEqual(cuts.map(item => item.previousOrigin.messageId), ['m1', 'm2'], 'each cut freezes the card it replaced');
    assert.deepEqual(cuts.map(item => item.nextOrigin.messageId), ['m2', 'm3']);
    const targets = f.bridge.outputOrigins(f.session.id, 1).filter(item => item.provider === 'feishu');
    assert.deepEqual(targets.map(item => item.messageId), ['m3'], 'the newest anchor wins');
  } finally {
    await off(); await f.close();
  }
});

test('a freshly split segment opens no card until it has content', async () => {
  const f = fixture();
  const progress = [];
  const off = f.bridge.register('feishu', 'live', {
    throttleMs: 1,
    progress: async (from, body) => progress.push({ from, body }),
    cutProgress: async () => ({}),
    send: async () => ({ messageId: 'reply-1' }),
  });
  try {
    const first = { provider: 'feishu', accountId: 'live', conversationId: 'chat-1', messageId: 'm1', userId: 'owner' };
    claim(f, 'n1', first);
    claim(f, 'n2', { ...first, messageId: 'm2' });
    await settle(f);
    const before = progress.length;
    f.bridge.progress({ ...first, messageId: 'm2' }, f.bridge.state(f.session.id, 1));
    await settle(f);
    assert.equal(progress.length, before, 'no empty "thinking only" card on the new segment');
  } finally {
    await off(); await f.close();
  }
});

test('an abandoned card is retired when the Turn ends', async () => {
  const f = fixture();
  const cuts = [];
  const off = f.bridge.register('feishu', 'live', {
    throttleMs: 1,
    progress: async () => {},
    cutProgress: async args => { cuts.push(args); return {}; },
    send: async () => ({ messageId: 'reply-1' }),
  });
  try {
    const first = { provider: 'feishu', accountId: 'live', conversationId: 'chat-1', messageId: 'm1', userId: 'owner' };
    claim(f, 'r1', first);
    claim(f, 'r2', { ...first, messageId: 'm2' });
    await settle(f);
    f.bridge.event(f.session, { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '完成' }] } } });
    f.bridge.event(f.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
    await settle(f);

    const forFirst = cuts.filter(item => item.previousOrigin.messageId === 'm1');
    assert.equal(forFirst.length, 2, 'the replaced card is frozen once by the cut and once at Turn end');
    assert.ok(forFirst.every(item => item.retire !== undefined || item.nextOrigin), 'retirement reuses the freeze path');
    assert.equal(cuts.filter(item => item.previousOrigin.messageId === 'm2' && item.retire).length, 0, 'the active card is never retired');
  } finally {
    await off(); await f.close();
  }
});

test('a Turn without an interjection keeps one card and never cuts', async () => {
  const f = fixture();
  const cuts = [];
  const off = f.bridge.register('feishu', 'live', {
    throttleMs: 1,
    progress: async () => {},
    cutProgress: async args => { cuts.push(args); return {}; },
    send: async () => ({ messageId: 'reply-1' }),
  });
  try {
    const first = { provider: 'feishu', accountId: 'live', conversationId: 'chat-1', messageId: 'feishu-a', userId: 'owner' };
    claim(f, 'f-a', first);
    await settle(f);
    assert.equal(cuts.length, 0);
    assert.equal(f.bridge.state(f.session.id, 1).steerCut, null);
    const targets = f.bridge.outputOrigins(f.session.id, 1).filter(item => item.provider === 'feishu');
    assert.deepEqual(targets.map(item => item.messageId), ['feishu-a']);
  } finally {
    await off(); await f.close();
  }
});

test('a second message in another conversation does not cut the first one', async () => {
  const f = fixture();
  const cuts = [];
  const off = f.bridge.register('feishu', 'live', {
    throttleMs: 1,
    progress: async () => {},
    cutProgress: async args => { cuts.push(args); return {}; },
    send: async () => ({ messageId: 'reply-1' }),
  });
  try {
    const first = { provider: 'feishu', accountId: 'live', conversationId: 'chat-1', messageId: 'feishu-a', userId: 'owner' };
    claim(f, 'f-a', first);
    claim(f, 'f-b', { ...first, conversationId: 'chat-2', messageId: 'feishu-b' });
    await settle(f);
    assert.equal(cuts.length, 0, 'different conversations stay independent');
    const targets = f.bridge.outputOrigins(f.session.id, 1).filter(item => item.provider === 'feishu');
    assert.deepEqual(targets.map(item => item.messageId), ['feishu-a', 'feishu-b']);
  } finally {
    await off(); await f.close();
  }
});

test('Feishu final answer follows the newest message after a Steer', async () => {
  const f = fixture();
  const sent = [];
  const off = f.bridge.register('feishu', 'live', {
    throttleMs: 1,
    progress: async () => {},
    cutProgress: async () => ({}),
    send: async (from, body) => { sent.push({ from, body }); return { messageId: 'reply-' + sent.length }; },
  });
  try {
    const first = { provider: 'feishu', accountId: 'live', conversationId: 'chat-1', messageId: 'feishu-a', userId: 'owner' };
    claim(f, 'f-a', first);
    claim(f, 'f-b', { ...first, messageId: 'feishu-b' });
    f.bridge.event(f.session, { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '同一轮完成' }] } } });
    f.bridge.event(f.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
    await settle(f);

    const finals = sent.filter(item => item.body.final === true);
    assert.equal(finals.length, 1, 'one final answer');
    assert.equal(finals[0].from.messageId, 'feishu-b', 'final answer replies to the interjection');
  } finally {
    await off(); await f.close();
  }
});

test('Discord steering keeps its single-card behaviour', async () => {
  const f = fixture();
  const cuts = [];
  const sent = [];
  const off = f.bridge.register('discord', 'live', {
    throttleMs: 1,
    progress: async () => {},
    cutProgress: async args => { cuts.push(args); return {}; },
    send: async (from, body) => { sent.push({ from, body }); return { messageId: 'reply-' + sent.length }; },
  });
  try {
    const first = { provider: 'discord', accountId: 'live', conversationId: 'dm-1', messageId: 'discord-a', userId: 'owner' };
    claim(f, 'd-a', first);
    claim(f, 'd-b', { ...first, messageId: 'discord-b' });
    await settle(f);

    assert.equal(cuts.length, 0, 'Discord never splits cards');
    const targets = f.bridge.outputOrigins(f.session.id, 1).filter(item => item.provider === 'discord');
    assert.deepEqual(targets.map(item => item.messageId), ['discord-a']);

    f.bridge.event(f.session, { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '同一轮完成' }] } } });
    f.bridge.event(f.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
    await settle(f);
    const finals = sent.filter(item => item.body.final === true);
    assert.equal(finals.at(-1).from.messageId, 'discord-b', 'Discord already replies to the latest steer input');
  } finally {
    await off(); await f.close();
  }
});
