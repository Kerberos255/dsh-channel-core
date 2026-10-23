import { randomUUID } from 'node:crypto';
import { deliveryKey } from './delivery-store.js';

const actorKey=origin=>deliveryKey([origin.provider,origin.accountId,origin.userId,origin.conversationId,origin.threadId??'']);
const failure=code=>Object.assign(new Error(code),{code});

/** Short-lived answer capability; DSH retains question validation, policy and audit. */
export class ChannelInteractions {
  constructor(bridge){this.bridge=bridge;this.pending=new Map();}
  diagnostic(event,details={},level='warn'){
    this.bridge.ctx.get?.('pluginDiagnostics')?.record('dsh-channel-core',level,event,details);
  }
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
      const pending={id:randomUUID(),req,kind,origins,resolve,reject,index:0,answers:[],selected:new Set(),tokens:new Set(),messages:new Map(),done:false,version:0,startedAt:Date.now()};
      this.pending.set(pending.id,pending);
      const state=[...this.bridge.turns.values()].find(item=>item.sessionId===req.agent.session.id&&!item.terminal);
      // Snapshot committed public prose before the question tool suspends the turn.
      // Stream drafts, reasoning and tool arguments are never question context.
      pending.context=state?.committed??'';
      if(state){
        // Keep pre-question history for final delivery, but never replay it in
        // a resumed Feishu progress card. The marker survives timeline rollover
        // naturally: once aged out, the older entries have aged out too.
        // A monotonic sequence keeps the cut stable after the 60-entry rollover.
        state.timelineSeq=(state.timelineSeq??0)+1;
        state.timeline.push({type:'question-boundary',seq:state.timelineSeq});
        if(state.timeline.length>60)state.timeline.shift();
        state.questionStream=state.stream;
        state.questionStreamCursor=state.stream?.text?.length??0;
        state.questionNarrationCursor=state.narration.length;
        state.waiting=true;state.status=kind==='approval'?'waiting-approval':'waiting-user';
      }
      const end=()=>this.settle(pending,kind==='approval'?'cancelled':failure('ASK_ABORTED'));
      pending.abort=end;req.signal?.addEventListener('abort',end,{once:true});
      pending.timer=setTimeout(()=>this.settle(pending,kind==='approval'?'unavailable':failure('ASK_USER_TIMEOUT')),600000);pending.timer.unref?.();
      if(req.signal?.aborted){end();return;}
      this.diagnostic('channel.question-created',{count:pending.req.questions?.length??1,provider:origins[0]?.provider},'info');
      this.show(pending).catch(()=>this.settle(pending,kind==='approval'?'unavailable':failure('ASK_USER_DELIVERY_FAILED')));
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
    pending.version=(pending.version??0)+1;
    this.revoke(pending);
    let delivered=0;
    const question=pending.req.questions?.[pending.index];
    await Promise.all(pending.origins.map(async origin=>{
      const registration=this.bridge.adapters.get(JSON.stringify([origin.provider,origin.accountId]));
      if(!registration||registration.closed)return;
      const custom=this.token(pending,origin,{type:'custom'});
      const options=(question?.options??[]).slice(0,20);
      const multi=pending.kind==='question'&&!!question?.multiSelect;
      const selectedToken=multi?this.token(pending,origin,{type:'select'}):null;
      const submitToken=multi?this.token(pending,origin,{type:'form'}):null;
      const actions=pending.kind==='approval'?
        [{label:'仅允许本次',token:this.token(pending,origin,{type:'approval',value:'allowed-once'})},{label:'拒绝',token:this.token(pending,origin,{type:'approval',value:'rejected'})}]:
        multi?[]:options.map(option=>({label:option.label,token:this.token(pending,origin,{type:'option',value:option.label})}));
      if(pending.kind==='question'&&!multi)actions.push({label:'✍️ 自定义回答',token:custom,custom:true});
      const ui=pending.kind==='question'?{multi,options:options.map((option,index)=>({label:option.label,value:String(index)})),
        selectToken:selectedToken,submitToken,customToken:custom}:undefined;
      const text=pending.kind==='approval'?`操作：${pending.req.toolName}\n\n${pending.req.reason??'请确认是否允许本次操作。'}`:
        `${pending.index+1}/${pending.req.questions.length} · ${question.question}\n\n${question.detail??''}${multi?'\n选好后点击“确认选择”。':''}\n\n文字备用：/answer ${custom} 你的回答`;
      let sent;
      try{
        sent=await this.bridge.queue(registration,origin,()=>pending.done?undefined:registration.adapter.question(origin,{status:pending.kind==='approval'?'waiting-approval':'waiting-user',text,context:pending.context,final:false,ui},actions));
      }catch(error){
        // A channel failure used to vanish here, leaving the user waiting ten
        // minutes for a card that was never delivered. It must be observable.
        this.diagnostic('channel.question-card-publish-failed',{reason:'send-failed',stage:'publish',provider:origin.provider,questionVersion:pending.version,code:error?.code});
        return;
      }
      if(sent?.messageId){pending.messages.set(actorKey(origin),sent.messageId);delivered++;}
      else if(!pending.done)this.diagnostic('channel.question-card-publish-failed',{reason:'empty-message-id',stage:'publish',provider:origin.provider,questionVersion:pending.version});
    }));
    // No channel accepted the card: fail fast instead of waiting for the timeout.
    if(!delivered&&!pending.done)this.settle(pending,failure('ASK_USER_DELIVERY_FAILED'));
  }
  async answer(request,custom){
    const row=this.bridge.core.store.db.prepare('SELECT * FROM interactions WHERE token=?').get(request.token);
    if(!row||row.consumed||row.expires_at<=Date.now()){
      this.diagnostic('channel.question-rejected',{reason:!row?'token-absent':row.consumed?'token-consumed':'token-expired'});
      // Only fail a still-live question if this was one of its CURRENT tokens.
      // A delayed click on an older question must never cancel the new one.
      for(const pending of this.pending.values())if(pending.tokens.has(request.token)){
        this.settle(pending,failure(row?.expires_at<=Date.now()?'ASK_USER_TIMEOUT':'ASK_USER_INVALIDATED'));
        break;
      }
      throw failure('stale-interaction');
    }
    const data=JSON.parse(row.payload),pending=this.pending.get(data.pendingId),origin=data.origin;
    if(!pending||pending.done||pending.req.signal?.aborted){
      this.diagnostic('channel.question-rejected',{reason:!pending?'pending-absent':pending.done?'pending-done':'request-aborted'});
      if(pending&&!pending.done)this.settle(pending,failure('ASK_USER_INVALIDATED'));
      throw failure('stale-interaction');
    }
    const verifiedThread=custom===undefined&&request.threadId===undefined&&pending.messages.get(actorKey(origin))===request.messageId?origin.threadId:request.threadId;
    if(request.provider!==origin.provider||request.accountId!==origin.accountId||
       request.userId!==origin.userId||request.conversationId!==origin.conversationId||
       (verifiedThread??'')!==(origin.threadId??''))throw failure('interaction-actor-mismatch');
    const operation=data.operation;
    if(pending.kind==='approval'){
      if(operation.type!=='approval')throw failure('approval-button-required');
      this.bridge.core.store.consumeInteraction(request.token,actorKey(origin));
      this.settle(pending,operation.value);return {accepted:true,completed:true};
    }
    const question=pending.req.questions[pending.index],options=(question.options??[]).slice(0,20);
    const toLabels=values=>{
      if(!Array.isArray(values)||values.length>20)throw failure('invalid-answer');
      const dedup=new Set();
      for(const value of values){
        if(typeof value!=='string'||!/^(0|[1-9][0-9]?)$/.test(value)||!options[Number(value)])throw failure('invalid-answer');
        dedup.add(options[Number(value)].label);
      }
      return [...dedup];
    };
    if(operation.type==='select'){
      if(!question.multiSelect)throw failure('invalid-answer');
      pending.selected=new Set(toLabels(request.values));
      return {accepted:true,completed:false,selectedCount:pending.selected.size};
    }
    let result;
    if(operation.type==='option'){
      if(question.multiSelect||!options.some(option=>option.label===operation.value))throw failure('invalid-answer');
      result={id:question.id,selected:[operation.value]};
    }else if(operation.type==='form'){
      if(!question.multiSelect)throw failure('invalid-answer');
      const selected=request.selectedValues===undefined?[...pending.selected]:toLabels(request.selectedValues);
      const freeform=String(request.customText??'').trim().slice(0,65536);
      if(!selected.length&&!freeform)throw failure('answer-required');
      result={id:question.id,selected,...(freeform?{custom:freeform}:{})};
    }else if(operation.type==='confirm'){
      if(!question.multiSelect||!pending.selected.size)throw failure('answer-required');
      result={id:question.id,selected:[...pending.selected]};
    }else if(operation.type==='custom'){
      const freeform=String(custom??request.customText??'').trim().slice(0,65536);
      if(!freeform)throw failure('answer-required');
      result={id:question.id,selected:[],custom:freeform};
    }else throw failure('invalid-answer');
    this.bridge.core.store.consumeInteraction(request.token,actorKey(origin));
    pending.answers.push(result);
    pending.index++;pending.selected.clear();
    if(pending.index===pending.req.questions.length){
      const answered=pending.answers.map((answer,index)=>({question:pending.req.questions[index]?.question??'',selected:answer.selected??[],...(answer.custom?{custom:answer.custom}:{})}));
      this.settle(pending,{answers:pending.answers});
      return {accepted:true,completed:true,answered};
    }
    await this.show(pending);
    return {accepted:true,completed:false};
  }
  answerText(origin,text){const match=text.match(/^([0-9a-f-]{36})\s+([\s\S]+)$/i);if(!match)throw failure('answer-format');return this.answer({...origin,token:match[1]},match[2]);}
  settle(pending,result){
    if(pending.done)return;pending.done=true;clearTimeout(pending.timer);pending.req.signal?.removeEventListener('abort',pending.abort);this.revoke(pending);this.pending.delete(pending.id);
    const state=[...this.bridge.turns.values()].find(item=>item.sessionId===pending.req.agent.session.id&&!item.terminal);
    if(state){state.waiting=false;state.status='thinking';}
    if(result instanceof Error){
      // Do not log answers or capability tokens. The rejected native question
      // resumes with an explicit tool failure when its agent is still alive.
      const code=result.code??'ASK_USER_FAILED';
      this.diagnostic('channel.question-settled',{state:'failed',code,ageSeconds:Math.round((Date.now()-pending.startedAt)/1000)});
      for(const origin of pending.origins){
        const messageId=pending.messages.get(actorKey(origin));
        const registration=this.bridge.adapters.get(JSON.stringify([origin.provider,origin.accountId]));
        if(messageId&&registration&&!registration.closed&&registration.adapter.questionClosed)
          void this.bridge.queue(registration,origin,()=>registration.adapter.questionClosed(origin,messageId,code))
            .catch(error=>this.diagnostic('channel.question-card-retire-failed',{reason:'send-failed',stage:'retire',provider:origin.provider,code:error?.code}));
      }
    }
    result instanceof Error?pending.reject(result):pending.resolve(result);
  }
  disconnected(){for(const pending of this.pending.values())if(!pending.origins.some(origin=>this.bridge.adapters.has(JSON.stringify([origin.provider,origin.accountId]))))this.settle(pending,pending.kind==='approval'?'unavailable':failure('ASK_USER_UNAVAILABLE'));}
  close(){for(const pending of this.pending.values())this.settle(pending,pending.kind==='approval'?'cancelled':failure('ASK_ABORTED'));}
}
