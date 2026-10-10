import { statusLabel } from 'dsh-channel-core/transport-utils';
import { renderProgressLines } from 'dsh-channel-core/progress-lines';

const clip=(text,limit)=>{
  text=String(text??'');if(text.length<=limit)return text;
  let end=limit-1;if(/[\uD800-\uDBFF]/.test(text[end-1]??''))end--;
  return text.slice(0,end)+'…';
};
const roleLabel=value=>{
  const clean=String(value??'').replace(/[\r\n\x00-\x1f\x7f<>@]/g,'').trim().slice(0,48);
  return clean?clean.replace(/([*_`~|\\])/g,'\\$1'):'Agent';
};
/** Keep Discord's progress label independent of model/provider names. */
export function renderHeading(status,identity={}){
  const icon=identity.icon??'🐋';
  return '**'+icon+' '+roleLabel(identity.name)+' · '+statusLabel(status)+'**';
}
/** Quiet Discord small text, separated from the main response by whitespace alone. */
export function footerSuffix(footer){
  return footer?'\n\n-# '+footer:'';
}
// Fit the complete rolling window into one Discord message. Short tool rows
// keep their budget; the remaining space is shared fairly among draft/thought
// rows, avoiding the old whole-message truncation that hid newest events.
const isNarrative=row=>row.startsWith('💭 ')||row.startsWith('📝 草稿 · ');
const shorten=(row,max)=>{
  if(row.length<=max)return row;
  if(isNarrative(row)){
    const marker=row.startsWith('💭 ')?'💭 ':'📝 草稿 · ';
    let from=row.length-Math.max(1,max-marker.length-1);
    if(/[\uDC00-\uDFFF]/.test(row[from]??''))from++;
    return marker+'…'+row.slice(from);
  }
  return clip(row,max);
};
// Separate narrative blocks (and sections) without wasting space between
// consecutive tool statuses. These are presentation-only separators.
const isTool=row=>/^(?:✅|❌|⏳) /.test(row);
const separator=(left,right)=>isTool(left)&&isTool(right)?'\n':'\n\n';
const joinRows=rows=>rows.map((row,i)=>i?separator(rows[i-1],row)+row:row).join('');
function fitRows(rows,maxChars){
  if(!rows.length)return '';
  const joined=joinRows(rows);
  if(joined.length<=maxChars)return joined;
  const separators=rows.slice(1).reduce((size,row,i)=>size+separator(rows[i],row).length,0);
  const pool=Math.max(0,maxChars-separators);
  const limits=rows.map(row=>Math.min(row.length,Math.floor(pool/rows.length),48));
  let left=pool-limits.reduce((a,b)=>a+b,0);
  const distribute=indices=>{
    while(left>0){
      const eligible=indices.filter(i=>limits[i]<rows[i].length);
      if(!eligible.length)break;
      const share=Math.max(1,Math.floor(left/eligible.length));
      let consumed=0;
      for(const i of eligible){
        const n=Math.min(share,rows[i].length-limits[i],left-consumed);
        limits[i]+=n;consumed+=n;
      }
      if(consumed===0)break;
      left-=consumed;
    }
  };
  distribute(rows.map((_,i)=>i).filter(i=>!isNarrative(rows[i])));
  distribute(rows.map((_,i)=>i).filter(i=>isNarrative(rows[i])));
  return joinRows(rows.map((row,i)=>shorten(row,limits[i])));
}
/** Progress carries public commentary, opt-in reasoning, and scrubbed tool summaries. */
export function renderProgress(body,settings,footer='',identity={}){
  const header=renderHeading(body.status,identity);
  const trailing=footerSuffix(footer);
  const available=Math.max(200,1900-trailing.length);
  if(settings.mode!=='progress')return clip(header+'\n'+(body.text||'正在处理…'),available)+trailing;
  const rows=renderProgressLines(body,{...settings.progress,reasoningMaxChars:1400,pinDrafts:true});
  return header+(rows.length?'\n\n'+fitRows(rows,Math.max(0,available-header.length-2)):'')+trailing;
}

export function renderNotice(body,identity={}){
  return clip(renderHeading(body.status,identity)+'\n'+(body.text||'正在处理…'),1900);
}
