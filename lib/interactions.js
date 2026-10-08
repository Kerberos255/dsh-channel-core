import { randomUUID } from 'node:crypto';
import { deliveryKey } from './delivery-store.js';

const actorKey=origin=>deliveryKey([origin.provider,origin.accountId,origin.userId,origin.conversationId,origin.threadId??'']);
const failure=code=>Object.assign(new Error(code),{code});

/** Short-lived answer capability; DSH retains question validation, policy and audit. */
export class ChannelInteractions {
  constructor(bridge){this.bridge=bridge;this.pending=new Map();}
  targets(agent){
    if(!agent)return [];
    const state=[...this.bridge.turns.values()].find(item=>item.sessionId===agent.session.id&&!item.terminal);
    if(!state)return [];
    const origins=this.bridge.store.origins(state.sessionId,state.turn);
    // A group question belongs to the user whose input was claimed last. Verified
    // shared private inputs may answer through either of their original channels.
    const latest=origins.at(-1);
    return origins.filter(origin=>origin.userId===latest?.userId&&origin.provider===latest.provider||this.bridge.core.store.identity(origin)===this.bridge.core.store.identity(latest)).filter(origin=>this.bridge.adapters.get(JSON.stringify([origin.provider,origin.accountId]))?.adapter.question);
  }
  request(req,next,kind='question'){
    const origins=this.targets(req.agent);
    if(!origins.length)return next();
    if(req.signal?.aborted)return Promise.reject(failure('ASK_ABORTED'));
    if(kind==='approval'&&String(req.reason??'').length>4500)return next();
    return new Promise((resolve,reject)=>{
      const pending={id:randomUUID(),req,kind,origins,resolve,reject,index:0,answers:[],selected:new Set(),tokens:new Set(),messages:new Map(),done:false};
      this.pending.set(pending.id,pending);
      const state=[...this.bridge.turns.values()].find(item=>item.sessionId===req.agent.session.id&&!item.terminal);
      // Snapshot committed public prose before the question tool suspends the turn.
      // Stream drafts, reasoning and tool arguments are never question context.
      pending.context=state?.committed??'';
      if(state){state.waiting=true;state.status=kind==='approval'?'waiting-approval':'waiting-user';}
      const end=()=>this.settle(pending,kind==='approval'?'cancelled':failure('ASK_ABORTED'));
      pending.abort=end;req.signal?.addEventListener('abort',end,{once:true});
      pending.timer=setTimeout(()=>this.settle(pending,kind==='approval'?'unavailable':failure('NO_PROVIDER')),600000);pending.timer.unref?.();
      if(req.signal?.aborted){end();return;}
      this.show(pending).catch(()=>this.settle(pending,kind==='approval'?'unavailable':failure('NO_PROVIDER')));
    });
  }
  token(pending,origin,operation){
    const token=this.bridge.core.store.interaction(pending.req.agent.session.id,actorKey(origin),{pendingId:pending.id,origin,operation},600000);
    pending.tokens.add(token);return token;
  }
  revoke(pending){
    const remove=this.bridge.core.store.db.prepare('DELETE FROM interactions WHERE token=?');
    for(const token of pending.tokens)remove.run(token);
    pending.tokens.clear();
  }
  async show(pending){
    if(pending.done)return;
    this.revoke(pending);
    const question=pending.req.questions?.[pending.index];
    await Promise.all(pending.origins.map(async origin=>{
      const registration=this.bridge.adapters.get(JSON.stringify([origin.provider,origin.accountId]));
      if(!registration||registration.closed)return;
      const custom=this.token(pending,origin,{type:'custom'});
      const actions=pending.kind==='approval'?
        [{label:'仅允许本次',token:this.token(pending,origin,{type:'approval',value:'allowed-once'})},{label:'拒绝',token:this.token(pending,origin,{type:'approval',value:'rejected'})}]:
        (question.options??[]).slice(0,20).map(option=>({label:(pending.selected.has(option.label)?'✓ ':'')+option.label,token:this.token(pending,origin,{type:'option',value:option.label})}));
      if(pending.kind==='question'&&question.multiSelect)actions.push({label:'确认选择',token:this.token(pending,origin,{type:'confirm'})});
      const text=pending.kind==='approval'?`操作：${pending.req.toolName}\n\n${pending.req.reason??'请确认是否允许本次操作。'}`:
        `${pending.index+1}/${pending.req.questions.length} · ${question.question}\n\n${question.detail??''}${question.multiSelect?'\n可选择多项，然后点击“确认选择”。':''}\n\n文字回答：/answer ${custom} 你的回答`;
      const sent=await this.bridge.queue(registration,origin,()=>pending.done?undefined:registration.adapter.question(origin,{status:pending.kind==='approval'?'waiting-approval':'waiting-user',text,context:pending.context,final:false},actions));
      if(sent?.messageId)pending.messages.set(actorKey(origin),sent.messageId);
    }));
  }
  async answer(request,custom){
    const row=this.bridge.core.store.db.prepare('SELECT * FROM interactions WHERE token=?').get(request.token);
    if(!row||row.consumed||row.expires_at<=Date.now())throw failure('stale-interaction');
    const data=JSON.parse(row.payload),pending=this.pending.get(data.pendingId),origin=data.origin;
    if(!pending||pending.done||pending.req.signal?.aborted)throw failure('stale-interaction');
    const verifiedThread=custom===undefined&&request.threadId===undefined&&pending.messages.get(actorKey(origin))===request.messageId?origin.threadId:request.threadId;
    if(request.provider!==origin.provider||request.accountId!==origin.accountId||request.userId!==origin.userId||request.conversationId!==origin.conversationId||(verifiedThread??'')!==(origin.threadId??''))throw failure('interaction-actor-mismatch');
    const {operation}=this.bridge.core.store.consumeInteraction(request.token,actorKey(origin)).payload;
    if(pending.kind==='approval'){
      if(operation.type!=='approval')throw failure('approval-button-required');
      this.settle(pending,operation.value);return {accepted:true};
    }
    const question=pending.req.questions[pending.index];
    if(operation.type==='option'){
      if(!question.options?.some(option=>option.label===operation.value))throw failure('invalid-answer');
      if(question.multiSelect){pending.selected.has(operation.value)?pending.selected.delete(operation.value):pending.selected.add(operation.value);await this.show(pending);return {accepted:true};}
      pending.answers.push({id:question.id,selected:[operation.value]});
    }else if(operation.type==='confirm')pending.answers.push({id:question.id,selected:[...pending.selected]});
    else if(operation.type==='custom'&&custom?.trim())pending.answers.push({id:question.id,selected:[],custom:custom.trim().slice(0,65536)});
    else throw failure('invalid-answer');
    pending.index++;pending.selected.clear();
    if(pending.index===pending.req.questions.length)this.settle(pending,{answers:pending.answers});
    else await this.show(pending);
    return {accepted:true};
  }
  answerText(origin,text){const match=text.match(/^([0-9a-f-]{36})\s+([\s\S]+)$/i);if(!match)throw failure('answer-format');return this.answer({...origin,token:match[1]},match[2]);}
  settle(pending,result){
    if(pending.done)return;pending.done=true;clearTimeout(pending.timer);pending.req.signal?.removeEventListener('abort',pending.abort);this.revoke(pending);this.pending.delete(pending.id);
    const state=[...this.bridge.turns.values()].find(item=>item.sessionId===pending.req.agent.session.id&&!item.terminal);
    if(state){state.waiting=false;state.status='thinking';}
    result instanceof Error?pending.reject(result):pending.resolve(result);
  }
  disconnected(){for(const pending of this.pending.values())if(!pending.origins.some(origin=>this.bridge.adapters.has(JSON.stringify([origin.provider,origin.accountId]))))this.settle(pending,pending.kind==='approval'?'unavailable':failure('NO_PROVIDER'));}
  close(){for(const pending of this.pending.values())this.settle(pending,pending.kind==='approval'?'cancelled':failure('ASK_ABORTED'));}
}
