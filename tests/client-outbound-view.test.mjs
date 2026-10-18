import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

test('outbound-records UI and news-only model tools are removed; channel_send remains',()=>{
 const client=readFileSync(new URL('../lib/client.js',import.meta.url),'utf8');
 const manifest=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8'));
 assert(!client.includes('NewsArchiveView'));
 assert(!client.includes('installNewsArchiveView'));
 assert(!client.includes('news-outbound-archive'));
 assert(!client.includes("name: 'conversation.view'"));
 assert(!client.includes("name: 'conversation.session'"));
 assert(!manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-conversation'));
 const source=readFileSync(new URL('../lib/outbound-agent-tool.js',import.meta.url),'utf8');
 assert(source.includes("name:'channel_send'"));
 assert(!source.includes("action==='list'"));
 assert(!source.includes("action==='read'"));
 assert(!source.includes("name:'channel_news'"));
});
