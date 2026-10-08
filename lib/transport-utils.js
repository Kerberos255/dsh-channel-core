export function checkAbort(signal){if(signal?.aborted)throw new DOMException('Channel connection closed','AbortError');}
export async function* boundedBytes(iterable,maxBytes,signal){
  let total=0;
  for await(const chunk of iterable){checkAbort(signal);total+=chunk.byteLength;if(total>maxBytes)throw Object.assign(new Error('attachment-too-large'),{code:'attachment-too-large'});yield chunk;}
}
export async function discordAttachment(resource,signal,maxBytes,fetcher=fetch){
  let url=new URL(resource.url);
  for(let redirects=0;redirects<4;redirects++){
    if(url.protocol!=='https:'||!['cdn.discordapp.com','media.discordapp.net'].includes(url.hostname)||url.username||url.password)throw new Error('attachment-url-not-allowed');
    checkAbort(signal);
    const response=await fetcher(url,{signal,redirect:'manual'});
    if(response.status>=300&&response.status<400){const location=response.headers.get('location');await response.body?.cancel();if(!location)throw new Error('attachment-redirect-invalid');url=new URL(location,url);continue;}
    if(!response.ok)throw new Error('attachment-download-failed');
    const length=Number(response.headers.get('content-length'));
    if(length>maxBytes){await response.body?.cancel();throw new Error('attachment-too-large');}
    return boundedBytes(response.body,maxBytes,signal);
  }
  throw new Error('attachment-too-many-redirects');
}
/** Split Discord text without breaking surrogate pairs or leaving code fences open. */
export function splitDiscord(text,limit=1900){
  const parts=[];let remaining=String(text),fence='';
  while(remaining){
    const prefix=fence?'```'+fence+'\n':'';
    let take=Math.min(remaining.length,limit-prefix.length-8);
    if(take<remaining.length){const newline=remaining.lastIndexOf('\n',take);if(newline>take/2)take=newline+1;}
    if(/[\uD800-\uDBFF]/.test(remaining[take-1]??''))take--;
    const body=remaining.slice(0,take);remaining=remaining.slice(take);
    for(const match of body.matchAll(/(?:^|\n)```([^\n]*)/g))fence=fence?'':match[1].trim().slice(0,48)||' ';
    parts.push(prefix+body+(fence?'\n```':''));
  }
  return parts.length?parts:['本轮已完成。'];
}
export const statusLabel=status=>({thinking:'正在思考',generating:'正在回复','tool-running':'正在执行工具',completed:'已完成',cancelled:'已停止',failed:'执行失败',truncated:'达到输出限制','waiting-user':'等待回答','waiting-approval':'等待确认'}[status]??status);
