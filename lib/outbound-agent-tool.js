/** Session-bound outbound delivery. DSH native Schedule owns scheduled
 * conversations; this tool only performs transport with durable deduplication.
 */
export function installOutboundAgentTool(ctx,core){
 ctx.inject(['tools'],scope=>{
  scope.tools.register({
   name:'channel_send',
   description:'向当前 Session 已授权的飞书/Discord 渠道发送消息。用 text 发送文字；飞书使用 imagePath 发送工作区内图片、filePath 发送普通文件。不能仅粘贴本地文件路径。一次一个附件；文件说明另发文字。',
   parameters:{type:'object',properties:{
    text:{type:'string',description:'外发文字；图片或文件可省略'},
    imagePath:{type:'string',description:'飞书：工作区内 PNG/JPG/GIF/WebP 图片路径'},
    filePath:{type:'string',description:'飞书：工作区内 PDF/Word/Excel/PPT/ZIP/TXT 等文件路径，最大 30 MB'},
    bindingId:{type:'string',description:'可选，通常省略。省略时使用当前 Session 唯一的已授权渠道绑定；不要猜测此值，只有需要明确指定多个绑定之一时才填写'},
    idempotencyKey:{type:'string',description:'可选。稳定幂等键；省略时使用本次工具调用 ID。同一任务重试请沿用同一键'},
   },additionalProperties:false},timeoutMs:45000,
   output:{schema:{type:'object',additionalProperties:true},
    render:(_args,result)=>[{type:'text',text:JSON.stringify(result)}]},
   execute:async(args,exec)=>{
    exec.signal?.throwIfAborted();
    if(!exec.agent?.session?.id)throw new Error('channel-outbound-session-denied');
    if((typeof args.text!=='string'||!args.text.trim())&&!args.imagePath&&!args.filePath)
     throw new Error('channel-send-text-or-attachment-required');
    return core.sendToBoundSession({
     sessionId:exec.agent.session.id,bindingId:args.bindingId,text:args.text??'',
     ...(args.imagePath?{imagePath:args.imagePath}:{}),
     ...(args.filePath?{filePath:args.filePath}:{}),
     ...((args.imagePath||args.filePath)?{workspacePath:exec.agent.session.header?.cwd}:{}),
     idempotencyKey:args.idempotencyKey||exec.callId,source:'agent'
    });
   }
  });
 });
}
