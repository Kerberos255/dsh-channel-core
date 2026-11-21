import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function harness(){
 const slots=[],deps=[],effects=[];
 let cursor=0;
 const React={
  createElement:(type,props,...children)=>({type,props:props??{},children}),
  useSyncExternalStore:(subscribe,get)=>{cursor++;return get();},
  useState(initial){
   const index=cursor++;
   if(!(index in slots))slots[index]=typeof initial==='function'?initial():initial;
   return [slots[index],next=>{slots[index]=typeof next==='function'?next(slots[index]):next;}];
  },
  useRef(initial){const index=cursor++;if(!(index in slots))slots[index]={current:initial};return slots[index];},
  useEffect(fn,next){
   const index=cursor++;
   const previous=deps[index];
   if(!previous||next.some((value,i)=>value!==previous[i])){deps[index]=next;effects.push(fn);}
  },
 };
 const source=fs.readFileSync(new URL('../tools/settings/settings-client.inc.js',import.meta.url),'utf8');
 const noop=()=>{};
 const context={React,require:()=>({Switch:function Switch(){},Button:function Button(){}}),
   structuredClone,AbortController,window:{addEventListener:noop,removeEventListener:noop},
   document:{visibilityState:'visible'},setTimeout,clearTimeout,setInterval,clearInterval,console};
 const FileConfigPage=vm.runInNewContext(source+'\n;FileConfigPage',context);
 let snapshot={status:'ready',revision:'rev-1',writable:true,details:{},value:{
   allowedUsers:['owner'],throttleMs:750,flag:false,first:2,second:3,
 }};
 const scope={getSnapshot:()=>snapshot,subscribe:()=>noop,reload:async()=>snapshot};
 function render(fields){
  cursor=0;effects.length=0;
  const tree=FileConfigPage({scope,fields,title:'test',description:'test',credentialsFirst:false});
  for(const effect of effects)effect();
  return tree;
 }
 const walk=(node,predicate)=>{
  if(node===null||node===undefined||typeof node!=='object')return null;
  if(Array.isArray(node)){for(const child of node){const result=walk(child,predicate);if(result)return result;}return null;}
  if(predicate(node))return node;
  return walk(node.children,predicate);
 };
 return {render,walk,setSnapshot:next=>{snapshot=next;},getSnapshot:()=>snapshot};
}

test('Discord and Feishu shared settings keep list whitespace and number drafts across polling',()=>{
 for(const provider of ['discord','feishu']){
  const h=harness(),fields=[
   {key:'allowedUsers',group:'接收与权限',label:'允许的用户',type:'list'},
   {key:'throttleMs',group:'回复与显示',label:'刷新间隔',type:'number',min:400,max:5000,fold:'更多显示设置'},
  ];
  h.render(fields); // Mounts the editor from its initial ready snapshot.
  let tree=h.render(fields);
  const list=()=>h.walk(tree,n=>n.type==='textarea'&&n.props.id==='dsh-config-allowedUsers');
  const number=()=>h.walk(tree,n=>n.type==='input'&&n.props.id==='dsh-config-throttleMs');
  assert.equal(list().props.value,'owner');
  list().props.onChange({target:{value:'owner\n'}});
  tree=h.render(fields);
  assert.equal(list().props.value,'owner\n');
  h.setSnapshot({...h.getSnapshot(),details:{}});
  tree=h.render(fields);
  tree=h.render(fields);
  assert.equal(list().props.value,'owner\n',provider+' polling must not delete a trailing newline');
  number().props.onChange({target:{value:''}});
  tree=h.render(fields);
  assert.equal(number().props.value,'',provider+' number can be temporarily empty');
  number().props.onChange({target:{value:'1000'}});
  tree=h.render(fields);
  assert.equal(number().props.value,'1000',provider+' can type a new number');

  const fold=h.walk(tree,n=>n.type==='details'&&n.props.className==='dpc-fold');
  assert.equal(fold.props.key,'fold-回复与显示-更多显示设置');
  const item={tagName:'DETAILS',open:false,parentElement:null};
  tree.props.onInvalidCapture({target:{parentElement:item}});
  assert.equal(item.open,true,provider+' validation should expand the closed details');
 }
});

test('fold identity is stable when its first conditional field becomes visible',()=>{
 const h=harness(),fields=[
  {key:'flag',label:'show first',type:'boolean',group:'回复与显示'},
  {key:'first',label:'first',type:'number',when:{flag:true},fold:'更多显示设置',group:'回复与显示'},
  {key:'second',label:'second',type:'number',fold:'更多显示设置',group:'回复与显示'},
 ];
 h.render(fields);
 let tree=h.render(fields);
 const fold=()=>h.walk(tree,n=>n.type==='details'&&n.props.className==='dpc-fold');
 const before=fold().props.key;
 const toggle=h.walk(tree,n=>typeof n.type==='function'&&n.props.label==='show first');
 assert(toggle);
 toggle.props.onChange(true);
 tree=h.render(fields);
 assert.equal(fold().props.key,before);
 assert.equal(fold().children.length,3,'conditional field is added without replacing the fold');
});

test('both channel pages have one display fold and conditional attachment limit',()=>{
 const pages=JSON.parse(fs.readFileSync(new URL('../tools/settings/pages.json',import.meta.url),'utf8'));
 for(const name of ['dsh-channel-discord','dsh-channel-feishu']){
  const fields=pages[name].fields;
  const attachment=fields.find(x=>x.key==='maxAttachmentMB');
  assert.deepEqual(attachment.when,{attachments:true});
  let runs=0,previous=false;
  for(const field of fields){
   const now=field.group==='回复与显示'&&field.fold==='更多显示设置';
   if(now&&!previous)runs++;
   previous=now;
  }
  assert.equal(runs,1,name+' should not render a second display fold');
 }
 const feishu=pages['dsh-channel-feishu'].fields;
 assert.deepEqual(feishu.find(x=>x.key==='autoCollectGroups').when,{allowGroups:true});
 assert.equal(feishu.find(x=>x.key==='streaming.cardEngine').fold,'更多显示设置');
 const built=fs.readFileSync(new URL('../lib/client.js',import.meta.url),'utf8');
 assert.match(built,/dpc-save-actions\{position:sticky/);
 assert(!built.includes('NewsArchiveView'),'client bundle must not resurrect previously removed UI');
 assert(built.includes('dpc-prompt-editor'),'build preserves multiline default restore');
});
