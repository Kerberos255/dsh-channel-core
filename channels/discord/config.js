import path from 'node:path';
import { defineConfig } from '../../lib/channel-plugin-settings/remote-config.js';
import { ConfigError } from '../../lib/channel-plugin-settings/file-config.js';
const ref=v=>/^[A-Z_][A-Z0-9_]*$/.test(v);
const displayIcon=v=>typeof v==='string'&&v.trim().length>0&&Array.from(v).length<=32&&!/[@`*<>\\\x00-\x1f\x7f]/.test(v);
const id=v=>v.trim().length>0&&v.length<=256&&!/[\x00-\x1f]/.test(v);
const progressDefaults={toolProgress:true,commentary:true,narration:false,toolDetail:true,maxLines:5,maxLineChars:120,draftMaxChars:600};
const footerDefaults={status:false,elapsed:false,model:true,context:true,tokens:false,cache:false};
const invalid=()=>{throw new ConfigError('invalid-config','streaming 配置无效，请检查回复模式和底部信息选项');};
function streaming(value){
  if(typeof value==='boolean')value={mode:value?'progress':'off'};
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['mode','progress','style','footer'].includes(key)))invalid();
  const mode=Object.hasOwn(value,'mode')?value.mode:'progress';
  // Accept old saved style for migration, but discard it: Discord is plain text only.
  if(Object.hasOwn(value,'style')&&!['plain','embed','components-v2'].includes(value.style))invalid();
  const input=Object.hasOwn(value,'progress')?value.progress:{};
  const footerInput=Object.hasOwn(value,'footer')?value.footer:{};
  if(!['off','partial','progress'].includes(mode))invalid();
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!Object.hasOwn(progressDefaults,key)))invalid();
  if(!footerInput||typeof footerInput!=='object'||Array.isArray(footerInput)||Object.keys(footerInput).some(key=>!Object.hasOwn(footerDefaults,key)))invalid();
  const progress={...progressDefaults,...input},footer={...footerDefaults,...footerInput};
  if(typeof progress.toolProgress!=='boolean'||typeof progress.commentary!=='boolean'||typeof progress.narration!=='boolean'||typeof progress.toolDetail!=='boolean'||!Number.isSafeInteger(progress.maxLines)||progress.maxLines<1||progress.maxLines>12||!Number.isSafeInteger(progress.maxLineChars)||progress.maxLineChars<40||progress.maxLineChars>300||!Number.isSafeInteger(progress.draftMaxChars)||progress.draftMaxChars<120||progress.draftMaxChars>1000)invalid();
  if(Object.values(footer).some(v=>typeof v!=='boolean'))invalid();
  return {mode,progress,footer};
}
const base=defineConfig({
  enabled:false,accountId:'default',tokenRef:'DISCORD_BOT_TOKEN',dmPolicy:'allowlist',allowedUsers:[],allowGroups:false,groupPolicy:'allowlist',allowedGroups:[],requireMention:true,
  registerCommands:true,inputMode:'inherit',agentPreset:'agent',rolePreset:'',workspacePath:'',memoryNamespace:'private',identityLinks:[],ownerMode:'first-dm',ownerUserId:'',displayIcon:'🐋',
  streaming:streaming({mode:'progress'}),throttleMs:1100,attachments:true,maxAttachmentMB:10,
},{displayIcon,dmPolicy:v=>['disabled','allowlist','all'].includes(v),groupPolicy:v=>['allowlist','all'].includes(v),accountId:id,tokenRef:ref,inputMode:v=>['inherit','steering','queue','interrupt'].includes(v),workspacePath:v=>v===''||path.isAbsolute(v),memoryNamespace:id,ownerMode:v=>['first-dm','manual'].includes(v),ownerUserId:(v,c)=>v===''?c.ownerMode==='first-dm':id(v),agentPreset:v=>v===''||id(v),rolePreset:v=>v===''||id(v),allowedUsers:v=>v.length<=1000&&v.every(id),allowedGroups:v=>v.length<=1000&&v.every(id),identityLinks:v=>v.length<=1000&&v.every(s=>s.includes('=')&&s.split('=').length===2&&s.split('=').every(id)),throttleMs:v=>Number.isSafeInteger(v)&&v>=400&&v<=5000,maxAttachmentMB:v=>Number.isSafeInteger(v)&&v>=1&&v<=20});
export const schema={defaults:base.defaults,validate(input){
  if(!input||typeof input!=='object'||Array.isArray(input))return base.validate(input);
  return base.validate({...input,streaming:streaming(Object.hasOwn(input,'streaming')?input.streaming:base.defaults.streaming)});
}};
