import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { CoreError } from './validation.js';
import { routeKeys } from './routing.js';

/** Read the native workspace archive index on every admission.
 * Avoid caching: users can archive a Session in the DSH desktop at any time.
 */
export function isNativeArchived(homePath,sessionId){
  let contents;
  try { contents=readFileSync(homePath('storages','workspace.json'),'utf8'); }
  catch(error){
    if(error.code==='ENOENT')return false;
    throw new CoreError('native-archive-unavailable','无法读取 DSH 工作区归档状态');
  }
  let registry;
  try { registry=JSON.parse(contents); }
  catch { throw new CoreError('native-archive-invalid','DSH 工作区归档状态无法解析'); }
  const ids=registry?.global?.archivedSessionIds;
  if(ids===undefined)return false;
  if(!Array.isArray(ids))throw new CoreError('native-archive-invalid','DSH 工作区归档状态格式错误');
  return ids.includes(sessionId);
}

/** Shared by every channel: repair only explicitly archived Sessions.
 * The native Session is created before the scoped, atomic binding rebind.
 * Concurrent messages for one scope share the same recovery promise.
 */
export class ArchivedSessionRecovery {
  constructor({store,router,controller,homePath,getSharedDM}){
    Object.assign(this,{store,router,controller,homePath,getSharedDM});
    this.pending=new Map();
  }
  async recover(route,routingOptions,create={},signal){
    if(!isNativeArchived(this.homePath,route.binding.sessionId))return route;
    const sharedDM=this.getSharedDM();
    const {routeKey}=routeKeys(route.message,route.binding.scope,sharedDM);
    const previous=this.pending.get(routeKey)??Promise.resolve();
    const task=previous.catch(()=>{}).then(async()=>{
      signal?.throwIfAborted();
      // Reroute after waiting: another channel may already have repaired it.
      const current=this.router.route(route.message,routingOptions);
      if(!isNativeArchived(this.homePath,current.binding.sessionId))return current;
      const currentKey=routeKeys(current.message,current.binding.scope,this.getSharedDM()).routeKey;
      if(currentKey!==routeKey)return this.recover(current,routingOptions,create,signal);
      const old=current.binding.sessionId,next='session-'+randomUUID();
      // Fail closed: keep the original binding if native creation fails.
      await this.controller.create({...create,sessionId:next});
      signal?.throwIfAborted();
      const changed=this.store.rebindArchivedRoute(old,next,routeKey,this.getSharedDM());
      if(changed)console.info('[channel-core] archived channel Session rolled over to a new native Session', {provider:current.message.provider,scope:'channel',oldSession:old,newSession:next});
      return this.router.route(route.message,routingOptions);
    });
    this.pending.set(routeKey,task);
    task.finally(()=>{if(this.pending.get(routeKey)===task)this.pending.delete(routeKey);}).catch(()=>{});
    return task;
  }
}
