import { createHash } from 'node:crypto';

export const deliveryKey = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** References to native inputs and bounded outbound bodies, never a second transcript. */
export class DeliveryStore {
  constructor(db) {
    this.db = db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS channel_turn_origins(request_id TEXT PRIMARY KEY,session_id TEXT NOT NULL,turn INTEGER NOT NULL,origin TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS channel_origins_turn ON channel_turn_origins(session_id,turn);
      CREATE TABLE IF NOT EXISTS channel_deliveries(id TEXT PRIMARY KEY,provider TEXT NOT NULL,account_id TEXT NOT NULL,origin TEXT NOT NULL,body TEXT NOT NULL,state TEXT NOT NULL,remote_id TEXT,created_at INTEGER NOT NULL,error TEXT);
      CREATE INDEX IF NOT EXISTS channel_delivery_pending ON channel_deliveries(provider,account_id,state);
      CREATE TABLE IF NOT EXISTS channel_commands(key TEXT PRIMARY KEY,digest TEXT NOT NULL,request TEXT NOT NULL,result TEXT,created_at INTEGER NOT NULL);
      UPDATE channel_deliveries SET state='uncertain',error='host-restarted-during-send' WHERE state='sending';
    `);
  }
  origin(requestId, sessionId, turn, value) {
    this.db.prepare('INSERT OR IGNORE INTO channel_turn_origins VALUES(?,?,?,?)').run(requestId,sessionId,turn,JSON.stringify(value));
  }
  origins(sessionId, turn) { return this.db.prepare('SELECT origin FROM channel_turn_origins WHERE session_id=? AND turn=? ORDER BY rowid').all(sessionId,turn).map(row=>JSON.parse(row.origin)); }
  pending(provider, accountId) { return this.db.prepare("SELECT * FROM channel_deliveries WHERE provider=? AND account_id=? AND state='pending' ORDER BY created_at LIMIT 256").all(provider,accountId); }
  get(id) { return this.db.prepare('SELECT * FROM channel_deliveries WHERE id=?').get(id); }
  enqueue(id, origin, body) {
    const serialized=JSON.stringify(body);
    if (Buffer.byteLength(serialized)>1024*1024) throw new Error('channel-delivery-too-large');
    this.db.prepare("INSERT OR IGNORE INTO channel_deliveries VALUES(?,?,?,?,?,'pending',NULL,?,NULL)").run(id,origin.provider,origin.accountId,JSON.stringify(origin),serialized,Date.now());
    return this.get(id);
  }
  claim(id) { return this.db.prepare("UPDATE channel_deliveries SET state='sending' WHERE id=? AND state='pending'").run(id).changes===1; }
  finish(id,state,remoteId=null,error=null) { this.db.prepare('UPDATE channel_deliveries SET state=?,remote_id=?,error=? WHERE id=?').run(state,remoteId,error,id); }
  counts(provider,accountId) { return this.db.prepare('SELECT state,count(*) AS count FROM channel_deliveries WHERE provider=? AND account_id=? GROUP BY state').all(provider,accountId); }
  command(key,payload,request) {
    const digest=deliveryKey(payload),existing=this.db.prepare('SELECT * FROM channel_commands WHERE key=?').get(key);
    if(existing&&existing.digest!==digest)throw Object.assign(new Error('command-conflict'),{code:'command-conflict'});
    if(!existing)this.db.prepare('INSERT INTO channel_commands VALUES(?,?,?,NULL,?)').run(key,digest,JSON.stringify(request),Date.now());
    const row=existing??this.db.prepare('SELECT * FROM channel_commands WHERE key=?').get(key);
    return {...row,request:JSON.parse(row.request),result:row.result?JSON.parse(row.result):null};
  }
  finishCommand(key,result){this.db.prepare('UPDATE channel_commands SET result=? WHERE key=?').run(JSON.stringify(result),key);}
  prune(now=Date.now()) {
    const cutoff=now-30*86400000;
    this.db.prepare("UPDATE channel_deliveries SET body='{}' WHERE created_at<? AND state IN ('sent','failed') AND body!='{}'").run(cutoff);
    // Keep deduplication identities, but discard already delivered response bodies after 30 days.
    this.db.prepare("UPDATE channel_commands SET request='{}',result='{}' WHERE created_at<? AND result IS NOT NULL AND request!='{}'").run(cutoff);
    this.db.prepare('DELETE FROM interactions WHERE consumed=1 OR expires_at<?').run(now);
  }
}
