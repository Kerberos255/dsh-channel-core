import test from 'node:test';
import assert from 'node:assert/strict';
import ChannelCore from '../lib/index.js';

function fixture({owner=true,kind='dm',provider='feishu',viewer='baize-owner'}={}){
 const responses=[],scope={workspaceId:'default'},sessionId='s1';
 const core=Object.create(ChannelCore.prototype);
 core.closed=false;core.commandTasks=new Map();core.configFile={value:{defaultMode:'steering',sharedDM:true}};
 const message={provider,accountId:'bot',userId:viewer,conversationId:'chat',kind,text:'/status',messageId:'reply-1'};
 const route={receiptKey:'receipt',message,binding:{id:'binding',sessionId,scope},inboundMode:'steer'};
 core.router={route:()=>route};core.archivedRecovery={recover:async()=>route};
 core.store={owner:()=>owner?{userId:'baize-owner'}:null,db:{prepare:()=>({get:()=>({at:Date.now()-23000})})}};
 const used={personal:0,old:0};
 core.statusCenter={
  async feishuPersonalStatus(){used.personal++;return {text:'白泽状态',card:{schema:'2.0',body:{elements:[]}}};},
  async channelStatus(){used.old++;return 'old-status';}
 };
 core.bridge={store:{command:()=>({request:{origin:{...message,bindingId:'binding'},binding:route.binding,mode:'steer',create:{}}}),finishCommand:()=>{}},reply:(_origin,body)=>responses.push(body)};
 return {core,message,responses,used};
}
test('verified owner in Feishu DM receives personal status card instead of legacy text',async()=>{
 const f=fixture();
 await f.core.command(f.message,'status','');
 assert.equal(f.used.personal,1);assert.equal(f.used.old,0);
 assert.equal(f.responses.length,1);assert.equal(f.responses[0].feishuStatusCard.schema,'2.0');
 assert.equal(f.responses[0].text,'白泽状态');
});
test('Feishu group and non-owner DM cannot read private account balance',async()=>{
 for(const options of [{kind:'group'},{viewer:'stranger'},{owner:false}]){
  const f=fixture(options);await f.core.command(f.message,'status','');
  assert.equal(f.used.personal,0);
  assert.equal(f.responses[0].feishuStatusCard,undefined);
  assert.match(f.responses[0].text,/仅限已验证/);
 }
});
test('Discord /status remains the existing statusCenter response',async()=>{
 const f=fixture({provider:'discord'});await f.core.command(f.message,'status','');
 assert.equal(f.used.personal,0);assert.equal(f.used.old,1);
 assert.equal(f.responses[0].text,'old-status');assert.equal(f.responses[0].feishuStatusCard,undefined);
});
