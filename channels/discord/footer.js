import { statusLabel } from 'dsh-channel-core/transport-utils';

const number=value=>Number.isFinite(value)&&value>=0?Math.floor(value):null;
const compact=value=>{
  const v=number(value);
  if(v===null)return '';
  if(v>=1000000)return (v/1000000).toFixed(v%1000000<100000?0:1)+'M';
  if(v>=1000)return (v/1000).toFixed(v%1000<100?0:1)+'k';
  return String(v);
};
const safeModel=model=>{
  if(typeof model!=='string')return '';
  const clean=model.replace(/[\r\n\x00-\x1f<>\x7f]/g,'').trim().slice(0,100);
  return clean.replace(/[@`*_~|\\]/g,'\\$&');
};
/** Preserve unknown fields as unknown rather than inventing 0 tokens or a ratio. */
export function renderFooter(choices={},body={},metrics={}){
  const parts=[];
  if(choices.status&&body.status)parts.push(statusLabel(body.status));
  if(choices.elapsed){
    const ms=number(body.durationMs);
    if(ms!==null)parts.push('耗时 '+(ms<60000?(ms/1000).toFixed(1)+'s':Math.floor(ms/60000)+'m '+Math.floor(ms%60000/1000)+'s'));
  }
  if(choices.model){
    const model=safeModel(metrics.model);
    if(model)parts.push(model);
  }
  if(choices.context){
    const context=compact(metrics.contextTokens),limit=compact(metrics.contextLimitTokens);
    if(context)parts.push('上下文 '+context+(limit?'/'+limit:'')+' tokens');
  }
  if(choices.tokens){
    const input=compact(metrics.inputTokens),output=compact(metrics.outputTokens);
    if(input||output)parts.push('Tokens '+(input||'—')+' / '+(output||'—'));
  }
  if(choices.cache){
    const read=compact(metrics.cacheRead),write=compact(metrics.cacheWrite);
    if(read||write)parts.push('缓存 '+(read||'—')+' / '+(write||'—'));
  }
  return parts.join(' · ').slice(0,300);
}
