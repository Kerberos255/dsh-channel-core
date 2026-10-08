const clip=(text,limit)=>{
  text=String(text??'');if(text.length<=limit)return text;
  let end=limit-1;if(/[\uD800-\uDBFF]/.test(text[end-1]??''))end--;
  return text.slice(0,end)+'…';
};
const line=(text,limit)=>clip(String(text??'').replace(/[\x00-\x1f\x7f]/g,' ').replace(/\s+/g,' ').trim(),limit);
// Streaming reasoning is fragmented; retain only its newest non-empty line.
const tail=text=>{const parts=String(text??'').split('\n').map(part=>part.trim()).filter(Boolean);return parts.at(-1)??'';};
const labels=new Map(Object.entries({exec:'执行命令',bash:'执行命令',pwsh:'执行命令',web_search:'网页搜索',web_fetch:'读取网页',read:'读取文件',read_file:'读取文件',write:'写入文件',write_file:'写入文件',edit:'编辑文件',edit_file:'编辑文件',glob:'查找文件',grep:'搜索内容',run_code:'执行代码',subagent:'子任务',job_output:'读取作业输出',job_list:'查看运行作业',todo_write:'更新计划'}));
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
    const detail=toolDetail&&tool.detail?' · '+line(tool.detail,60):'';
    rows.push(icon+' '+line(toolLabel(tool.name),Math.max(1,maxLineChars-3))+detail);
  }
  return rows.slice(-maxLines);
}
