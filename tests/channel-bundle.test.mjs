import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { migrateChannelConfigs } from '../lib/channel-components.js';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
test('migration only copies legacy configs and never overwrites saved component settings',()=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-channel-bundle-'));
 try {
  const home=path.join(tmp,'home');fs.mkdirSync(home);
  const old=path.join(tmp,'plugins','dsh-channel-discord','config.json');
  fs.mkdirSync(path.dirname(old),{recursive:true});
  fs.writeFileSync(old,JSON.stringify({schemaVersion:1,enabled:true,tokenRef:'BOT_LEGACY_REF',identityLinks:['u=same']}));
  const first=migrateChannelConfigs(home);
  const current=path.join(tmp,'plugins','dsh-channel-core','channels','discord','config.json');
  assert.equal(first.find(x=>x.name==='discord').result,'copied');
  assert.deepEqual(JSON.parse(fs.readFileSync(current,'utf8')).identityLinks,['u=same']);
  fs.writeFileSync(current,JSON.stringify({schemaVersion:1,enabled:false,tokenRef:'NEW_REF'}));
  const second=migrateChannelConfigs(home);
  assert.equal(second.find(x=>x.name==='discord').result,'existing');
  assert.equal(JSON.parse(fs.readFileSync(current,'utf8')).tokenRef,'NEW_REF');
  assert.equal(JSON.parse(fs.readFileSync(old,'utf8')).tokenRef,'BOT_LEGACY_REF');
 }finally{fs.rmSync(tmp,{recursive:true,force:true})}
});

test('core client registers one plugin settings panel with three tabs',()=>{
 const source=fs.readFileSync(path.join(root,'lib/client.js'),'utf8');
 const registry=[];
 const context={
  window:{__ModuleLoader__:{load:function(x){registry.push(x)}}},
  document:{},
 };
 vm.runInNewContext(source,context,{filename:'client.js'});
 assert.equal(registry.length,1);
 assert.equal(registry[0].id,'dsh-channel-core');
 const React={createElement:function(type,props){return {type,props,children:Array.prototype.slice.call(arguments,2)}},forwardRef:function(fn){return fn},useState:function(x){return [x,function(){}]},useEffect:function(){},useMemo:function(fn){return fn()}};
 const pkg=registry[0].factory(function(name){
   if(name==='react')return React;
   if(name==='@deepseek-ai/dsh-client-ui-primitives')return {Switch:function(){},Button:function(){}};
   throw Error('unexpected require '+name);
 });
 assert(pkg.inject.includes('remote.credentials'));
 const pages=[];
 const app={
  locale:{register:function(){}},
  connection:{},remote:{credentials:{}},
  effect:function(){},slots:{
   inject:function(_slot,cb){cb()},
   register:function(args,view){pages.push({args,view})}
  }
 };
 pkg.apply(app);
 assert.equal(pages.length,1);
 assert.equal(pages[0].args.key,'dsh-channel-core');
 const result=pages[0].view({view:'detail',t:function(x){return x}});
 assert.equal(result.type.name,'ChannelBundlePage');
 assert(source.includes("['general','通用与会话']"));
 assert(source.includes("['discord','Discord']"));
 assert(source.includes("['feishu','飞书']"));
 assert(source.includes('discordChannelSettings'));
 assert(source.includes('feishuChannelSettings'));
});
