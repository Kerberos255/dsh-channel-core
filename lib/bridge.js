import { randomUUID } from 'node:crypto';
import { DeliveryStore, deliveryKey } from './delivery-store.js';
import { ChannelInteractions } from './interactions.js';
import { toolDetail } from './tool-detail.js';

const publicText = blocks => (blocks??[]).filter(block=>block.type==='text'||block.type==='refusal').map(block=>block.text??block.refusal??'').join('');
const keyOf = (provider,accountId) => JSON.stringify([provider,accountId]);

/** Native events drive all channels; this class owns only external presentation and delivery. */
export class ChannelBridge {
  constructor(ctx, core) {
    this.ctx=ctx;this.core=core;this.store=new DeliveryStore(core.store.db);
    this.adapters=new Map();this.turns=new Map();this.running=new Set();this.closed=false;
    this.interactions=new ChannelInteractions(this);this.store.prune();
    this.disposers=[
      ctx.on('agent/inbox/claimed',({agent,message,turn})=>this.claimed(agent.session,message.source?.rpcId,turn),{global:true}),
      ctx.on('session/event',(session,event)=>this.event(session,event),{global:true}),
      ctx.on('agent/assistant-stream',({agent,frame})=>this.stream(agent.session,frame),{global:true}),
      ctx.on('user-questions/request',(req,next)=>this.interactions.request(req,next),{global:true,prepend:true}),
      ctx.on('approval/request',(req,next)=>this.interactions.request(req,next,'approval'),{global:true,prepend:true}),
      ctx.on('tools/execute',async(exec,next)=>{
        const state=[...this.turns.values()].find(item=>item.sessionId===exec.agent?.session.id&&!item.terminal);
        if(!state)return next();
        const activity={name:exec.name,status:'running',detail:toolDetail(exec.name,exec.arguments)};
        state.activity.push(activity);if(state.activity.length>20)state.activity.shift();
        state.tools??=new Map();state.tools.set(exec.callId,exec.name);state.tool=exec.name;state.status='tool-running';
        for(const origin of this.store.origins(state.sessionId,state.turn))this.progress(origin,state);
        try{const result=await next();activity.status=result?.isError?'failed':'completed';return result;}
        catch(error){activity.status='failed';throw error;}
        finally{
          state.tools.delete(exec.callId);state.tool=[...state.tools.values()].at(-1);state.status=state.tool?'tool-running':'thinking';
          for(const origin of this.store.origins(state.sessionId,state.turn))this.progress(origin,state);
        }
      },{global:true,prepend:true}),
    ];
  }
  register(provider,accountId,adapter) {
    if(this.closed) throw new Error('channel-bridge-closed');
    const key=keyOf(provider,accountId);
    if(this.adapters.has(key))throw new Error('channel-account-already-connected');
    const registration={adapter,generation:randomUUID(),tails:new Map(),timers:new Map(),progress:new Map(),closed:false};
    this.adapters.set(key,registration);
    const recovery=(async()=>{while(!registration.closed){const rows=this.store.pending(provider,accountId);if(!rows.length)break;await Promise.allSettled(rows.map(row=>this.deliver(row,registration)));}})();
    this.running.add(recovery);recovery.finally(()=>this.running.delete(recovery)).catch(()=>{});
    return async()=>{
      registration.closed=true;
      if(this.adapters.get(key)===registration)this.adapters.delete(key);
      this.interactions.disconnected();
      for(const timer of registration.timers.values())clearTimeout(timer);
      registration.timers.clear();
      await recovery.catch(()=>{});
      await Promise.allSettled(registration.tails.values());
    };
  }
  claimed(session,requestId,turn) {
    if(!requestId)return;
    const receipt=this.core.store.receipt(requestId);
    if(!receipt||receipt.session_id!==session.id)return;
    const origin=JSON.parse(receipt.origin);
    if(!origin.accountId||!origin.conversationId)return;
    this.store.origin(requestId,session.id,turn,origin);
    const state=this.state(session.id,turn);
    for(const item of this.store.origins(session.id,turn))this.progress(item,state);
  }
  state(sessionId,turn) {
    const key=JSON.stringify([sessionId,turn]);
    let state=this.turns.get(key);
    if(!state){state={sessionId,turn,status:'thinking',text:'',committed:'',activity:[],commentary:'',narration:'',stream:null,terminal:false};this.turns.set(key,state);}
    return state;
  }
  event(session,event) {
    if(this.closed)return;
    if(event.type==='turn/start'){this.state(session.id,event.data.turn);return;}
    if(!['assistant/message','assistant/attempt','turn/end'].includes(event.type))return;
    const turn=event.data?.turn;
    if(!Number.isSafeInteger(turn))return;
    const state=this.state(session.id,turn);
    if(state.terminal)return;
    if(event.type==='assistant/message'){
      const text=publicText(event.data.message?.content);
      if(text)state.committed+=(state.committed?'\n\n':'')+text;
      state.text=state.committed;state.status='generating';state.stream=null;
      const blocks=event.data.message?.content??[];
      // Reasoning is kept only as a bounded tail for the opt-in narration line.
      const reasoning=blocks.filter(block=>block.type==='reasoning').map(block=>block.text??'').join('');
      if(reasoning)state.narration=reasoning.slice(-4096);
      const tools=blocks.filter(block=>block.type==='tool-call');
      if(tools.length){state.status='tool-running';state.tool=tools.at(-1).name??tools.at(-1).toolName;if(text)state.commentary=text.slice(0,4096);}
    }else if(event.type==='assistant/attempt'){state.stream=null;state.text=state.committed;return;}
    else if(event.type==='turn/end'){
      state.terminal=true;
      state.status=event.data.reason?.kind==='aborted'?'cancelled':['error','blocked'].includes(event.data.reason?.kind)?'failed':event.data.reason?.kind==='max-tokens'?'truncated':'completed';
      for(const origin of this.store.origins(session.id,turn)){
        const id=deliveryKey([session.id,turn,origin.provider,origin.accountId,origin.conversationId,origin.threadId??'',origin.messageId]);
        const body={sessionId:session.id,turn,status:state.status,text:state.committed||state.text||({cancelled:'本轮已停止。',failed:'本轮执行失败，请在 DSH 中查看详情。',completed:'本轮已完成。',truncated:'本轮达到输出限制。'}[state.status]),final:true};
        const row=this.store.enqueue(id,origin,body),registration=this.adapters.get(keyOf(origin.provider,origin.accountId));
        if(registration)this.deliver(row,registration);
      }
      this.turns.delete(JSON.stringify([session.id,turn]));return;
    }else return;
    for(const origin of this.store.origins(session.id,turn))this.progress(origin,state);
  }
  stream(session,frame) {
    if(this.closed)return;
    let state;
    if(frame.type==='start'){
      state=this.state(session.id,frame.turn);
      state.text=state.committed;
      state.stream={attemptId:frame.attemptId,revision:frame.revision,nextIndex:0,text:'',blocks:new Map()};
      return;
    }
    state=[...this.turns.values()].find(value=>value.sessionId===session.id&&value.stream?.attemptId===frame.attemptId&&value.stream.revision===frame.revision);
    if(!state||state.terminal)return;
    const stream=state.stream;
    if(frame.type==='end'){if(frame.outcome?.kind==='abandoned'){state.stream=null;state.text=state.committed;}return;}
    if(frame.index!==stream.nextIndex){state.stream=null;state.text=state.committed;return;}
    stream.nextIndex++;
    const chunk=frame.chunk;
    if(chunk.type==='block-start')stream.blocks.set(chunk.index,chunk.blockType);
    if(chunk.type==='text-delta'&&stream.blocks.get(chunk.index)==='text'){
      stream.text+=chunk.text;
      if(stream.text.length>128*1024)stream.text=stream.text.slice(0,128*1024);
      state.text=state.committed+stream.text;state.status='generating';
      for(const origin of this.store.origins(session.id,state.turn))this.progress(origin,state);
    }
    if(chunk.type==='reasoning-delta'){
      const piece=typeof chunk.text==='string'?chunk.text:'';
      if(piece){
        state.narration=(state.narration+piece).slice(-4096);
        for(const origin of this.store.origins(session.id,state.turn))this.progress(origin,state);
      }
    }
  }
  progress(origin,state) {
    if(state.waiting||state.terminal)return;
    const registration=this.adapters.get(keyOf(origin.provider,origin.accountId));
    if(!registration||registration.closed||!registration.adapter.progress)return;
    const key=deliveryKey([state.sessionId,state.turn,origin.conversationId,origin.threadId??'',origin.messageId]);
    registration.progress.set(key,{origin,body:{sessionId:state.sessionId,turn:state.turn,status:state.status,text:state.tool&&state.status==='tool-running'?'正在执行：'+state.tool:state.text,activity:{tools:state.activity.map(item=>({...item})),commentary:state.commentary,narration:state.narration},final:false}});
    if(registration.timers.has(key))return;
    const timer=setTimeout(()=>{
      registration.timers.delete(key);
      const update=registration.progress.get(key);registration.progress.delete(key);
      if(update&&!state.terminal&&!state.waiting&&!registration.closed)this.queue(registration,origin,()=>registration.adapter.progress(update.origin,update.body));
    },registration.adapter.throttleMs??600);
    timer.unref?.();registration.timers.set(key,timer);
  }
  reply(origin,body){const row=this.store.enqueue(body.id,origin,body),registration=this.adapters.get(keyOf(origin.provider,origin.accountId));if(registration)this.deliver(row,registration);return row;}
  answer(request){return this.interactions.answer(request);}
  answerText(origin,text){return this.interactions.answerText(origin,text);}
  queue(registration,origin,action) {
    const key=JSON.stringify([origin.conversationId,origin.threadId??'']);
    const task=(registration.tails.get(key)??Promise.resolve()).catch(()=>{}).then(()=>registration.closed?undefined:action());
    registration.tails.set(key,task);this.running.add(task);
    task.finally(()=>{this.running.delete(task);if(registration.tails.get(key)===task)registration.tails.delete(key);}).catch(()=>{});
    return task;
  }
  deliver(row,registration) {
    if(row.state!=='pending'||registration.closed)return;
    const origin=JSON.parse(row.origin),body=JSON.parse(row.body);
    return this.queue(registration,origin,async()=>{
      if(!this.store.claim(row.id))return;
      try{
        const result=await registration.adapter.send(origin,{...body,id:row.id});
        this.store.finish(row.id,'sent',result?.messageId??null);
      }catch(error){
        this.store.finish(row.id,error.definitelyNotSent?'failed':'uncertain',null,error.code??'delivery-failed');
      }
    });
  }
  async idle(){while(this.running.size)await Promise.allSettled(this.running);}
  async close(){
    this.closed=true;this.interactions.close();this.disposers.forEach(dispose=>dispose());
    for(const registration of this.adapters.values()){registration.closed=true;for(const timer of registration.timers.values())clearTimeout(timer);}
    this.adapters.clear();await this.idle();this.turns.clear();
  }
}
