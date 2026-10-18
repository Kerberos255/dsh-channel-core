import test from 'node:test';
import assert from 'node:assert/strict';

test('news archive renders in empty native Session; switches to view after real turns, never creates messages',async()=>{
 let definition;
 const listeners=new Set(),registers=[],cleanups=[],views=[],remoteCalls=[];
 let snapshot={byId:{
  'session-news':{id:'session-news',blank:true,retainedBy:{mainView:1}},
  'session-other':{id:'session-other',blank:true,retainedBy:{mainView:0}}
 }};
 const originalWindow=globalThis.window,originalDocument=globalThis.document;
 globalThis.window={
  __ModuleLoader__:{load(value){definition=value}},
  addEventListener(){},removeEventListener(){}
 };
 globalThis.document={
  hidden:false,
  head:{appendChild(){},removeChild(){}},
  createElement(){return {textContent:'',remove(){}}}
 };
 try{
  await import('../lib/client.js?empty-news-session-ui='+Date.now());
  assert.equal(definition?.id,'dsh-channel-core');
  const React={createElement:(component,props)=>({component,props}),Fragment:Symbol('Fragment'),forwardRef:fn=>fn};
  const plugin=definition.factory(id=>{
   if(id==='react')return React;
   if(id==='@deepseek-ai/dsh-client-ui-primitives')return {Button:()=>null,Switch:()=>null};
   throw Error('unexpected require '+id);
  });
  const nativeStore={};
  const ctx={
   effect(fn){const stop=fn();if(typeof stop==='function')cleanups.push(stop);return stop},
   locale:{register:()=>()=>{}},
   remote:{},
   connection:{rpc:{async call(_path,method,args){
    remoteCalls.push(method);
    if(method==='channelCore/outboundSessions')return {ok:true,value:['session-news']};
    if(method==='channelCore/outboundRecords')return {ok:true,value:{records:[],hasMore:false}};
    throw Error('unexpected Remote: '+method);
   }}},
   sessions:{list:{getSnapshot:()=>snapshot,subscribe(cb){listeners.add(cb);return()=>listeners.delete(cb)}}},
   slots:{
    inject(slot,build){if(slot==='conversation.session')assert.equal(slot,'conversation.session');const stop=build();if(typeof stop==='function')cleanups.push(stop);return stop},
    register(spec,render){
     const entry={spec,render,disposed:false};registers.push(entry);return()=>{entry.disposed=true};
    },
    entries(name){return name==='conversation.session'?[{name,store:nativeStore}]:[]},
    resolveStore(store,id){assert.equal(store,nativeStore);return {actions:{setView(view){views.push({id,view})}}}}
   }
  };
  plugin.apply(ctx);
  await new Promise(resolve=>setTimeout(resolve,0));
  const archive=registers.find(row=>row.spec.name==='conversation.view'&&row.spec.id==='news-outbound-archive');
  const fallback=registers.find(row=>row.spec.name==='conversation.session'&&row.spec.priority===-10);
  assert(archive&&!archive.disposed);
  assert(fallback&&!fallback.disposed,'blank Session must have visible archive');
  assert.equal(fallback.render({sessionId:'fake'}).props.sessionId,'session-news');
  assert.deepEqual(views.at(-1),{id:'session-news',view:'news-outbound-archive'});

  snapshot={byId:{
   'session-news':{id:'session-news',blank:false,retainedBy:{mainView:1}},
   'session-other':{id:'session-other',blank:true,retainedBy:{mainView:0}}
  }};
  for(const cb of listeners)cb();
  assert(fallback.disposed,'blank renderer stops after real native turn');
  assert(registers.filter(row=>row.spec.name==='conversation.view'&&!row.disposed).length===1);
  snapshot={byId:{
   'session-news':{id:'session-news',blank:false,retainedBy:{mainView:0}},
   'session-other':{id:'session-other',blank:true,retainedBy:{mainView:1}}
  }};
  for(const cb of listeners)cb();
  assert(registers.filter(row=>row.spec.name==='conversation.view'&&!row.disposed).length===0,'other Sessions must not show archive');
  assert(!remoteCalls.some(method=>/send|prompt|append|create/i.test(method)),'UI must not send or create messages');
  for(const cleanup of cleanups.reverse())cleanup();
 }finally{
  if(originalWindow===undefined)delete globalThis.window;else globalThis.window=originalWindow;
  if(originalDocument===undefined)delete globalThis.document;else globalThis.document=originalDocument;
 }
});
