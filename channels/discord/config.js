import path from 'node:path';
import { defineConfig } from '../../lib/channel-plugin-settings/remote-config.js';
import { ConfigError } from '../../lib/channel-plugin-settings/file-config.js';
const ref=v=>/^[A-Z_][A-Z0-9_]*$/.test(v);
const id=v=>v.trim().length>0&&v.length<=256&&!/[\x00-\x1f]/.test(v);
const progressDefaults={toolProgress:true,commentary:true,narration:false,toolDetail:true,maxLines:6,maxLineChars:300};
const invalid=()=>{throw new ConfigError('invalid-config','streaming 配置无效，请检查回复模式及进度选项');};
function streaming(value){
  if(typeof value==='boolean')value={mode:value?'progress':'off'};
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['mode','progress'].includes(key)))invalid();
  const mode=Object.hasOwn(value,'mode')?value.mode:'progress',input=Object.hasOwn(value,'progress')?value.progress:{};
  if(!['off','partial','progress'].includes(mode)||!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!Object.hasOwn(progressDefaults,key)))invalid();
  const progress={...progressDefaults,...input};
  if(typeof progress.toolProgress!=='boolean'||typeof progress.commentary!=='boolean'||typeof progress.narration!=='boolean'||typeof progress.toolDetail!=='boolean'||!Number.isSafeInteger(progress.maxLines)||progress.maxLines<1||progress.maxLines>12||!Number.isSafeInteger(progress.maxLineChars)||progress.maxLineChars<40||progress.maxLineChars>300)invalid();
  return {mode,progress};
}
const base=defineConfig({
  enabled:false,accountId:'default',tokenRef:'DISCORD_BOT_TOKEN',dmPolicy:'allowlist',allowedUsers:[],allowGroups:false,groupPolicy:'allowlist',allowedGroups:[],requireMention:true,
  registerCommands:true,inputMode:'inherit',agentPreset:'agent',workspacePath:'',memoryNamespace:'private',identityLinks:[],ownerMode:'first-dm',ownerUserId:'',
  streaming:streaming({mode:'progress'}),throttleMs:600,attachments:true,maxAttachmentMB:10,
},{dmPolicy:v=>['disabled','allowlist','all'].includes(v),groupPolicy:v=>['allowlist','all'].includes(v),accountId:id,tokenRef:ref,inputMode:v=>['inherit','steering','queue','interrupt'].includes(v),workspacePath:v=>v===''||path.isAbsolute(v),memoryNamespace:id,ownerMode:v=>['first-dm','manual'].includes(v),ownerUserId:(v,c)=>v===''?c.ownerMode==='first-dm':id(v),agentPreset:v=>v===''||id(v),allowedUsers:v=>v.length<=1000&&v.every(id),allowedGroups:v=>v.length<=1000&&v.every(id),identityLinks:v=>v.length<=1000&&v.every(s=>s.includes('=')&&s.split('=').length===2&&s.split('=').every(id)),throttleMs:v=>Number.isSafeInteger(v)&&v>=400&&v<=5000,maxAttachmentMB:v=>Number.isSafeInteger(v)&&v>=1&&v<=20});
export const schema={defaults:base.defaults,validate(input){
  if(!input||typeof input!=='object'||Array.isArray(input))return base.validate(input);
  return base.validate({...input,streaming:streaming(Object.hasOwn(input,'streaming')?input.streaming:base.defaults.streaming)});
}};
