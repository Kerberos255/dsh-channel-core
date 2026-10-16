import test from 'node:test';
import assert from 'node:assert/strict';
import {parseStatusMenuEvent,installStatusMenu} from '../channels/feishu/menu-status.js';
import {ChannelRuntime} from '../lib/channel-runtime.js';
import ChannelCore from '../lib/index.js';
const user='ou_abcdef123456';
const event=(key='status',id='unique1')=>({header:{event_id:id},event:{event_key:key,operator:{operator_id:{open_id:user}}}});
function fixture({status=async()=>({card:{schema:'2.0',body:{elements:[]}}})}={}){
 const handlers={},sent=[],notes=[];
 const channel={dispatcher:{register:events=>Object.assign(handlers,events)},rawClient:{im:{v1:{message:{create:async args=>{sent.push(args);return{code:0};}}}}}};
 const controller=new AbortController();
 const installed=installStatusMenu(channel,{onStatus:status,signal:controller.signal,state:(...args)=>notes.push(args)});
 assert.equal(installed,true);
 return{click:raw=>handlers['application.bot.menu_v6'](raw),sent,notes,controller};
}
test('Feishu menu event id status sends native card directly to operator open_id',async()=>{
 const f=fixture(),raw=event();
 assert.deepEqual(parseStatusMenuEvent(raw),{userId:user,fingerprint:'event:unique1',expiresAfter:60000});
 await f.click(raw);
 assert.equal(f.sent.length,1);
 assert.equal(f.sent[0].params.receive_id_type,'open_id');
 assert.equal(f.sent[0].data.receive_id,user);
 assert.equal(f.sent[0].data.msg_type,'interactive');
 assert.equal(JSON.parse(f.sent[0].data.content).schema,'2.0');
 await f.click(raw);assert.equal(f.sent.length,1,'duplicate id never sends twice');
});
test('other event keys, missing operator and unauthenticated owner do nothing',async()=>{
 const f=fixture({status:async()=>null});
 await f.click(event('model','a'));
 await f.click({event_key:'status',operator:{operator_id:{open_id:'other'}}});
 await f.click(event('status','b'));
 assert.equal(f.sent.length,0);
 assert.equal(parseStatusMenuEvent(event('model')),null);
});
test('menu fallback key suppresses only immediate repeated delivery and respects abort',async()=>{
 const f=fixture();
 const raw={event_key:'status',operator:{operator_id:{open_id:user}}};
 await f.click(raw);await f.click(raw);assert.equal(f.sent.length,1);
 f.controller.abort();
 await f.click(event('status','different'));assert.equal(f.sent.length,1);
});
test('send failure unlocks event for Feishu redelivery and logs only nonsecret codes',async()=>{
 const handlers={},errors=[];let calls=0;
 const channel={dispatcher:{register:r=>Object.assign(handlers,r)},rawClient:{im:{v1:{message:{create:async()=>{calls++;if(calls===1)throw Object.assign(Error('secret-message'),{code:429});return {code:0};}}}}}};
 installStatusMenu(channel,{onStatus:async()=>({card:{schema:'2.0'}}),signal:new AbortController().signal,state:message=>errors.push(message)});
 await handlers['application.bot.menu_v6'](event());
 await handlers['application.bot.menu_v6'](event());
 assert.equal(calls,2);assert.equal(errors.length,1);assert.match(errors[0],/429/);assert(!errors[0].includes('secret-message'));
});
test('runtime only exposes private menu status to its configured owner',async()=>{
 const runtime=Object.create(ChannelRuntime.prototype);runtime.closed=false;runtime.provider='feishu';
 let owner=user,attempts=0;
 const core={store:{owner:()=>owner?{userId:owner}:null},recentReplyAtForOwner:()=>12345,statusCenter:{feishuPersonalStatus:async(sessionId,viewer,at)=>{attempts++;assert.equal(sessionId,'');assert.equal(at,12345);assert.equal(viewer.provider,'feishu');return{card:{schema:'2.0'}};}}};
 runtime.core=core;const cfg={accountId:'default'},signal=new AbortController().signal;
 assert.equal((await runtime.menuStatus({userId:user,eventKey:'status'},cfg,signal)).card.schema,'2.0');
 assert.equal(attempts,1);
 assert.equal(await runtime.menuStatus({userId:'ou_other123456',eventKey:'status'},cfg,signal),null);
 owner=null;
 assert.equal(await runtime.menuStatus({userId:user,eventKey:'status'},cfg,signal),null);
 assert.equal(attempts,1);
});
