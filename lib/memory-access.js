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
