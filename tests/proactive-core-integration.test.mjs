import test from 'node:test';
import assert from 'node:assert/strict';
import ChannelCore from '../lib/index.js';

test('channel core module loads the optional outbound tool dependencies',()=>{
 assert.equal(typeof ChannelCore,'function');
 assert.equal(typeof ChannelCore.prototype.sendToBoundSession,'function');
});
