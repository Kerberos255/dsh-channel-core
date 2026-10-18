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
      CREATE TABLE IF NOT EXISTS channel_outbound_archive(
        delivery_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, provider TEXT NOT NULL,
        source TEXT NOT NULL, idempotency_key TEXT NOT NULL, text TEXT NOT NULL,
        state TEXT NOT NULL, remote_id TEXT, created_at INTEGER NOT NULL,
        sent_at INTEGER, error TEXT
      );
      CREATE INDEX IF NOT EXISTS channel_outbound_archive_session
        ON channel_outbound_archive(session_id,source,created_at DESC,delivery_id DESC);
      CREATE TABLE IF NOT EXISTS channel_commands(key TEXT PRIMARY KEY,digest TEXT NOT NULL,request TEXT NOT NULL,result TEXT,created_at INTEGER NOT NULL);
      UPDATE channel_deliveries SET state='uncertain',error='host-restarted-during-send' WHERE state='sending';
      UPDATE channel_outbound_archive SET
        state=(SELECT state FROM channel_deliveries WHERE id=delivery_id),
        remote_id=(SELECT remote_id FROM channel_deliveries WHERE id=delivery_id),
        error=(SELECT error FROM channel_deliveries WHERE id=delivery_id)
      WHERE EXISTS(SELECT 1 FROM channel_deliveries WHERE id=delivery_id
        AND state<>channel_outbound_archive.state);
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
  archive(id,{sessionId,provider,source,idempotencyKey,text}) {
    // A separate, immutable copy: not a native session message and not subject to
    // channel_deliveries' 30-day body pruning.
    // Every authenticated, Session-bound proactive delivery is archived once.
    // Native chat replies do not use this path and are not duplicated here.
    if(!['feishu','discord'].includes(provider)||!/^session-[\w-]+$/.test(sessionId))return;
    const existing=this.db.prepare('SELECT text FROM channel_outbound_archive WHERE delivery_id=?').get(id);
    if(existing&&existing.text!==text)throw Object.assign(new Error('outbound-idempotency-conflict'),{code:'outbound-idempotency-conflict'});
    this.db.prepare(`INSERT OR IGNORE INTO channel_outbound_archive
      (delivery_id,session_id,provider,source,idempotency_key,text,state,remote_id,created_at,sent_at,error)
      SELECT ?,?,?,?,?,?,state,remote_id,created_at,
        CASE WHEN state='sent' THEN created_at ELSE NULL END,error
      FROM channel_deliveries WHERE id=?`).run(id,sessionId,provider,source,idempotencyKey,text,id);
  }
  finish(id,state,remoteId=null,error=null) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE channel_deliveries SET state=?,remote_id=?,error=? WHERE id=?').run(state,remoteId,error,id);
      this.db.prepare(`UPDATE channel_outbound_archive SET state=?,remote_id=?,error=?,
        sent_at=CASE WHEN ?='sent' THEN COALESCE(sent_at,?) ELSE sent_at END
        WHERE delivery_id=?`).run(state,remoteId,error,state,Date.now(),id);
      this.db.exec('COMMIT');
    }catch(cause){this.db.exec('ROLLBACK');throw cause;}
  }
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
