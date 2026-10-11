/** Read-only Ask User receipt. Shared by Feishu and Discord. */
export function completedAskUserText(answered,limit=6500){
  if(!Array.isArray(answered)||!answered.length)return '✅ 已回答';
  const lines=['✅ 已回答'];
  for(const [index,entry] of answered.entries()){
    if(!entry||typeof entry!=='object')continue;
    const clean=value=>String(value??'').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g,'').trim();
    const question=clean(entry.question);
    const selected=Array.isArray(entry.selected)?entry.selected.map(clean).filter(Boolean):[];
    const custom=clean(entry.custom);
    lines.push('',answered.length>1?'问题 '+(index+1)+'：'+question:'问题：'+question);
    if(selected.length)lines.push('已选：'+selected.join('、'));
    if(custom)lines.push('补充回答：'+custom);
    if(!selected.length&&!custom)lines.push('已提交回答');
  }
  const content=lines.join('\n');
  return content.length<=limit?content:content.slice(0,limit-18)+'\n…（内容已截断）';
}
