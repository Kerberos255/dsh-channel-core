import test from 'node:test';
import assert from 'node:assert/strict';
import { CoreStore } from '../lib/store.js';
import { ChannelBridge } from '../lib/bridge.js';
import { DeliveryStore } from '../lib/delivery-store.js';
import { ChannelRuntime,allowed,channelScope } from '../lib/channel-runtime.js';

function fixture(){
  const store=new CoreStore(':memory:'),events=new Map();
  const ctx={on(name,fn){events.set(name,fn);return ()=>events.delete(name);}};
  const bridge=new ChannelBridge(ctx,{store}),session={id:'test-session'},agent={session};
  const origin={provider:'feishu',accountId:'test',conversationId:'chat-a',userId:'user-a',messageId:'input-a'};
  store.claim({key:'input-a',requestId:'input-a',sessionId:session.id,origin,payload:'a'});
  bridge.claimed(session,'input-a',1);
  const sent=[],questions=[],progress=[];
  const unregister=bridge.register('feishu','test',{throttleMs:1,progress:async(from,body)=>progress.push({from,body}),send:async(from,body)=>{sent.push({from,body});return {messageId:'output-a'};},question:async(from,body,actions)=>{questions.push({from,body,actions});return {messageId:'question-a'};}});
  return {store,bridge,ctx,events,session,agent,origin,sent,questions,progress,unregister,async close(){await bridge.close();store.close();}};
}
const flushProgress=async f=>{await new Promise(done=>setTimeout(done,12));await f.bridge.idle();};

test('native tool events publish running and settled snapshots without tool arguments',async()=>{
 const f=fixture();try{
  let finish;const execution=f.events.get('tools/execute')({agent:f.agent,callId:'read-1',name:'read_file',arguments:{secret:'PRIVATE-ARGUMENT'}},()=>new Promise(resolve=>finish=resolve));
  await flushProgress(f);const running=f.progress.at(-1).body;
  assert.equal(running.status,'tool-running');assert.deepEqual(running.activity.tools,[{name:'read_file',status:'running',detail:''}]);
  finish({isError:false,content:[]});await execution;await flushProgress(f);
  assert.equal(f.progress.at(-1).body.activity.tools[0].status,'completed');assert.equal(running.activity.tools[0].status,'running');
  assert(!JSON.stringify(f.progress).includes('PRIVATE-ARGUMENT'));
 }finally{await f.close();}
});

test('progress history is bounded, reports failures and ignores completion after native Stop',async()=>{
 const f=fixture();try{
  const execute=f.events.get('tools/execute');
  for(let i=0;i<25;i++)await execute({agent:f.agent,callId:String(i),name:'tool-'+i},async()=>({isError:i===24,content:[]}));
  await flushProgress(f);const history=f.progress.at(-1).body.activity.tools;
  assert.equal(history.length,20);assert.equal(history[0].name,'tool-5');assert.equal(history.at(-1).status,'failed');
  await assert.rejects(execute({agent:f.agent,callId:'throws',name:'exec'},async()=>{throw new Error('PRIVATE-FAILURE');}));
  await flushProgress(f);assert.equal(f.progress.at(-1).body.activity.tools.at(-1).status,'failed');assert(!JSON.stringify(f.progress).includes('PRIVATE-FAILURE'));
  let finish;const pending=execute({agent:f.agent,callId:'late',name:'exec'},()=>new Promise(resolve=>finish=resolve));
  await flushProgress(f);const count=f.progress.length;
  f.bridge.event(f.session,{type:'turn/end',data:{turn:1,reason:{kind:'aborted'}}});await f.bridge.idle();
  finish({isError:false,content:[]});await pending;await flushProgress(f);
  assert.equal(f.progress.length,count);assert.equal(f.sent.length,1);assert.equal(f.sent[0].body.status,'cancelled');
 }finally{await f.close();}
});

test('progress commentary stays public while reasoning is kept as a separate narration tail',async()=>{
 const f=fixture();try{
  f.bridge.event(f.session,{type:'assistant/message',data:{turn:1,message:{content:[{type:'reasoning',text:'PRIVATE-REASONING'},{type:'text',text:'我来检查文件。'},{type:'tool-call',name:'read_file'}]}}});
  await flushProgress(f);assert.equal(f.progress.at(-1).body.activity.commentary,'我来检查文件。');
  assert.equal(f.progress.at(-1).body.activity.narration,'PRIVATE-REASONING');
  f.bridge.stream(f.session,{type:'start',turn:1,attemptId:'draft',revision:1});
  for(const [index,chunk] of [{type:'block-start',index:0,blockType:'reasoning'},{type:'reasoning-delta',index:0,text:'PRIVATE-STREAM'},{type:'block-start',index:1,blockType:'text'},{type:'text-delta',index:1,text:'尚未提交的正文'}].entries())f.bridge.stream(f.session,{type:'chunk',attemptId:'draft',revision:1,index,chunk});
  await flushProgress(f);assert.equal(f.progress.at(-1).body.activity.commentary,'我来检查文件。');
  assert.equal(f.progress.at(-1).body.activity.narration,'PRIVATE-REASONINGPRIVATE-STREAM');
  // Reasoning never joins the public text or the commentary field.
  assert(!JSON.stringify(f.progress.map(item=>[item.body.text,item.body.activity.commentary])).includes('PRIVATE-'));
 }finally{await f.close();}
});
test('tool detail summarizes the target and masks credential-looking arguments',async()=>{
 const f=fixture();try{
  const execute=f.events.get('tools/execute');
  await execute({agent:f.agent,callId:'read-9',name:'read_file',arguments:{path:'example-workspace/DESIGN.md'}},async()=>({isError:false,content:[]}));
  await execute({agent:f.agent,callId:'exec-9',name:'pwsh',arguments:{command:'npm pack --token=SUPERSECRETVALUE'}},async()=>({isError:false,content:[]}));
  await flushProgress(f);const tools=f.progress.at(-1).body.activity.tools;
  assert.equal(tools.at(-2).detail,'DESIGN.md');
  assert.equal(tools.at(-1).detail,'npm pack --token=***');
  assert(!JSON.stringify(f.progress).includes('SUPERSECRETVALUE'));
  assert(!JSON.stringify(f.progress).includes('deepseek-harness'));
 }finally{await f.close();}
});
test('native frames keep abandoned drafts out of the final text and freeze one delivery',async()=>{
  const f=fixture();
  f.bridge.stream(f.session,{type:'start',turn:1,attemptId:'first',revision:0});
  for(const [index,chunk] of [{type:'block-start',index:0,blockType:'reasoning'},{type:'reasoning-delta',index:0,text:'PRIVATE'},{type:'block-start',index:1,blockType:'text'},{type:'text-delta',index:1,text:'draft'}].entries())f.bridge.stream(f.session,{type:'chunk',attemptId:'first',revision:0,index,chunk});
  f.bridge.stream(f.session,{type:'end',attemptId:'first',revision:0,outcome:{kind:'abandoned'}});
  f.bridge.event(f.session,{type:'assistant/message',data:{turn:1,message:{content:[{type:'reasoning',text:'PRIVATE'},{type:'text',text:'完成答复'}]}}});
  f.bridge.event(f.session,{type:'turn/end',data:{turn:1,reason:{kind:'completed'}}});
  await f.bridge.idle();assert.equal(f.sent.length,1);assert.equal(f.sent[0].body.text,'完成答复');assert(!JSON.stringify(f.sent[0].body).includes('PRIVATE'));
  f.bridge.event(f.session,{type:'turn/end',data:{turn:1,reason:{kind:'completed'}}});
  await f.bridge.idle();assert.equal(f.sent.length,1);await f.close();
});
test('reconnection drains every pending batch, including more than 256 offline replies',async()=>{
 const f=fixture();await f.unregister();for(let i=0;i<300;i++)f.bridge.store.enqueue('offline-'+i,f.origin,{text:'reply '+i});
 const close=f.bridge.register('feishu','test',{send:async(origin,body)=>{f.sent.push({origin,body});return {messageId:'remote-'+f.sent.length};}});await f.bridge.idle();assert.equal(f.sent.length,300);assert.equal(f.bridge.store.pending('feishu','test').length,0);await close();await f.close();
});
test('stream gaps never leak incomplete drafts; cancellation uses native terminal vocabulary',async()=>{
  const f=fixture();f.bridge.stream(f.session,{type:'start',turn:1,attemptId:'a',revision:1});
  f.bridge.stream(f.session,{type:'chunk',attemptId:'a',revision:1,index:1,chunk:{type:'text-delta',index:0,text:'lost'}});
  f.bridge.event(f.session,{type:'turn/end',data:{turn:1,reason:{kind:'aborted'}}});await f.bridge.idle();
  assert.equal(f.sent[0].body.status,'cancelled');assert.equal(f.sent[0].body.text,'本轮已停止。');await f.close();
});
test('unrelated native step events cannot recreate a closed turn or capture a later input',async()=>{
  const f=fixture();f.bridge.event(f.session,{type:'turn/end',data:{turn:1,reason:{kind:'completed'}}});await f.bridge.idle();
  f.bridge.event(f.session,{type:'step/end',data:{turn:1}});f.bridge.event(f.session,{type:'user/message',data:{source:{rpcId:'next-input'}}});assert.equal(f.bridge.turns.size,0);await f.close();
});
test('delivery state survives restart without blindly resending ambiguous requests',async()=>{
  const f=fixture(),row=f.bridge.store.enqueue('ambiguous',f.origin,{text:'once'});
  assert(f.bridge.store.claim(row.id));new DeliveryStore(f.store.db);
  assert.equal(f.bridge.store.get(row.id).state,'uncertain');assert.equal(f.bridge.store.pending('feishu','test').length,0);await f.close();
});
test('question tokens bind actor and channel, handle multi-select, expire after first settlement',async()=>{
  const f=fixture();const promise=f.bridge.interactions.request({agent:f.agent,questions:[{id:'q',question:'选哪些？',multiSelect:true,options:[{label:'甲'},{label:'乙'}]}]},()=>assert.fail('unexpected fallback'));
  await f.bridge.idle();let actions=f.questions.at(-1).actions;
  await assert.rejects(f.bridge.answer({...f.origin,userId:'attacker',token:actions[0].token}),/actor-mismatch/);
  await f.bridge.answer({...f.origin,token:actions[0].token});await f.bridge.idle();
  await assert.rejects(f.bridge.answer({...f.origin,token:actions[0].token}),/stale/);
  actions=f.questions.at(-1).actions;await f.bridge.answer({...f.origin,token:actions.at(-1).token});
  assert.deepEqual(await promise,{answers:[{id:'q',selected:['甲']}]});assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM interactions').get().n,0);await f.close();
});
test('abort invalidates approval capabilities; only original actor can grant once',async()=>{
  const f=fixture(),abort=new AbortController();let promise=f.bridge.interactions.request({agent:f.agent,toolName:'exec',reason:'运行测试',signal:abort.signal},()=>assert.fail(),'approval');
  await f.bridge.idle();const token=f.questions.at(-1).actions[0].token;abort.abort();assert.equal(await promise,'cancelled');
  await assert.rejects(f.bridge.answer({...f.origin,token}),/stale/);
  promise=f.bridge.interactions.request({agent:f.agent,toolName:'exec',reason:'运行测试'},()=>assert.fail(),'approval');await f.bridge.idle();
  await f.bridge.answer({...f.origin,token:f.questions.at(-1).actions[0].token});assert.equal(await promise,'allowed-once');await f.close();
});
test('custom answers require explicit token syntax and cover multiple questions',async()=>{
  const f=fixture();const promise=f.bridge.interactions.request({agent:f.agent,questions:[{id:'a',question:'填文字'},{id:'b',question:'再填文字'}]},()=>assert.fail());
  await f.bridge.idle();let token=f.questions.at(-1).body.text.match(/\/answer ([\w-]+)/)[1];
  await f.bridge.answerText(f.origin,token+' 第一答');await f.bridge.idle();token=f.questions.at(-1).body.text.match(/\/answer ([\w-]+)/)[1];
  await f.bridge.answerText(f.origin,token+' 第二答');assert.deepEqual((await promise).answers.map(answer=>answer.custom),['第一答','第二答']);await f.close();
});

test('questions carry committed public prelude through every selection without private drafts',async()=>{
 const f=fixture();try{
  f.bridge.event(f.session,{type:'assistant/message',data:{turn:1,message:{content:[{type:'think',text:'PRIVATE-REASONING'},{type:'text',text:'已经找到了两个可行方案。'},{type:'tool-call',name:'user_questions',arguments:{private:'PRIVATE-ARGUMENT'}}]}}});
  f.bridge.stream(f.session,{type:'start',turn:1,attemptId:'unfinished',revision:1});
  for(const [index,chunk] of [{type:'block-start',index:0,blockType:'text'},{type:'text-delta',index:0,text:'UNCOMMITTED-DRAFT'}].entries())f.bridge.stream(f.session,{type:'chunk',attemptId:'unfinished',revision:1,index,chunk});
  const promise=f.bridge.interactions.request({agent:f.agent,questions:[{id:'a',question:'选哪些？',multiSelect:true,options:[{label:'甲'},{label:'乙'}]},{id:'b',question:'是否继续？',options:[{label:'继续'}]}]},()=>assert.fail());
  await f.bridge.idle();let question=f.questions.at(-1);
  assert.equal(question.body.context,'已经找到了两个可行方案。');
  assert(!JSON.stringify(question.body).includes('PRIVATE'));assert(!JSON.stringify(question.body).includes('UNCOMMITTED'));
  await f.bridge.answer({...f.origin,token:question.actions[0].token});await f.bridge.idle();question=f.questions.at(-1);
  assert.equal(question.body.context,'已经找到了两个可行方案。');
  await f.bridge.answer({...f.origin,token:question.actions.at(-1).token});await f.bridge.idle();question=f.questions.at(-1);
  assert.equal(question.body.context,'已经找到了两个可行方案。');assert(question.body.text.includes('是否继续？'));
  await f.bridge.answer({...f.origin,token:question.actions[0].token});assert.equal((await promise).answers.length,2);
 }finally{await f.close();}
});
test('feishu callbacks without thread field need the exact delivered card identity',async()=>{
  const f=fixture();f.store.db.prepare('UPDATE channel_turn_origins SET origin=?').run(JSON.stringify({...f.origin,threadId:'thread-a'}));
  const promise=f.bridge.interactions.request({agent:f.agent,questions:[{id:'q',question:'确认',options:[{label:'是'}]}]},()=>assert.fail());await f.bridge.idle();
  const token=f.questions.at(-1).actions[0].token;
  await assert.rejects(f.bridge.answer({...f.origin,token,messageId:'wrong-card'}),/actor-mismatch/);
  await f.bridge.answer({...f.origin,token,messageId:'question-a'});assert.equal((await promise).answers[0].selected[0],'是');await f.close();
});
test('unrelated web questions fall through; disconnected channel requests release native waits',async()=>{
  const f=fixture();assert.equal(f.bridge.interactions.request({agent:{session:{id:'web'}},questions:[]},()=>42),42);
  const promise=f.bridge.interactions.request({agent:f.agent,toolName:'read'},()=>assert.fail(),'approval');await f.bridge.idle();await f.unregister();assert.equal(await promise,'unavailable');await f.close();
});
test('removed identity links stop future cross-channel sharing',()=>{
  const store=new CoreStore(':memory:'),alias={provider:'feishu',accountId:'test',userId:'a'};
  store.syncAliases('feishu','test',[{userId:'a',identityId:'shared'}]);assert.equal(store.identity(alias),'shared');
  store.syncAliases('feishu','test',[]);assert.notEqual(store.identity(alias),'shared');store.close();
});
test('channel gates and namespaces isolate groups, actors, presets and workspaces',()=>{
  const config={allowedUsers:['a'],allowGroups:true,allowedGroups:['g'],requireMention:true,workspacePath:'/example/default-workspace',agentPreset:'agent',memoryNamespace:'private'};
  assert(allowed({userId:'a',kind:'dm'},config));assert(!allowed({userId:'a',kind:'group',conversationId:'g'},config));assert(!allowed({userId:'b',kind:'dm'},config));
  assert(allowed({userId:'a',kind:'thread',conversationId:'g',mentionedBot:true},config));
  assert.notEqual(channelScope(config).workspaceId,channelScope({...config,workspacePath:'/example/another'}).workspaceId);
});
test('runtime saves reconnect once, clears old listeners and contains credential errors',async()=>{
  const callbacks=new Set(),events=new Map(),transports=[],registrations=[];
  const config={enabled:true,allowedUsers:['a'],accountId:'test',identityLinks:[],appId:'cli-fixture'};
  const settings={configFile:{value:config,subscribe(fn){callbacks.add(fn);return ()=>callbacks.delete(fn);}}};
  const ctx={credentials:{async resolve(){return {value:'fixture'};}},channelCore:{resolveWorkspace:async()=> '/example/fixture-workspace',store:{syncAliases(){}},bridge:{register(){registrations.push(1);return ()=>{registrations.pop();};}}},on(name,fn){events.set(name,fn);return ()=>events.delete(name);}};
  const runtime=new ChannelRuntime(ctx,settings,{provider:'feishu',credentialRefs:()=>['FEISHU_APP_SECRET'],createTransport:async({signal})=>{const item={signal,started:0,closed:0,start(){item.started++;},close(){item.closed++;return Promise.resolve();}};transports.push(item);return item;}});
  await runtime.reconfigure();assert(runtime.details().connected);await runtime.reconfigure();assert.equal(registrations.length,1);assert(transports[0].signal.aborted);
  await runtime.close();assert.equal(registrations.length,0);assert.equal(callbacks.size,0);assert.equal(events.size,0);
  const broken=new ChannelRuntime({...ctx,credentials:{resolve(){throw new Error('private secret must never appear');}}},settings,{provider:'feishu',credentialRefs:()=>['FEISHU_APP_SECRET'],createTransport:()=>assert.fail()});await broken.reconfigure();assert(!broken.details().message.includes('private secret'));await broken.close();
});
