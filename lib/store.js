import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { CoreError, id } from './validation.js';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export class CoreStore {
  constructor(filename) {
    if (filename !== ':memory:') mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;`);
    // Upgrade only the private, unreleased Phase 1 prototype schema.
    if (this.db.prepare('PRAGMA table_info(receipts)').all().some(c => c.name === 'epoch')) {
      this.tx(() => this.db.exec(`
        DROP INDEX IF EXISTS receipts_session;
        ALTER TABLE receipts RENAME TO prototype_receipts;
        CREATE TABLE receipts(key TEXT PRIMARY KEY, request_id TEXT UNIQUE NOT NULL, session_id TEXT NOT NULL, digest TEXT NOT NULL, status TEXT NOT NULL, origin TEXT NOT NULL, created_at INTEGER NOT NULL);
        INSERT INTO receipts SELECT key,request_id,session_id,digest,CASE WHEN status='cancelled' THEN 'uncertain' ELSE status END,origin,created_at FROM prototype_receipts;
        DROP TABLE prototype_receipts;
        ALTER TABLE interactions RENAME TO prototype_interactions;
        CREATE TABLE interactions(token TEXT PRIMARY KEY, session_id TEXT NOT NULL, actor_id TEXT NOT NULL, payload TEXT NOT NULL, expires_at INTEGER NOT NULL, consumed INTEGER NOT NULL DEFAULT 0);
        INSERT INTO interactions SELECT token,session_id,actor_id,payload,expires_at,consumed FROM prototype_interactions;
        DROP TABLE prototype_interactions;
        DROP TABLE IF EXISTS epochs;
        DROP TABLE IF EXISTS cancelled_messages;
        DROP TABLE IF EXISTS outbox;`));
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS receipts(key TEXT PRIMARY KEY, request_id TEXT UNIQUE NOT NULL, session_id TEXT NOT NULL, digest TEXT NOT NULL, status TEXT NOT NULL, origin TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS receipts_session ON receipts(session_id, status);
      CREATE TABLE IF NOT EXISTS aliases(provider TEXT, account_id TEXT, user_id TEXT, identity_id TEXT NOT NULL, verified INTEGER NOT NULL, PRIMARY KEY(provider,account_id,user_id));
      CREATE TABLE IF NOT EXISTS channel_alias_config(provider TEXT,account_id TEXT,user_id TEXT,identity_id TEXT,PRIMARY KEY(provider,account_id,user_id));
      CREATE TABLE IF NOT EXISTS channel_owners(provider TEXT NOT NULL,account_id TEXT NOT NULL,user_id TEXT NOT NULL,claimed_at INTEGER NOT NULL,source TEXT NOT NULL,PRIMARY KEY(provider,account_id));
      CREATE TABLE IF NOT EXISTS alias_verifications(provider TEXT,account_id TEXT,user_id TEXT,verified_at INTEGER NOT NULL,verified_by TEXT NOT NULL,PRIMARY KEY(provider,account_id,user_id));
      CREATE TABLE IF NOT EXISTS scope_sessions(scope_key TEXT PRIMARY KEY, session_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS archived_dm_sessions(session_id TEXT PRIMARY KEY, record TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS bindings(binding_key TEXT PRIMARY KEY, id TEXT UNIQUE NOT NULL, session_id TEXT NOT NULL, data TEXT NOT NULL, revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS interactions(token TEXT PRIMARY KEY, session_id TEXT NOT NULL, actor_id TEXT NOT NULL, payload TEXT NOT NULL, expires_at INTEGER NOT NULL, consumed INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, kind TEXT NOT NULL, detail TEXT NOT NULL, at INTEGER NOT NULL);
      PRAGMA user_version=3;
      UPDATE receipts SET status='uncertain' WHERE status='admitting';`);
  }
  tx(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const result = fn(); this.db.exec('COMMIT'); return result } catch (error) { this.db.exec('ROLLBACK'); throw error } }
  receipt(requestId) { return this.db.prepare('SELECT * FROM receipts WHERE request_id=?').get(requestId) }
  claim({ key, requestId = randomUUID(), sessionId, origin, payload }) {
    id(key, 'receipt-key'); id(sessionId, 'session'); id(requestId, 'request');
    const digest = hash(payload);
    return this.tx(() => {
      const existing = this.db.prepare('SELECT * FROM receipts WHERE key=? OR request_id=?').get(key, requestId);
      if (existing) {
        if (existing.digest !== digest || existing.session_id !== sessionId || existing.key !== key) throw new CoreError('receipt-conflict');
        return { row: existing, fresh: false };
      }
      this.db.prepare('INSERT INTO receipts VALUES(?,?,?,?,?,?,?)').run(key, requestId, sessionId, digest, 'received', JSON.stringify(origin), Date.now());
      return { row: this.receipt(requestId), fresh: true };
    });
  }
  status(requestId, status) { this.db.prepare("UPDATE receipts SET status=? WHERE request_id=? AND status!='settled'").run(status, requestId) }
  identity(alias) {
    for (const key of ['provider', 'accountId', 'userId']) id(alias[key], key);
    const args = [alias.provider, alias.accountId, alias.userId];
    let row = this.db.prepare('SELECT * FROM aliases WHERE provider=? AND account_id=? AND user_id=?').get(...args);
    if (!row) {
      this.db.prepare('INSERT OR IGNORE INTO aliases VALUES(?,?,?,?,0)').run(...args, 'identity-' + randomUUID());
      row = this.db.prepare('SELECT * FROM aliases WHERE provider=? AND account_id=? AND user_id=?').get(...args);
    }
    return row.identity_id;
  }
  verifyAlias(alias, identityId, operatorId) {
    id(identityId, 'identity'); id(operatorId, 'operator');
    return this.tx(() => {
      const before = this.identity(alias);
      this.db.prepare('UPDATE aliases SET identity_id=?,verified=1 WHERE provider=? AND account_id=? AND user_id=?').run(identityId, alias.provider, alias.accountId, alias.userId);
      this.db.prepare('INSERT INTO alias_verifications VALUES(?,?,?,?,?) ON CONFLICT(provider,account_id,user_id) DO UPDATE SET verified_at=excluded.verified_at,verified_by=excluded.verified_by').run(alias.provider,alias.accountId,alias.userId,Date.now(),operatorId);
      this.db.prepare('INSERT INTO audit(kind,detail,at) VALUES(?,?,?)').run('verify-alias', JSON.stringify({ alias, before, identityId, operatorId }), Date.now());
    });
  }
  syncAliases(provider,accountId,links){
    return this.tx(()=>{
      const previous=this.db.prepare('SELECT * FROM channel_alias_config WHERE provider=? AND account_id=?').all(provider,accountId),next=new Map(links.map(link=>[link.userId,link.identityId]));
      for(const old of previous)if(!next.has(old.user_id)){
        this.db.prepare('UPDATE aliases SET identity_id=?,verified=0 WHERE provider=? AND account_id=? AND user_id=? AND identity_id=?').run('identity-'+randomUUID(),provider,accountId,old.user_id,old.identity_id);
        this.db.prepare('DELETE FROM channel_alias_config WHERE provider=? AND account_id=? AND user_id=?').run(provider,accountId,old.user_id);
        this.db.prepare('DELETE FROM alias_verifications WHERE provider=? AND account_id=? AND user_id=?').run(provider,accountId,old.user_id);
      }
      for(const [userId,identityId] of next){id(userId);id(identityId);const alias={provider,accountId,userId},before=this.identity(alias);
        if(before!==identityId||!this.db.prepare('SELECT 1 FROM alias_verifications WHERE provider=? AND account_id=? AND user_id=?').get(provider,accountId,userId))this.db.prepare('INSERT INTO alias_verifications VALUES(?,?,?,?,?) ON CONFLICT(provider,account_id,user_id) DO UPDATE SET verified_at=excluded.verified_at,verified_by=excluded.verified_by').run(provider,accountId,userId,Date.now(),'plugin-config');
        this.db.prepare('UPDATE aliases SET identity_id=?,verified=1 WHERE provider=? AND account_id=? AND user_id=?').run(identityId,provider,accountId,userId);
        this.db.prepare('INSERT INTO channel_alias_config VALUES(?,?,?,?) ON CONFLICT(provider,account_id,user_id) DO UPDATE SET identity_id=excluded.identity_id').run(provider,accountId,userId,identityId);
      }
    });
  }
  owner(provider,accountId){
    return this.db.prepare('SELECT user_id AS userId,claimed_at AS claimedAt,source FROM channel_owners WHERE provider=? AND account_id=?').get(provider,accountId)??null;
  }
  claimOwner(message){
    if(message.kind!=='dm'||!message.provider||!message.accountId||!message.userId)return this.owner(message.provider,message.accountId);
    const current=this.owner(message.provider,message.accountId);
    if(current)return current;
    return this.tx(()=>{
      this.db.prepare("INSERT OR IGNORE INTO channel_owners(provider,account_id,user_id,claimed_at,source) VALUES(?,?,?,?,'first-dm')")
        .run(message.provider,message.accountId,message.userId,Date.now());
      return this.owner(message.provider,message.accountId);
    });
  }
  setOwner(provider,accountId,userId){
    if(!provider||!accountId||!userId)throw new CoreError('invalid-owner');
    const current=this.owner(provider,accountId);
    if(current?.userId===userId&&current.source==='manual')return current;
    return this.tx(()=>{
      this.db.prepare("INSERT INTO channel_owners(provider,account_id,user_id,claimed_at,source) VALUES(?,?,?,?,'manual') ON CONFLICT(provider,account_id) DO UPDATE SET user_id=excluded.user_id,claimed_at=excluded.claimed_at,source='manual'")
        .run(provider,accountId,userId,Date.now());
      return this.owner(provider,accountId);
    });
  }
  sessionForScope(key) {
    this.db.prepare('INSERT OR IGNORE INTO scope_sessions VALUES(?,?)').run(key, 'session-' + randomUUID());
    return this.db.prepare('SELECT session_id FROM scope_sessions WHERE scope_key=?').get(key).session_id;
  }
  binding(key) { const row = this.db.prepare('SELECT * FROM bindings WHERE binding_key=?').get(key); return row && { ...JSON.parse(row.data), id: row.id, sessionId: row.session_id, revision: row.revision } }
  rebindScope(previous,next,scope){
    return this.tx(()=>{
      const rows=this.db.prepare('SELECT * FROM bindings WHERE session_id=?').all(previous);
      for(const row of rows){const data=JSON.parse(row.data);if(JSON.stringify(data.scope)!==JSON.stringify(scope))continue;
        this.db.prepare('UPDATE bindings SET session_id=?,revision=revision+1 WHERE binding_key=?').run(next,row.binding_key);
      }
      this.db.prepare('UPDATE scope_sessions SET session_id=? WHERE session_id=?').run(next,previous);
    });
  }
  putBinding(key, data, expectedRevision = 0) {
    return this.tx(() => {
      const previous = this.binding(key);
      if ((previous?.revision ?? 0) !== expectedRevision) throw new CoreError('binding-conflict');
      const bindingId = previous?.id ?? 'binding-' + randomUUID();
      this.db.prepare('INSERT INTO bindings VALUES(?,?,?,?,?) ON CONFLICT(binding_key) DO UPDATE SET session_id=excluded.session_id,data=excluded.data,revision=excluded.revision').run(key, bindingId, data.sessionId, JSON.stringify(data), expectedRevision + 1);
      return this.binding(key);
    });
  }
  interaction(sessionId, actorId, payload, ttl = 300000) {
    id(sessionId, 'session'); id(actorId, 'actor');
    const token = randomUUID();
    this.db.prepare('INSERT INTO interactions VALUES(?,?,?,?,?,0)').run(token, sessionId, actorId, JSON.stringify(payload), Date.now() + ttl);
    return token;
  }
  consumeInteraction(token, actorId) {
    return this.tx(() => {
      const row = this.db.prepare('SELECT * FROM interactions WHERE token=?').get(token);
      if (!row || row.actor_id !== actorId || row.consumed || row.expires_at <= Date.now()) throw new CoreError('stale-interaction');
      this.db.prepare('UPDATE interactions SET consumed=1 WHERE token=?').run(token);
      return { sessionId: row.session_id, payload: JSON.parse(row.payload) };
    });
  }
  close() { this.db.close() }
}
