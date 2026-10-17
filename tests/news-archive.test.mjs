import test from 'node:test';
import assert from 'node:assert/strict';
import { CoreStore } from '../lib/store.js';
import { ChannelBridge } from '../lib/bridge.js';
import { ProactiveOutbound } from '../lib/proactive-outbound.js';
import { routeKeys } from '../lib/routing.js';

const sessionId='session-news-records';
const scope={workspaceId:'w',presetId:'default',memoryNamespace:'private',scheduleNamespace:'private',identityId:'owner'};
function fixture() {
  const store=new CoreStore(':memory:');
  const config={enabled:true,accountId:'bot',allowGroups:true,groupPolicy:'all',dmPolicy:'disabled'};
  const ctx={on(){return ()=>{}},get(name){
    if(name==='feishuChannelSettings')return {configFile:{value:config}};
  }};
  const core={ctx,store,configFile:{value:{sharedDM:true}}};
  const bridge=new ChannelBridge(ctx,core);
  core.bridge=bridge;
  const route={provider:'feishu',accountId:'bot',kind:'group',conversationId:'chat-news',sessionId,scope};
  store.putBinding(routeKeys(route,scope,true).bindingKey,route);
  const outgoing=new ProactiveOutbound(core);
  const sent=[];
  return {store,core,bridge,outgoing,sent,
    online(sender=async(_origin,body)=>{sent.push(body);return {messageId:'feishu-'+sent.length}}){
      return bridge.register('feishu','bot',{send:sender});
    },
    async close(){await bridge.close();store.close();}
  };
}
test('news is archived before transport and stores the exact text, time and Feishu ID',async()=>{
  const f=fixture();
  try {
    let observed;
    f.online(async(_origin,body)=>{
      observed=f.bridge.store.newsRecords(sessionId).records[0];
      f.sent.push(body);
      return {messageId:'om_12345'};
    });
    const result=await f.outgoing.send({sessionId,source:'windows-news',text:'# 原始新闻\n**内容**',idempotencyKey:'windows-news-20261018-09-00'});
    assert.equal(result.state,'sent');
    assert.equal(result.messageId,'om_12345');
    assert.equal(observed.text,'# 原始新闻\n**内容**');
    assert.equal(observed.state,'pending','must exist before external side effect');
    const rows=f.bridge.store.newsRecords(sessionId).records;
    assert.equal(rows.length,1);
    assert.equal(rows[0].state,'sent');
    assert.equal(rows[0].messageId,'om_12345');
    assert(Number.isFinite(rows[0].sentAt));
    assert(rows[0].sentAt>=rows[0].createdAt);
    assert.equal(rows[0].idempotencyKey,'windows-news-20261018-09-00');
    assert.equal(f.bridge.store.newsSessions()[0],sessionId);
    assert.equal(f.store.db.prepare('SELECT count(*) AS count FROM channel_turn_origins').get().count,0,'no native user turn is appended');
    const again=await f.outgoing.send({sessionId,source:'windows-news',text:'# 原始新闻\n**内容**',idempotencyKey:'windows-news-20261018-09-00'});
    assert.equal(again.id,result.id);
    assert.equal(f.sent.length,1);
    await assert.rejects(f.outgoing.send({sessionId,source:'windows-news',text:'被修改的原文',idempotencyKey:'windows-news-20261018-09-00'}),{code:'outbound-idempotency-conflict'});
    f.store.db.prepare('UPDATE channel_deliveries SET created_at=? WHERE id=?').run(1,result.id);
    f.bridge.store.prune(Date.now());
    assert.equal(f.bridge.store.newsRecords(sessionId).records[0].text,'# 原始新闻\n**内容**','body cleanup never destroys archive');
  }finally{await f.close();}
});
test('failed and uncertain statuses are retained, without guessing a message ID',async()=>{
  const f=fixture();
  try {
    f.online(async()=>{throw Object.assign(new Error('offline'),{definitelyNotSent:true,code:'offline'});});
    const failed=await f.outgoing.send({sessionId,source:'windows-news',text:'无法发送',idempotencyKey:'windows-news-failed-00'});
    assert.equal(failed.state,'failed');
    let rows=f.bridge.store.newsRecords(sessionId).records;
    assert.equal(rows.length,1);
    assert.equal(rows[0].messageId,null);
    assert.equal(rows[0].sentAt,null);
    assert.equal(rows[0].error,'offline');
  }finally{await f.close();}
  const g=fixture();
  try {
    g.online(async()=>{throw Error('ambiguous disconnect');});
    const result=await g.outgoing.send({sessionId,source:'windows-news',text:'状态未知',idempotencyKey:'windows-news-uncertain-00'});
    assert.equal(result.state,'uncertain');
    assert.equal(g.bridge.store.newsRecords(sessionId).records[0].state,'uncertain');
    await g.outgoing.send({sessionId,source:'windows-news',text:'状态未知',idempotencyKey:'windows-news-uncertain-00'});
    assert.equal(g.bridge.store.newsRecords(sessionId).records.length,1);
  }finally{await g.close();}
});
test('news paging is session-scoped; other proactive sources are not archived',async()=>{
  const f=fixture();
  try {
    f.online();
    for(let i=0;i<5;i++)await f.outgoing.send({sessionId,source:'windows-news',text:'新闻'+i,idempotencyKey:'windows-news-page-'+i});
    await f.outgoing.send({sessionId,source:'schedule',text:'非新闻任务',idempotencyKey:'ordinary'});
    const one=f.bridge.store.newsRecords(sessionId,{limit:2});
    assert.equal(one.records.length,2);
    assert.equal(one.hasMore,true);
    const last=one.records.at(-1);
    const two=f.bridge.store.newsRecords(sessionId,{limit:3,before:last.createdAt,cursorId:last.id});
    assert.equal(two.records.length,3);
    assert.equal(two.hasMore,false);
    assert.equal(new Set([...one.records,...two.records].map(r=>r.id)).size,5);
    assert.equal(f.bridge.store.newsRecords('session-other').records.length,0);
  }finally{await f.close();}
});

test('all Session-bound proactive sources are archived, while the old news-only query stays compatible',async()=>{
  const f=fixture();
  try{
    f.online();
    for(const [source,text] of [['windows-news','新闻原文'],['agent','模型工具通知'],['task-alert','计划任务报警']])
      await f.outgoing.send({sessionId,source,text,idempotencyKey:'generic-'+source});
    const all=f.bridge.store.outboundRecords(sessionId).records;
    assert.equal(all.length,3);
    assert.deepEqual(new Set(all.map(row=>row.source)),new Set(['windows-news','agent','task-alert']));
    assert(all.every(row=>row.provider==='feishu'&&row.state==='sent'&&row.messageId));
    assert.deepEqual(f.bridge.store.outboundSessions(),[sessionId]);
    assert.equal(f.bridge.store.newsRecords(sessionId).records.length,1,'legacy news API filters only news');
    await f.outgoing.send({sessionId,source:'agent',text:'模型工具通知',idempotencyKey:'generic-agent'});
    assert.equal(f.bridge.store.outboundRecords(sessionId).records.length,3,'retry cannot add a duplicate record');
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM channel_turn_origins').get().n,0,'outbound does not become a user event');
  }finally{await f.close();}
});
test('Discord records are Session-scoped and keep their provider, timestamps and message ID',async()=>{
  const store=new CoreStore(':memory:');
  const channelConfig={enabled:true,accountId:'bot',allowGroups:true,groupPolicy:'all',dmPolicy:'disabled'};
  const ctx={on(){return ()=>{}},get(name){if(['feishuChannelSettings','discordChannelSettings'].includes(name))return{configFile:{value:channelConfig}};}};
  const core={ctx,store,configFile:{value:{sharedDM:true}}};
  const bridge=new ChannelBridge(ctx,core);core.bridge=bridge;
  const route={provider:'discord',accountId:'bot',kind:'group',conversationId:'discord-target',sessionId:'session-discord-records',scope};
  const binding=store.putBinding(routeKeys(route,scope,true).bindingKey,route);
  const transport=bridge.register('discord','bot',{send:async()=>({messageId:'discord-123'})});
  try{
    const result=await new ProactiveOutbound(core).send({sessionId:route.sessionId,bindingId:binding.id,source:'schedule',
      text:'Discord 条件单结果',idempotencyKey:'schedule-discord-001'});
    assert.equal(result.state,'sent');
    const record=bridge.store.outboundRecords(route.sessionId).records[0];
    assert.equal(record.text,'Discord 条件单结果');
    assert.equal(record.provider,'discord');assert.equal(record.source,'schedule');
    assert.equal(record.messageId,'discord-123');assert(Number.isSafeInteger(record.sentAt));
    assert.equal(bridge.store.outboundRecords(sessionId).records.length,0);
  }finally{transport();await bridge.close();store.close();}
});
