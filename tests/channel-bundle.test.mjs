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

test('Discord and Feishu align functional groups and keep infrequent settings in their own fold',()=>{
 const source=fs.readFileSync(path.join(root,'lib/client.js'),'utf8');
 const match=source.match(/const bundledChannelPanels=([^\n]+);/);
 assert(match,'client includes bundled channel pages');
 const pages=JSON.parse(match[1]);
 const groups=['账号与连接','接收与权限','会话与输入','回复与显示','主人与记忆','附件与传输'];
 const folds={'账号与连接':'更多连接设置','会话与输入':'更多会话设置','回复与显示':'更多显示设置','主人与记忆':'更多身份与记忆设置'};
 const shared=['enabled','credentialSecret','allowedUsers','allowGroups','allowedGroups','requireMention','rolePreset','inputMode','streaming.mode','streaming.progress.toolProgress','streaming.progress.commentary','streaming.progress.toolDetail','streaming.progress.narration','throttleMs','streaming.progress.maxLines','streaming.progress.maxLineChars','ownerMode','ownerUserId','ownerStatus','memoryNamespace','identityLinks','attachments','maxAttachmentMB'];
 for(const provider of ['discord','feishu']){
  const fields=pages[provider].fields,byKey=new Map(fields.map(field=>[field.key,field]));
  assert.equal(fields.length,provider==='discord'?40:38,'all config fields remain available');
  if(provider==='discord'){
    assert(!byKey.has('streaming.style'),'removed message style must not be configurable');
    assert.equal(byKey.get('displayIcon').group,'回复与显示');
    assert.equal(byKey.get('displayIcon').type,'text');
    assert.equal(byKey.get('streaming.progress.draftMaxChars').type,'number');
    assert.equal(byKey.get('streaming.progress.draftMaxChars').min,120);
    assert.equal(byKey.get('streaming.progress.draftMaxChars').max,1000);
    assert.equal(byKey.get('throttleMs').label,'进度消息刷新间隔（毫秒）');
    assert.match(byKey.get('throttleMs').help,/默认 1100 毫秒/);
    assert.equal(byKey.get('streaming.progress.maxLines').label,'最多显示进度条目');
    assert.match(byKey.get('streaming.progress.maxLines').help,/段落换行不额外计数/);
    assert.equal(byKey.get('streaming.progress.maxLineChars').label,'工具与简短说明字数上限');
    assert.match(byKey.get('streaming.progress.maxLineChars').help,/不控制思考或正文草稿/);
    assert.equal(byKey.get('streaming.progress.draftMaxChars').label,'思考与草稿单条字数上限');
    assert.match(byKey.get('streaming.progress.draftMaxChars').help,/不是模型输出上限/);
    assert.equal(byKey.get('streaming.progress.narration').label,'显示思考');
    assert.match(byKey.get('streaming.progress.narration').help,/主人.*Discord 私聊/);
    assert.match(byKey.get('streaming.progress.narration').help,/尚未提交/);
    assert.match(byKey.get('streaming.progress.commentary').help,/已提交的阶段性公开文字/);
    for(const name of ['status','elapsed','model','context','tokens','cache']){
      const field=byKey.get('streaming.footer.'+name);
      assert.equal(field.type,'boolean');assert.equal(field.group,'回复与显示');
    }
  }
  if(provider==='feishu'){
    for(const name of ['status','elapsed','model','context','tokens','cache']){
      const field=byKey.get('streaming.footer.'+name);
      assert.equal(field?.type,'boolean');
      assert.equal(field.group,'回复与显示');
      assert.equal(field.fold,'更多显示设置');
    }
    assert.equal(byKey.get('streaming.progress.maxLines').label,'最多显示进度条目');
    assert.equal(byKey.get('throttleMs').label,'进度卡片刷新间隔（毫秒）');
    assert.equal(byKey.get('streaming.cardEngine').label,'飞书卡片引擎');
    assert.equal(byKey.get('streaming.progress.maxLineChars').label,'工具与简短说明字数上限');
    assert.equal(byKey.get('streaming.progress.draftMaxChars').label,'思考与草稿单条字数上限');
    assert.equal(byKey.get('streaming.progress.draftMaxChars').min,120);
    assert.equal(byKey.get('streaming.progress.draftMaxChars').max,1000);
    assert.equal(byKey.get('streaming.cardEngine').type,'select');
    assert(byKey.get('streaming.cardEngine').options.some(option=>option[0]==='cardkit'));
  }
  assert.equal(byKey.size,fields.length,'field names are unique');
  assert(fields.every(field=>field.advanced===false),'channel pages must not render a second global advanced settings area');
  assert.deepEqual(fields.slice(0,3).map(field=>field.key),['enabled',provider==='discord'?'applicationId':'appId','credentialSecret']);
  assert.deepEqual(fields.filter(field=>shared.includes(field.key)).map(field=>field.key),shared);
  assert.deepEqual(fields.map(field=>field.group).filter((name,index,list)=>index===0||name!==list[index-1]),groups);
  for(const field of fields){
   if(!field.fold)continue;
   assert.equal(field.fold,folds[field.group],'infrequent options stay in their own module');
  }
  const foldedGroups=Object.keys(folds);
  for(const group of foldedGroups)assert(fields.some(field=>field.group===group&&field.fold===folds[group]));
  for(const key of ['streaming.progress.toolProgress','streaming.progress.commentary','streaming.progress.toolDetail','streaming.progress.narration'])
   assert.deepEqual(byKey.get(key).when,{'streaming.mode':'progress'});
  for(const key of ['throttleMs','streaming.progress.maxLines','streaming.progress.maxLineChars'])
   assert.equal(byKey.get(key).fold,'更多显示设置');
  assert.equal(byKey.get('memoryNamespace').group,'主人与记忆');
  assert.equal(byKey.get('identityLinks').group,'主人与记忆');
  assert.equal(byKey.get('credentialSecret').type,'credential');
  assert(!fields.some(field=>field.type==='password'),'credentials stay in the protected DSH store');
 }
 assert.equal(pages.discord.fields.find(x=>x.key==='applicationId').type,'readonly');
 assert.equal(pages.feishu.fields.find(x=>x.key==='appId').type,'text');
 assert(source.includes("className:'dpc-fold'"),'folded controls render inside their group');
 assert(source.includes("editor.draft&&fields.some(spec=>spec.advanced"),'legacy shared renderer still supports other plugins');
 assert(source.includes("embeddedCredentials=fields.some(spec=>spec.type==='credential')"),'credential control is embedded rather than duplicated');
});
