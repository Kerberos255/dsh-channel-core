import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { routeKeys } from './routing.js';
import { isOwnerChannelSession } from './memory-access.js';
import { CoreError } from './validation.js';

const fail=(code,message)=>{throw new CoreError(code,message);};
const same=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;

/** Revalidate the durable Dream run at the final commit boundary. */
function verifiedHandoff(core,request){
 const dream=core.ctx.get('memoryDreaming');
 const memory=dream?.memory,config=dream?.configFile?.value;
 if(!memory||!config?.enabled||!config.autoPromote||config.ownerIdentityId!==request.ownerIdentityId)fail('rotation-memory-invalid','Dream 配置或主人身份已变化');
 const run=memory.db.prepare("SELECT state,result FROM runs WHERE id=? AND scope=? AND kind='dream'").get(request.memoryRunId,memory.scope(request.cwd));
 let result;try{result=JSON.parse(run?.result??'null');}catch{}
 if(run?.state!=='completed'||result?.state!=='completed'||result.empty||result.draftOnly||result.rejected>0||result.staged>result.promoted)fail('rotation-memory-incomplete','Dream 交接运行没有通过持久化验证');
 const artifact=result.artifacts?.find(row=>row.path==='DREAMS.md'&&row.hash===request.artifactHash);
 if(!artifact||!(/^[a-f0-9]{64}$/i).test(artifact.hash))fail('rotation-memory-incomplete','Dream 交接产物校验值不匹配');
 const root=fs.realpathSync(request.cwd),file=path.join(root,'DREAMS.md'),stat=fs.lstatSync(file);
 if(!stat.isFile()||stat.isSymbolicLink()||stat.size>1048576||createHash('sha256').update(fs.readFileSync(file)).digest('hex')!==artifact.hash)fail('rotation-memory-changed','Dream 交接文件被修改');
}

/** Atomic, identity-checked rebind of ALL DM aliases sharing one native session.
 * Called only AFTER a durable Dream handoff is independently verified.
 * Never rebinds groups or desktop sessions; archived sessions remain untouched.
 */
export async function rotateTrustedDM(core,{previous,next,ownerIdentityId,cwd,preset,expectedSeq,memoryRunId,artifactHash,signal}){
 signal?.throwIfAborted();
 const proof={ownerIdentityId,cwd,memoryRunId,artifactHash};
 if(core.closed||!core.configFile.value.sharedDM)fail('rotation-unavailable','共享私聊渠道未启用');
 if(typeof ownerIdentityId!=='string'||!ownerIdentityId.trim())fail('rotation-owner-missing','未配置记忆主人身份');
 if(!/^session-[a-zA-Z0-9-]{6,120}$/.test(previous)||!/^session-[a-zA-Z0-9-]{6,120}$/.test(next)||previous===next)fail('rotation-invalid-session','轮转会话 ID 无效');
 const store=core.store;
 if(core.coordinator.tails.has(previous)||[...core.commandTasks.values()].length)fail('rotation-busy','渠道仍有待处理输入或命令');
 const agent=core.ctx.get('agents')?.get(previous);
 if(agent&&agent.status!=='idle')fail('rotation-busy','旧会话尚未空闲');
 if(agent?.inbox?.hasPending?.())fail('rotation-busy','旧会话有等待处理的输入');
 if(!isOwnerChannelSession(store,previous,ownerIdentityId))fail('rotation-untrusted','旧会话未通过渠道主人身份核验');
 verifiedHandoff(core,proof);
 const query=core.ctx.get('sessionQuery');
 if(!query)fail('rotation-unavailable','原生会话查询服务不可用');
 const validate=async(sessionId)=>{
  const observation=await query.observeSession(sessionId);
  try {
   const header=observation.header;
   const actualPreset=observation.projections?.values?.agentPreset??header.agentPreset??'';
   if(header.id!==sessionId||!header.cwd||header.parentSession||!same(fs.realpathSync(header.cwd),fs.realpathSync(cwd))||actualPreset!==(preset??''))fail('rotation-scope-mismatch','新旧会话工作区或预设不匹配');
   return observation.events.at(-1)?.seq??-1;
  } finally {observation[Symbol.dispose]?.();}
 };
 await validate(next);
 const observedSeq=await validate(previous);
 if(!Number.isSafeInteger(expectedSeq)||expectedSeq!==observedSeq)fail('rotation-source-changed','Dream 整理后的原生事件游标不匹配');
 const guard=()=>{
  const records=store.db.prepare('SELECT binding_key,session_id,revision,data FROM bindings WHERE session_id=? ORDER BY binding_key').all(previous);
  if(!records.length||records.some(row=>{try{return JSON.parse(row.data).kind!=='dm';}catch{return true;}}))fail('rotation-binding-invalid','目标不是完整的私聊绑定');
  const routes=new Set(records.map(row=>{const data=JSON.parse(row.data);return routeKeys(data,data.scope,true).routeKey;}));
  if(routes.size!==1)fail('rotation-binding-invalid','绑定来自不同的共享会话范围');
  const scopeKey=[...routes][0],row=store.db.prepare('SELECT session_id FROM scope_sessions WHERE scope_key=?').get(scopeKey);
  if(row?.session_id!==previous)fail('rotation-binding-changed','共享会话的路由已改变');
  if(store.db.prepare('SELECT 1 FROM bindings WHERE session_id=? LIMIT 1').get(next))fail('rotation-target-used','新会话已有渠道绑定');
  if(store.db.prepare("SELECT 1 FROM receipts WHERE session_id=? AND status IN ('received','admitting','uncertain') LIMIT 1").get(previous))fail('rotation-pending-input','存在未确认的渠道输入');
  if(!isOwnerChannelSession(store,previous,ownerIdentityId))fail('rotation-untrusted','轮转时主人身份已变化');
  return {records,scopeKey};
 };
 guard(); // Validate before the final native observation; commit rechecks transactionally.
 const latestSeq=await validate(previous);
 if(latestSeq!==expectedSeq)fail('rotation-source-changed','旧会话在整理后发生了新事件');
 if(core.coordinator.tails.has(previous)||core.ctx.get('agents')?.get(previous)?.status==='running')fail('rotation-busy','旧会话又开始处理新输入');
 signal?.throwIfAborted();
 return store.tx(()=>{
  signal?.throwIfAborted();
  const {records,scopeKey}=guard();
  verifiedHandoff(core,proof);
  // Persist verified, immutable DM origin before removing the active binding.
  store.db.prepare('INSERT INTO archived_dm_sessions(session_id,record,created_at) VALUES(?,?,?)')
   .run(previous,JSON.stringify({ownerIdentityId,members:records.map(row=>JSON.parse(row.data))}),Date.now());
  for(const row of records){
   const out=store.db.prepare('UPDATE bindings SET session_id=?,revision=revision+1 WHERE binding_key=? AND session_id=? AND revision=?').run(next,row.binding_key,previous,row.revision);
   if(out.changes!==1)fail('rotation-binding-changed','绑定在提交时发生变化');
  }
  const out=store.db.prepare('UPDATE scope_sessions SET session_id=? WHERE scope_key=? AND session_id=?').run(next,scopeKey,previous);
  if(out.changes!==1)fail('rotation-binding-changed','共享会话路由在提交时发生变化');
  store.db.prepare('INSERT INTO audit(kind,detail,at) VALUES(?,?,?)').run('auto-rotation',JSON.stringify({previous,next,bindings:records.length}),Date.now());
  return {rotated:true,previous,next,bindings:records.length};
 });
}
