import { statusLabel } from 'dsh-channel-core/transport-utils';
import { renderProgressLines } from 'dsh-channel-core/progress-lines';

const clip=(text,limit)=>{
  text=String(text??'');if(text.length<=limit)return text;
  let end=limit-1;if(/[\uD800-\uDBFF]/.test(text[end-1]??''))end--;
  return text.slice(0,end)+'…';
};


/** Progress carries public commentary, an opt-in reasoning tail, and tool names with a scrubbed detail fragment. */
export function renderProgress(body,settings){
  const header='**🐋 DeepSeek · '+statusLabel(body.status)+'**';
  if(settings.mode!=='progress')return clip(header+'\n'+(body.text||'正在处理…'),1900);
  return clip([header,...renderProgressLines(body,settings.progress)].join('\n'),1900);
}

export function renderNotice(body){return clip('**DeepSeek · '+statusLabel(body.status)+'**\n'+(body.text||'正在处理…'),1900);}
