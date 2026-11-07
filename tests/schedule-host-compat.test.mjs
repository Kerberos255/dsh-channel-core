import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compatibleSchedule } from '../lib/schedule-host-compat.js';

const row = (id, sessionId) => ({ id, title: 'Reminder', prompt: 'ping', kind: 'daily', time: '09:00:00.000', timeZone: 'Asia/Shanghai', scheduledAt: '2026-11-08T01:00:00.000Z', status: 'active', target: { kind: 'session', sessionId } });

test('old /new Scheduler API is unchanged', () => {
  const old={catalog(){}, create(){}, delete(){}};
  assert.equal(compatibleSchedule(old),old);
});

test('new /new API maps only owned fixed-Session tasks and creates replacements in target Session', async () => {
  const writes=[];
  const api=compatibleSchedule({catalog:async()=>[row('a','old'),row('b','other'),{id:'free',status:'active',target:{kind:'new'}}],create:async (...args)=>{writes.push(args);return row('new-id','new');},edit:async (...args)=>{writes.push(args);return {id:'a',deleted:true}}});
  const tasks=(await api.catalog()).filter(r=>r.sessionId==='old');
  assert.deepEqual(tasks.map(r=>r.id),['a']);
  const created=await api.create('new',{title:'Reminder',prompt:'ping',daily:{time:'09:00:00.000',time_zone:'Asia/Shanghai'}});
  assert.equal(created.sessionId,'new');
  assert.deepEqual(writes[0][0].target,{kind:'session',sessionId:'new'});
  assert.equal(writes[0][0].timing.kind,'daily');
  assert.equal((await api.delete({sessionId:'other',id:'a'})).deleted,false);
  assert.equal(writes.length,1);
  assert.equal((await api.delete({sessionId:'old',id:'a'})).deleted,true);
  assert.equal(writes[1][0].action,'delete');
});

test('new /new migration refuses ambiguous deletions, no blind retry', async () => {
  const api=compatibleSchedule({catalog:async()=>[row('a','old')],create:async()=>row('new-id','new'),edit:async()=>({code:'schedule_conflict'})});
  await assert.rejects(api.delete({sessionId:'old',id:'a'}),/unconfirmed/);
});
