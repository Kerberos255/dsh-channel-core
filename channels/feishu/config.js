import path from 'node:path';
import { defineConfig } from '../../lib/channel-plugin-settings/remote-config.js';
import { ConfigError } from '../../lib/channel-plugin-settings/file-config.js';

const ref=value=>typeof value==='string'&&/^[A-Z_][A-Z0-9_]*$/.test(value);
const id=value=>typeof value==='string'&&value.trim().length>0&&value.length<=256&&!/[\x00-\x1f]/.test(value);
// Empty legacy drafts remain loadable; reject malformed non-empty app IDs.
const appId=value=>typeof value==='string'&&value.length<=256
  &&value.trim()===value&&!/[\x00-\x1f\x7f]/.test(value);

const progressDefaults={
  toolProgress:true, commentary:true, draft:true, narration:false, toolDetail:true,
  maxLines:9, maxLineChars:240, draftMaxChars:600,
};
const footerDefaults={
  status:false, elapsed:false, model:true, context:true, tokens:false, cache:false,
};
const invalid=(field,reason)=>{throw new ConfigError('invalid-config',field+' '+reason);};
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const boolean=(field,value)=>{
  if(typeof value!=='boolean')invalid(field,'必须为布尔值');
};
const integerRange=(field,value,min,max)=>{
  if(!Number.isSafeInteger(value)||value<min||value>max)
    invalid(field,'必须为 '+min+'–'+max+' 的整数');
};

function streaming(input){
  const value=typeof input==='boolean'?{mode:input?'progress':'off'}:input;
  if(!object(value))invalid('streaming','必须为配置对象');
  for(const key of Object.keys(value))
    if(!['mode','progress','footer','cardEngine'].includes(key))
      invalid('streaming.'+key,'不是支持的配置项');

  const mode=Object.hasOwn(value,'mode')?value.mode:'progress';
  if(!['off','partial','progress'].includes(mode))
    invalid('streaming.mode','必须为 off、partial 或 progress');

  const progressInput=Object.hasOwn(value,'progress')?value.progress:{};
  if(!object(progressInput))invalid('streaming.progress','必须为对象');
  for(const key of Object.keys(progressInput))
    if(!Object.hasOwn(progressDefaults,key))invalid('streaming.progress.'+key,'不是支持的配置项');
  const progress={...progressDefaults,...progressInput};
  for(const key of ['toolProgress','commentary','draft','narration','toolDetail'])
    boolean('streaming.progress.'+key,progress[key]);
  integerRange('streaming.progress.maxLines',progress.maxLines,1,12);
  integerRange('streaming.progress.maxLineChars',progress.maxLineChars,40,300);
  integerRange('streaming.progress.draftMaxChars',progress.draftMaxChars,120,1000);

  const footerInput=Object.hasOwn(value,'footer')?value.footer:{};
  if(!object(footerInput))invalid('streaming.footer','必须为对象');
  for(const key of Object.keys(footerInput))
    if(!Object.hasOwn(footerDefaults,key))invalid('streaming.footer.'+key,'不是支持的配置项');
  const footer={...footerDefaults,...footerInput};
  for(const key of Object.keys(footerDefaults))
    boolean('streaming.footer.'+key,footer[key]);

  const cardEngine=value.cardEngine??'cardkit';
  if(!['cardkit','patch'].includes(cardEngine))
    invalid('streaming.cardEngine','必须为 cardkit 或 patch');
  return {mode,progress,footer,cardEngine};
}

const base=defineConfig({
  enabled:false, accountId:'default', appId:'', domain:'feishu',
  appSecretRef:'FEISHU_APP_SECRET', allowedUsers:[], allowGroups:false,
  autoCollectGroups:false, allowedGroups:[], requireMention:true,
  inputMode:'inherit', agentPreset:'agent', rolePreset:'', workspacePath:'',
  memoryNamespace:'private', identityLinks:[], ownerMode:'first-dm', ownerUserId:'',
  streaming:streaming({mode:'progress'}), throttleMs:750, attachments:true,maxAttachmentMB:10,
},{
  accountId:id,appId,appSecretRef:ref,
  inputMode:value=>['inherit','steering','queue','interrupt'].includes(value),
  domain:value=>['feishu','lark'].includes(value),
  workspacePath:value=>value===''||typeof value==='string'&&path.isAbsolute(value),
  memoryNamespace:id,
  ownerMode:value=>['first-dm','manual'].includes(value),
  ownerUserId:(value,config)=>value===''?config.ownerMode==='first-dm':id(value),
  agentPreset:value=>value===''||id(value),
  rolePreset:value=>value===''||id(value),
  allowedUsers:value=>Array.isArray(value)&&value.length<=1000&&value.every(id),
  allowedGroups:value=>Array.isArray(value)&&value.length<=1000&&value.every(id),
  autoCollectGroups:value=>typeof value==='boolean',
  identityLinks:value=>Array.isArray(value)&&value.length<=1000
    &&value.every(line=>typeof line==='string'&&line.includes('=')
      &&line.split('=').length===2&&line.split('=').every(id)),
  throttleMs:value=>Number.isSafeInteger(value)&&value>=400&&value<=5000,
  maxAttachmentMB:value=>Number.isSafeInteger(value)&&value>=1&&value<=20,
});

export const schema={
  defaults:base.defaults,
  validate(input){
    if(!object(input))return base.validate(input);
    return base.validate({...input,streaming:streaming(
      Object.hasOwn(input,'streaming')?input.streaming:base.defaults.streaming
    )});
  },
};
