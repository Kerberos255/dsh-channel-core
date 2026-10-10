const clip=(text,limit)=>{
  text=String(text??'');if(text.length<=limit)return text;
  let end=limit-1;if(/[\uD800-\uDBFF]/.test(text[end-1]??''))end--;
  return text.slice(0,end)+'…';
};
const line=(text,limit)=>clip(String(text??'').replace(/[\x00-\x1f\x7f]/g,' ').replace(/\s+/g,' ').trim(),limit);
// Keep the most recent streamed text in long drafts rather than the oldest prefix.
// The marker remains visible so Discord's pinned-draft policy still recognizes it.
const narrativeLine=(marker,text,limit)=>{
  // Keep the original paragraph boundaries; only remove unsafe controls and
  // collapse excessive blank space. Discord supports these native newlines.
  const clean=String(text??'').replace(/\r\n?/g,'\n').replace(/[\x00-\x08\x0b-\x1f\x7f]/g,'').replace(/\t/g,' ').replace(/[ \t]+\n/g,'\n').replace(/\n{3,}/g,'\n\n').trim();
  const room=Math.max(1,limit-marker.length);
  if(clean.length<=room)return marker+clean;
  let start=clean.length-(room-1);
  if(/[\uDC00-\uDFFF]/.test(clean[start]??''))start++;
  return marker+'…'+clean.slice(start);
};
// Preserve streamed reasoning newlines. Channel-specific presentation budgets apply;
// the native session remains the source of truth for longer reasoning.
const reasoningText=(text,maxChars,truncated=false)=>{
  const clean=String(text??'').replace(/\r\n?/g,'\n').replace(/[\x00-\x08\x0b-\x1f\x7f]/g,'').trim();
  if(!clean)return '';
  const max=Math.max(96,Math.min(12000,Number.isSafeInteger(maxChars)?maxChars:1600));
  const prefix='…（前文已截断）\n';
  const needsClip=truncated||clean.length>max;
  if(!needsClip)return clean;
  const available=Math.max(1,max-prefix.length);
  let start=Math.max(0,clean.length-available);
  if(start&&/[\uDC00-\uDFFF]/.test(clean[start]))start++;
  return prefix+clean.slice(start);
};
const labels=new Map(Object.entries({
 exec:'执行命令',bash:'执行命令',pwsh:'执行命令',shell:'执行命令',
 web_search:'网页搜索',web_fetch:'读取网页',
 read:'读取文件',read_file:'读取文件',write:'写入文件',write_file:'写入文件',edit:'编辑文件',edit_file:'编辑文件',str_replace_editor:'编辑文件',
 glob:'查找文件',grep:'搜索内容',run_code:'执行代码',
 subagent:'子任务',send_message:'发消息',list_agents:'查看子代理',interrupt_agent:'中止子代理',
 job_output:'读取作业输出',job_kill:'结束作业',job_list:'查看运行作业',
 skill:'加载技能',skill_workshop:'技能工坊',
 schedule_create:'设定提醒',schedule_update:'修改提醒',schedule_delete:'删除提醒',schedule_list:'查看提醒',
 todo_write:'更新计划',present:'交付文件',ask_user_question:'提问',status_health_check:'健康检查',load_workspace_dependencies:'加载依赖',
 memory_search:'记忆检索',memory_topics:'记忆索引',memory_dream:'记忆整理',
 lcm_grep:'上下文检索',lcm_expand:'展开原文',lcm_expand_query:'上下文检索',lcm_describe:'查看摘要',
 browser_navigate:'打开网页',browser_snapshot:'网页快照',browser_click:'网页点击',browser_type:'网页输入',browser_screenshot:'网页截图',
 desktop_windows:'列出窗口',desktop_snapshot:'窗口快照',desktop_click:'点击控件',desktop_type:'窗口输入',desktop_screenshot:'窗口截图'}));
const toolLabel=name=>labels.get(name)??name??'工具';

/** Shared public progress rows. Header, text fallback and delivery belong to each transport. */
export function renderProgressLines(body,options){
  const {toolProgress,commentary,narration,toolDetail,maxLines,maxLineChars}=options,activity=body.activity??{},rows=[];
  // Without Discord's dedicated option, retain the original Feishu rendering.
  const narrative=(prefix,text)=>Number.isSafeInteger(options.draftMaxChars)?narrativeLine(prefix,text,options.draftMaxChars):line(prefix+text,maxLineChars);
  // Discord-only reading order: thought first, then drafted text, then tools.
  // Keep original relative order within each category; Feishu stays chronological.
  const organize=entries=>!options.pinDrafts&&!options.feishuLayout?entries:[
    ...entries.filter(row=>row.startsWith('💭 ')),
    ...entries.filter(row=>row.startsWith('📝 草稿 · ')||row.startsWith('📝 ')),
    ...entries.filter(row=>!row.startsWith('💭 ')&&!row.startsWith('📝 ')),
  ];
  // Timeline events are chronological; each draft/tool is one logical scrolling row.
  if(Array.isArray(activity.timeline)){
    const formatTool=tool=>{
      const icon=tool.status==='completed'?'✅':tool.status==='failed'?'❌':'⏳';
      const detail=toolDetail&&tool.detail?' · '+String(tool.detail):'';
      return line(icon+' '+toolLabel(tool.name)+detail,maxLineChars);
    };
    for(const item of activity.timeline){
      if(item.type==='draft'&&narration&&item.text)rows.push(narrative('💭 ',item.text));
      else if(item.type==='tool'&&toolProgress&&item.activity)rows.push(formatTool(item.activity));
      else if(item.type==='public-draft'&&commentary&&item.text)rows.push(narrative(options.feishuLayout?'📝 ':'📝 草稿 · ',item.text));
      else if(item.type==='commentary'&&commentary&&item.text)rows.push(line('💬 '+item.text,maxLineChars));
    }
    if(narration&&activity.activeDraft)rows.push(narrative('💭 ',activity.activeDraft));
    if(narration&&activity.activeTextDraft)rows.push(narrative(options.feishuLayout?'📝 ':'📝 草稿 · ',activity.activeTextDraft));
    // Public commentary remains useful before the first tool event.
    if(!rows.length&&commentary&&activity.commentary)rows.push(line('💬 '+activity.commentary,maxLineChars));
    // Discord-only display policy: keep the latest real public draft and
    // reasoning visible when a burst of tools would otherwise evict them.
    // Feishu retains its chronological tail via the default (pinDrafts=false).
    if((options.pinDrafts||options.feishuLayout)&&rows.length>maxLines&&maxLines>1){
      const draft=rows.findLastIndex(text=>text.startsWith('📝 '));
      const thinking=rows.findLastIndex(text=>text.startsWith('💭 '));
      const pinned=[draft,thinking].filter(index=>index>=0).slice(0,maxLines-1);
      const chosen=new Set(pinned);
      for(let index=rows.length-1;index>=0&&chosen.size<maxLines;index--)chosen.add(index);
      return organize([...chosen].sort((a,b)=>a-b).map(index=>rows[index]));
    }
    return organize(rows.slice(-maxLines));
  }
  if(narration&&activity.narration)rows.push('💭 思考\n'+reasoningText(activity.narration,options.reasoningMaxChars,activity.narrationTruncated));
  if(commentary&&activity.commentary)rows.push('💬 '+line(activity.commentary,Math.max(1,maxLineChars-3)));
  const room=Math.max(0,maxLines-rows.length);
  const tools=toolProgress&&room?(activity.tools??[]).slice(-room):[];
  for(const tool of tools){
    const icon=tool.status==='completed'?'✅':tool.status==='failed'?'❌':'⏳';
    const detail=toolDetail&&tool.detail?' · '+line(tool.detail,110):'';
    rows.push(icon+' '+line(toolLabel(tool.name),Math.max(1,maxLineChars-3))+detail);
  }
  return rows.slice(-maxLines);
}
