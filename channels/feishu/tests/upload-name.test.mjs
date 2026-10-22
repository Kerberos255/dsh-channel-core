import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { schema } from '../config.js';
import { createTransport } from '../transport.js';

const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x7e, 0xc1, 0x01, 0x00]), Buffer.from('WEBP'), Buffer.alloc(32, 7)]);
const png = Buffer.concat([Buffer.from([0x89]), Buffer.from('PNG'), Buffer.from([0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 3)]);
const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 5)]);

function fixture(bytes, extra = {}) {
  const channel = {
    on() { return () => {}; },
    async send() { return { messageId: 'sent-1' }; },
    async updateCard() {},
    async connect() {}, async disconnect() {},
    rawClient: {
      im: { v1: { messageResource: { get: async () => ({ getReadableStream: () => Readable.from([bytes]) }) } } },
    },
  };
  const sdk = { createLarkChannel: () => channel, Domain: { Lark: 'lark', Feishu: 'feishu' } };
  const create = () => createTransport({
    config: schema.validate({ streaming: { mode: 'progress' } }),
    credentials: ['fixture'],
    signal: new AbortController().signal,
    receive: async () => {}, state: () => {}, action: async () => {},
    ...extra,
  }, sdk);
  return { create };
}

const uploadWith = async (bytes, resource) => {
  const f = fixture(bytes);
  const t = await f.create();
  const accepted = [];
  try {
    const files = await t.upload(
      { messageId: 'm1', resources: [{ fileKey: 'k1', type: 'image', ...resource }] },
      'session-1',
      { uploadStream: async ({ name, data }) => {
        const chunks = [];
        for await (const chunk of data) chunks.push(chunk);
        accepted.push({ name, bytes: Buffer.concat(chunks) });
        return { receiptId: 'receipt-1' };
      } },
      new AbortController().signal,
    );
    assert.deepEqual(files, [{ receiptId: 'receipt-1' }]);
    return accepted[0];
  } finally { await t.close(); }
};

test('a WebP screenshot is stored with its real extension instead of image.png', async () => {
  const accepted = await uploadWith(webp, {});
  assert.equal(accepted.name, 'image.webp');
  assert.deepEqual(accepted.bytes, webp, 'the bytes survive the probe untouched');
});

test('PNG and JPEG payloads keep their own extensions', async () => {
  assert.equal((await uploadWith(png, {})).name, 'image.png');
  assert.equal((await uploadWith(jpg, {})).name, 'image.jpg');
});

test('an explicit file name from Feishu always wins', async () => {
  const accepted = await uploadWith(webp, { fileName: '原图.png' });
  assert.equal(accepted.name, '原图.png');
  assert.deepEqual(accepted.bytes, webp);
});
