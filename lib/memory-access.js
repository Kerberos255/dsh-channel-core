/** Allow only explicitly verified private identities to access an owner's memory. */
export function isOwnerChannelSession(store,sessionId,ownerIdentityId){
  if(typeof sessionId!=='string'||typeof ownerIdentityId!=='string'||!ownerIdentityId)return false;
  let rows=store.db.prepare('SELECT data FROM bindings WHERE session_id=?').all(sessionId);
  if(!rows.length){
    const archived=store.db.prepare('SELECT record FROM archived_dm_sessions WHERE session_id=?').get(sessionId);
    if(!archived)return false;
    let record;try{record=JSON.parse(archived.record);}catch{return false;}
    if(record?.ownerIdentityId!==ownerIdentityId||!Array.isArray(record.members)||!record.members.length||record.members.length>250)return false;
    rows=record.members.map(member=>({data:JSON.stringify(member)}));
  }
  for(const row of rows){
    let data;
    try{data=JSON.parse(row.data);}catch{return false;}
    if(data.kind!=='dm'||!data.provider||!data.accountId||!data.userId)return false;
    const autoOwner=ownerIdentityId==='owner'?store.owner(data.provider,data.accountId):null;
    if(ownerIdentityId==='owner'&&autoOwner?.userId===data.userId)continue;
    const alias=store.db.prepare('SELECT identity_id,verified FROM aliases WHERE provider=? AND account_id=? AND user_id=?')
      .get(data.provider,data.accountId,data.userId);
    if(!alias||alias.verified!==1||alias.identity_id!==ownerIdentityId)return false;
    const proof=store.db.prepare('SELECT verified_at FROM alias_verifications WHERE provider=? AND account_id=? AND user_id=?')
      .get(data.provider,data.accountId,data.userId);
    if(!proof?.verified_at)return false;
  }
  return true;
}

/** Require durable group/thread provenance and reject mixed private-DM
 * records. SQLite validates in place, without loading message history into JS.
 */
const groupSessionQuery=new WeakMap();
export function isGroupChannelSession(store,sessionId){
 if(typeof sessionId!=='string'||!sessionId)return false;
 try{
  const db=store.db;
  let query=groupSessionQuery.get(db);
  if(!query){
   query=db.prepare(`
    WITH records AS (
      SELECT data AS payload FROM bindings WHERE session_id=?
      UNION ALL
      SELECT origin AS payload FROM receipts WHERE session_id=?
    )
    SELECT COUNT(*) AS total, COALESCE(SUM(
      CASE WHEN json_valid(payload) THEN
        CASE WHEN json_extract(payload,'$.kind') IN ('group','thread')
          AND json_extract(payload,'$.provider') IN ('discord','feishu')
          AND json_type(payload,'$.accountId')='text'
          AND length(json_extract(payload,'$.accountId'))>0
          AND json_type(payload,'$.conversationId')='text'
          AND length(json_extract(payload,'$.conversationId'))>0
        THEN 0 ELSE 1 END
      ELSE 1 END
    ),0) AS invalid FROM records
   `);
   groupSessionQuery.set(db,query);
  }
  const result=query.get(sessionId,sessionId);
  return result.total>0&&result.invalid===0;
 }catch{return false;}
}
