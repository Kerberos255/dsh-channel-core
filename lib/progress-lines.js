const clip=(text,limit)=>{
  text=String(text??'');if(text.length<=limit)return text;
  let end=limit-1;if(/[\uD800-\uDBFF]/.test(text[end-1]??''))end--;
  return text.slice(0,end)+'…';
};
const line=(text,limit)=>clip(String(text??'').replace(/[\x00-\x1f\x7f]/g,' ').replace(/\s+/g,' ').trim(),limit);
// Streaming reasoning is fragmented; retain only its newest non-empty line.
const tail=text=>{const parts=String(text??'').split('\n').map(part=>part.trim()).filter(Boolean);return parts.at(-1)??'';};
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
  if(narration&&activity.narration)rows.push('💭 '+line(tail(activity.narration),Math.max(1,maxLineChars-3)));
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
