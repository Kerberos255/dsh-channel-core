import { CoreError, id, mode } from './validation.js';

/** Channel admission only. The native Controller owns Web RPC, Inbox and Stop. */
export class Coordinator {
  constructor(store, runtime) {
    this.store = store;
    this.runtime = runtime;
    this.requests = new Map();
    this.tails = new Map();
    this.closed = false;
  }
  admit(request, { key, origin = {}, policy = 'steering', payload = request, prepare, signal } = {}) {
    if (this.closed) throw new CoreError('core-closed');
    id(request.sessionId, 'session'); id(request.requestId, 'request'); id(key, 'receipt-key'); mode(policy);
    const { row } = this.store.claim({ key, requestId: request.requestId, sessionId: request.sessionId, origin, payload });
    if (['accepted', 'settled'].includes(row.status)) return Promise.resolve({ accepted: true });
    if (row.status === 'uncertain') return Promise.reject(new CoreError('uncertain-input'));
    if (this.requests.has(row.request_id)) return this.requests.get(row.request_id);
    const task = (this.tails.get(row.session_id) ?? Promise.resolve()).catch(() => {}).then(async () => {
      if (signal?.aborted) throw new CoreError('aborted-input');
      await prepare?.();
      if (signal?.aborted) throw new CoreError('aborted-input');
      if (policy === 'interrupt') this.runtime.cancel({ sessionId: row.session_id });
      this.store.status(row.request_id, 'admitting');
      try {
        // Native prompt checks the caller signal before admission, then owns it.
        const result = await this.runtime.prompt({
          ...request, requestId: row.request_id, mode: policy === 'steering' ? 'steer' : 'queue',
        }, signal ?? new AbortController().signal);
        this.store.status(row.request_id, 'accepted');
        return result;
      } catch (error) {
        // A native RemoteError rejects admission; other failures may be ambiguous.
        this.store.status(row.request_id, error.name === 'RemoteError' ? 'received' : 'uncertain');
        throw error;
      }
    });
    this.requests.set(row.request_id, task);
    this.tails.set(row.session_id, task);
    task.finally(() => {
      if (this.requests.get(row.request_id) === task) this.requests.delete(row.request_id);
      if (this.tails.get(row.session_id) === task) this.tails.delete(row.session_id);
    }).catch(() => {});
    return task;
  }
  async close() {
    this.closed = true;
    await Promise.allSettled(this.requests.values());
  }
}
