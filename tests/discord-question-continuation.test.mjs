import test from 'node:test';
import assert from 'node:assert/strict';
import { createTransport } from '../channels/discord/transport.js';
import { afterPresentedContext } from '../channels/discord/question-context.js';

function fixture(behavior={}){
 const messages=new Map(),history=[],removed=[],handlers=new Map(),statusUpdates=[];
 let current=0;
 const channel={
  isTextBased:()=>true,
  sendTyping:async()=>{},
  send:async payload=>{
   const id='bot-'+(++current),row={id,content:payload.content,components:payload.components??[],deleted:false};
   messages.set(id,row);history.push({type:'send',id,content:row.content});
   return{id};
  },
  messages:{
   edit:async (id,payload)=>{const row=messages.get(id);assert(row&&!row.deleted);Object.assign(row,{content:payload.content,components:payload.components??[]});history.push({type:'edit',id,content:row.content});return{id};},
   delete:async id=>{const row=messages.get(id);assert(row);if(behavior.rejectDelete)throw Error('cannot-delete');row.deleted=true;removed.push(id);return{id};}
  }
 };
 class Client{
  user={id:'bot'};
  application={commands:{create:async()=>{}}};
  channels={fetch:async()=>channel};
  on(name,handler){handlers.set(name,handler);}
  off(name){handlers.delete(name);}
  async login(){return 'logged-in';}
  async destroy(){}
 }
 const sdk={Client,GatewayIntentBits:{Guilds:1,GuildMessages:2,DirectMessages:4,MessageContent:8},Partials:{Channel:0},Options:{cacheWithLimits:()=>({})}};
 const config={accountId:'bot-1',streaming:{mode:'progress',progress:{maxLines:4}},throttleMs:1,registerCommands:false};
 const origin={provider:'discord',accountId:'bot-1',conversationId:'private-dm',userId:'owner',messageId:'user-first',kind:'dm'};
 const controller=new AbortController();
 return{messages,history,removed,handlers,statusUpdates,config,origin,sdk,signal:controller.signal,async create(){return createTransport({
  config,credentials:['synthetic-bot-token'],signal:controller.signal,
  receive:async()=>{},state:(...entry)=>statusUpdates.push(entry),action:behavior.action??(async()=>{}),sessions:async()=>[],host:{}
 },sdk);},close:()=>controller.abort(),
 visible:()=>[...messages.values()].filter(x=>!x.deleted).map(x=>x.content)};
}
const status='completed';
const question={status:'waiting-user',text:'1/1 · 选择下一步\n\n文字回答：/answer <token> 你的回答',final:false};
test('exact previously published Ask User text is stripped, but mismatches are not',()=>{
 assert.equal(afterPresentedContext('第一段\n\n第二段','第一段'),'第二段');
 assert.equal(afterPresentedContext('第一段','第一段'),'');
 assert.equal(afterPresentedContext('第一段又不同','第一段'),'第一段又不同');
 assert.equal(afterPresentedContext('新文','旧文'),'新文');
 assert.equal(afterPresentedContext('全文',''),'全文');
});
test('Ask User retains pre-question history once and sends only continuation on final',async()=>{
 const f=fixture(),t=await f.create();try{
  await t.progress(f.origin,{status:'generating',text:'前面已经说完'});
  await t.question(f.origin,{...question,context:'前面已经说完'},[{label:'继续',token:'mock'}]);
  assert.equal(f.visible().filter(x=>x==='> 前面已经说完').length,1);
  await t.send(f.origin,{status,text:'前面已经说完\n\n回答之后的新内容',final:true});
  assert.equal(f.visible().filter(x=>x==='> 前面已经说完').length,1);
  assert(f.visible().includes('回答之后的新内容'));
  assert(!f.visible().some(x=>x.includes('前面已经说完\n\n回答之后')));
 }finally{await t.close();f.close();}
});
test('two questions publish each committed delta once, final emits only unseen tail',async()=>{
 const f=fixture(),t=await f.create();try{
  const first='第一次提问前的说明',second=first+'\n\n两次提问之间的新文字';
  await t.question(f.origin,{...question,context:first},[{label:'好',token:'x'}]);
  await t.question(f.origin,{...question,text:'2/2 · 第二个问题',context:second},[{label:'确认',token:'y'}]);
  await t.send(f.origin,{status,text:second+'\n\n最终处理完成',final:true});
  const visible=f.visible().join('\n');
  assert.equal(visible.split(first).length-1,1);
  assert.equal(visible.split('两次提问之间的新文字').length-1,1);
  assert.equal(visible.split('最终处理完成').length-1,1);
 }finally{await t.close();f.close();}
});


test('Discord Ask User quotes prelude without cloning its multi-select and sends no selection notices',async()=>{
 const calls=[],f=fixture({action:async args=>{
   calls.push(args);
   return args.token==='submit'?{accepted:true,completed:true}:{accepted:true,completed:false,selectedCount:args.values.length};
 }}),t=await f.create();
 try{
  const ui={multi:true,options:[{label:'方案 A',value:'0'},{label:'方案 B',value:'1'}],
    selectToken:'select',submitToken:'submit',customToken:'custom'};
  const origin=f.origin;
  const prelude='这是 Ask User 之前已经展示的前文';
  await t.progress(origin,{status:'generating',text:'正在处理'});
  const result=await t.question(origin,{...question,context:prelude,ui},[]);
  const history=[...f.messages.values()].filter(m=>!m.deleted);
  assert.equal(history.filter(m=>m.components.length>0).length,1,
    'only real question is interactive; quoted history must not expose duplicate form');
  const frozen=history.find(m=>m.content.includes('> '+prelude));
  assert(frozen);
  assert.deepEqual(frozen.components,[]);
  const asked=f.messages.get(result.messageId);
  assert.equal(asked.components[0].components[0].type,3);
  assert.equal(asked.components[1].components[0].label,'确认选择');
  let notifications=0;
  const click=values=>({
    isAutocomplete:()=>false,isChatInputCommand:()=>false,isMessageComponent:()=>true,
    customId:'dsh:select',user:{id:origin.userId},channelId:origin.conversationId,
    channel:{isThread:()=>false},message:{id:result.messageId},values,
    deferUpdate:async()=>{},followUp:async()=>{notifications++;}
  });
  const count=history.length,oldEdits=f.history.filter(h=>h.type==='edit').length;
  await f.handlers.get('interactionCreate')(click(['0']));
  await f.handlers.get('interactionCreate')(click(['0','1']));
  assert.deepEqual(calls.map(c=>c.values),[['0'],['0','1']]);
  assert.equal(notifications,0,'selection is silently acknowledged, no ephemeral spam');
  assert.equal([...f.messages.values()].length,count,'selection cannot create another Ask User card');
  assert.equal(f.history.filter(h=>h.type==='edit').length,oldEdits,'selection must not redraw a second question');
  await f.handlers.get('interactionCreate')({...click([]),customId:'dsh:submit'});
  assert.deepEqual(f.removed,[]);
  assert(!frozen.deleted,'frozen context remains in history');
 }finally{await t.close();f.close();}
});

test('Discord native multi-select waits for explicit confirm and does not edit card on choosing',async()=>{
 const calls=[],f=fixture({action:async arg=>{calls.push(arg);return arg.token==='submit'?{accepted:true,completed:true}:{accepted:true,completed:false,selectedCount:2};}});
 const t=await f.create();try{
  const ui={multi:true,options:[{label:'甲',value:'0'},{label:'乙',value:'1'}],selectToken:'select',submitToken:'submit',customToken:'custom'};
  const asked=await t.question(f.origin,{...question,ui},[]);
  const initial=f.messages.get(asked.messageId);
  assert.equal(initial.components[0].components[0].type,3);
  assert.equal(initial.components[0].components[0].max_values,2);
  assert.equal(initial.components[1].components[0].label,'确认选择');
  assert.equal(initial.components[1].components[1].custom_id,'dsh-custom:custom');
  const click={isAutocomplete:()=>false,isChatInputCommand:()=>false,isMessageComponent:()=>true,
    customId:'dsh:select',user:{id:f.origin.userId},channelId:f.origin.conversationId,
    channel:{isThread:()=>false},message:{id:asked.messageId},values:['0','1'],
    deferUpdate:async()=>{},followUp:async()=>{}};
  await f.handlers.get('interactionCreate')(click);
  assert.equal(calls.length,1);
  assert.deepEqual(calls[0].values,['0','1']);
  assert.equal(f.history.filter(x=>x.type==='edit').length,0,'selecting must not regenerate or patch question');
  await f.handlers.get('interactionCreate')({...click,customId:'dsh:submit',values:[]});
  assert.equal(calls[1].token,'submit');
  assert.deepEqual(f.removed,[]);
 }finally{await t.close();f.close();}
});

test('Discord custom-answer button opens a modal and submits scoped freeform content',async()=>{
 const calls=[],f=fixture({action:async arg=>{calls.push(arg);return {accepted:true,completed:true};}}),t=await f.create();
 try{
  const asked=await t.question(f.origin,{...question,ui:{multi:false,options:[],customToken:'custom-1'}},[
    {label:'甲',token:'opt-1'},{label:'✍️ 自定义回答',token:'custom-1',custom:true}
  ]);
  let modal;
  await f.handlers.get('interactionCreate')({
    isAutocomplete:()=>false,isChatInputCommand:()=>false,isMessageComponent:()=>true,isModalSubmit:()=>false,
    customId:'dsh-custom:custom-1',user:{id:f.origin.userId},channelId:f.origin.conversationId,
    channel:{isThread:()=>false},message:{id:asked.messageId},showModal:async data=>{modal=data;}
  });
  assert.equal(modal.custom_id,'dsh-modal:custom-1');
  assert.equal(modal.components[0].type,18,'modal input is wrapped in a native Discord Label');
  assert.equal(modal.components[0].label,'请输入你希望的回答');
  assert.equal(modal.components[0].component.type,4);
  assert.equal(modal.components[0].component.custom_id,'answer');
  // The source tree can run tests without node_modules; where the Discord.js
  // dependency is installed, also validate against its real modal builder.
  let discord;
  try{discord=await import('discord.js');}
  catch(error){if(error?.code!=='ERR_MODULE_NOT_FOUND')throw error;}
  if(discord)assert.deepEqual(new discord.ModalBuilder(modal).toJSON(),modal);
  let received;
  await f.handlers.get('interactionCreate')({
    isAutocomplete:()=>false,isChatInputCommand:()=>false,isModalSubmit:()=>true,
    customId:'dsh-modal:custom-1',user:{id:f.origin.userId},channelId:f.origin.conversationId,
    channel:{isThread:()=>false},fields:{getTextInputValue:()=> '我有其他方案'},
    deferReply:async()=>{},editReply:async data=>{received=data.content;}
  });
  assert.equal(calls.length,1);
  assert.equal(calls[0].customText,'我有其他方案');
  assert.equal(received,'回答已提交。');
  assert.deepEqual(f.removed,[]);
 }finally{await t.close();f.close();}
});

test('Discord modal API errors are reported without leaking tokens, and can be retried',async()=>{
 const f=fixture(),t=await f.create();
 try{
  const asked=await t.question(f.origin,{...question,ui:{multi:false,customToken:'safe-test-token'}},
    [{label:'✍️ 自定义回答',token:'safe-test-token',custom:true}]);
  const handler=f.handlers.get('interactionCreate');
  let replied,attempt=0;
  const interaction=()=>({
    isAutocomplete:()=>false,isChatInputCommand:()=>false,isMessageComponent:()=>true,
    isModalSubmit:()=>false,customId:'dsh-custom:safe-test-token',
    user:{id:f.origin.userId},channelId:f.origin.conversationId,
    channel:{isThread:()=>false},message:{id:asked.messageId},
    showModal:async()=>{if(++attempt===1)throw Object.assign(new Error('invalid-form'),{code:50035});},
    reply:async body=>{replied=body.content;}
  });
  await handler(interaction());
  assert.equal(attempt,1);
  assert.match(replied,/50035/);
  assert(f.statusUpdates.some(row=>row[0]==='Discord 交互处理失败：50035'));
  assert(!JSON.stringify(f.statusUpdates).includes('safe-test-token'));
  replied=undefined;
  await handler(interaction());
  assert.equal(attempt,2,'a failed modal may be reopened');
  assert.equal(replied,undefined);
 }finally{await t.close();f.close();}
});

test('Discord answered question buttons disappear after accepted final selection only',async()=>{
 let completed=false;
 const f=fixture({action:async()=>({accepted:true,completed})});
 f.config.streaming.progress={commentary:true,narration:false,toolProgress:true,toolDetail:true,maxLines:4,maxLineChars:240,draftMaxChars:600};
 const t=await f.create();
 try{
  const asked=await t.question(f.origin,{...question,status:'waiting-user'},[{label:'继续',token:'only-option'}]);
  const click=()=>({isAutocomplete:()=>false,isChatInputCommand:()=>false,isMessageComponent:()=>true,
    customId:'dsh:only-option',user:{id:f.origin.userId},channelId:f.origin.conversationId,
    channel:{isThread:()=>false},message:{id:asked.messageId},values:[],
    deferUpdate:async()=>{}});
  const onClick=f.handlers.get('interactionCreate');
  assert.equal(typeof onClick,'function');
  await onClick(click());
  assert.equal(f.removed.length,0,'an incomplete selection must keep its buttons');
  completed=true;
  await onClick(click());
  assert.deepEqual(f.removed,[]);
  await t.progress(f.origin,{status:'thinking',activity:{timeline:[{type:'public-draft',text:'继续后新增内容'}]}});
  assert(f.visible().at(-1).includes('继续后新增内容'));
  assert.equal(f.messages.get(asked.messageId).deleted,false);
 }finally{await t.close();f.close();}
});

test('Discord accepted question becomes noninteractive when Discord rejects deletion',async()=>{
 const f=fixture({action:async()=>({accepted:true,completed:true}),rejectDelete:true}),t=await f.create();
 try{
  const sent=await t.question(f.origin,{...question},[{label:'继续',token:'choice'}]);
  await f.handlers.get('interactionCreate')({
    isAutocomplete:()=>false,isChatInputCommand:()=>false,isMessageComponent:()=>true,
    customId:'dsh:choice',user:{id:f.origin.userId},channelId:f.origin.conversationId,
    channel:{isThread:()=>false},message:{id:sent.messageId},values:[],deferUpdate:async()=>{}
  });
  const row=f.messages.get(sent.messageId);
  assert.equal(row.content,'✅ 已回答');
  assert.deepEqual(row.components,[]);
  assert.deepEqual(f.removed,[]);
 }finally{await t.close();f.close();}
});

test('Discord completed Ask User retains question and selected answers while agent resumes',async()=>{
 const f=fixture({action:async()=>({accepted:true,completed:true,
  answered:[{question:'今天处理哪些任务？',selected:['同步公开版','检查部署'],custom:'先不要重启'}]})}),t=await f.create();
 try{
  const ui={multi:true,options:[{label:'同步公开版',value:'0'},{label:'检查部署',value:'1'}],
   selectToken:'select',submitToken:'submit',customToken:'custom'};
  const asked=await t.question(f.origin,{...question,ui},[]);
  await f.handlers.get('interactionCreate')({
   isAutocomplete:()=>false,isChatInputCommand:()=>false,isMessageComponent:()=>true,
   customId:'dsh:submit',user:{id:f.origin.userId},channelId:f.origin.conversationId,
   channel:{isThread:()=>false},message:{id:asked.messageId},values:[],deferUpdate:async()=>{}
  });
  const previous=f.messages.get(asked.messageId);
  assert(previous.content.includes('问题：今天处理哪些任务？'));
  assert(previous.content.includes('已选：同步公开版、检查部署'));
  assert(previous.content.includes('补充回答：先不要重启'));
  assert.deepEqual(previous.components,[]);
  assert.equal(previous.deleted,false);
  assert.deepEqual(f.removed,[]);
  const completedText=previous.content;
  await t.progress(f.origin,{status:'thinking',text:'正在处理',activity:{timeline:[]}});
  assert.equal(f.messages.get(asked.messageId).content,completedText,
    'new agent progress must not overwrite the completed question');
  await t.send(f.origin,{status:'completed',text:'下一步已安排',final:true});
  assert(f.visible().includes('下一步已安排'));
  assert(f.visible().some(v=>v.includes('已选：同步公开版、检查部署')));
 }finally{await t.close();f.close();}
});

test('steer after Ask User uses first-origin context to trim final sent to latest input',async()=>{
 const f=fixture(),t=await f.create();try{
  await t.question(f.origin,{...question,context:'前文已显示'},[{label:'继续',token:'x'}]);
  const latest={...f.origin,messageId:'user-steer'};
  await t.send(latest,{status,progressOriginMessageId:f.origin.messageId,text:'前文已显示\n\n只发送新的结论',final:true});
  assert(f.visible().includes('> 前文已显示'));
  assert(f.visible().includes('只发送新的结论'));
  assert(!f.visible().some(x=>x.includes('前文已显示\n\n只发送新的结论')));
  assert.equal(f.removed.length,1,'the old Ask User question is retired, not the preserved prefix');
 }finally{await t.close();f.close();}
});
test('without prior Ask User a final remains unchanged; exact-context final does not repeat it',async()=>{
 const f=fixture(),t=await f.create();try{
  await t.send(f.origin,{status,text:'正常最终回复',final:true});
  assert(f.visible().includes('正常最终回复'));
  const later={...f.origin,messageId:'user-second'};
  await t.question(later,{...question,context:'已告知全部信息'},[{label:'好',token:'x'}]);
  await t.send(later,{status,text:'已告知全部信息',final:true});
  assert.equal(f.visible().filter(x=>x==='> 已告知全部信息').length,1);
  assert(f.visible().includes('本轮已完成。'));
 }finally{await t.close();f.close();}
});
