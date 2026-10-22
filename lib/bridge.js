import { randomUUID } from 'node:crypto';
import { DeliveryStore, deliveryKey } from './delivery-store.js';
import { ChannelInteractions } from './interactions.js';
import { toolDetail } from './tool-detail.js';

const publicText = blocks => (blocks??[]).filter(block=>block.type==='text'||block.type==='refusal').map(block=>block.text??block.refusal??'').join('');
const keyOf = (provider,accountId) => JSON.stringify([provider,accountId]);
const REASONING_BUFFER_LIMIT=32768;
const TIMELINE_LIMIT=60;
// Native Steer segmentation: a Feishu interjection freezes the card that was
// already streaming and continues on a card anchored to the newest message.
const conversationKey=origin=>JSON.stringify([origin.provider,origin.accountId,origin.conversationId,origin.threadId??'']);
const pushTimeline=(state,item)=>{
  if(item.seq===undefined)item.seq=++state.timelineSeq;
  state.timeline.push(item);
  if(state.timeline.length>TIMELINE_LIMIT)state.timeline.shift();
};
const flushDraft=(state)=>{
  const next=state.narration.slice(state.narrationCursor);
  if(next.trim())pushTimeline(state,{type:'draft',text:next.trim().slice(-6000)});
  state.narrationCursor=state.narration.length;
};
const draftEntries=state=>{
  const committed=state.timeline.filter(item=>item.type==='draft').map(item=>item.text);
  const pending=state.narration.slice(state.narrationCursor).trim();
  return pending?[...committed,pending.slice(-6000)]:committed;
};
const trimDrafts=(entries,max=18000)=>{
  const result=[];let remaining=max,wasClipped=false;
  for(let i=entries.length-1;i>=0&&remaining>0;i--){
    const entry=entries[i],keep=entry.slice(-remaining);
    if(keep.length<entry.length)wasClipped=true;
    result.unshift(keep);remaining-=keep.length;
  }
  return {drafts:result,truncated:wasClipped||result.length<entries.length};
};

// A completed native reasoning block may overlap text already received as
// reasoning deltas. Append only its new suffix, never a second copy.
const reconcileReasoning=(state,text)=>{
  if(typeof text!=='string'||!text)return;
  const previous=state.narration;
  if(previous.endsWith(text))return;
  // A repeated native commit can include a block captured earlier, rather
  // than only the latest delta. Avoid duplication without changing ordering.
  if(text.length>=24&&previous.includes(text))return;
  // Prefix table: linear-time overlap detection for long reasoning blocks.
  const prefix=new Uint32Array(text.length);
  for(let i=1,j=0;i<text.length;i++){
    while(j&&text[i]!==text[j])j=prefix[j-1];
    if(text[i]===text[j])j++;
    prefix[i]=j;
  }
  let overlap=0;
  const tail=previous.slice(-text.length);
  for(let i=0;i<tail.length;i++){
    const char=tail[i];
    while(overlap&&char!==text[overlap])overlap=prefix[overlap-1];
    if(char===text[overlap])overlap++;
    if(overlap===text.length)overlap=prefix[overlap-1];
  }
  if(overlap<text.length)updateReasoning(state,text.slice(overlap));
};
const updateReasoning=(state,content,replace=false)=>{
  const next=(replace?'':state.narration)+content;
  if(next.length>REASONING_BUFFER_LIMIT){
    let start=next.length-REASONING_BUFFER_LIMIT;
    if(/[\uDC00-\uDFFF]/.test(next[start]))start++;
    state.narration=next.slice(start);
    state.narrationCursor=Math.max(0,state.narrationCursor-start);
    state.narrationTruncated=true;
  }else{
    state.narration=next;
    if(replace){state.narrationCursor=0;state.narrationTruncated=false;}
  }
};

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
        flushDraft(state);
        const activity={name:exec.name,status:'running',detail:toolDetail(exec.name,exec.arguments)};
        pushTimeline(state,{type:'tool',activity});
        state.activity.push(activity);if(state.activity.length>20)state.activity.shift();
        state.tools??=new Map();state.tools.set(exec.callId,exec.name);state.tool=exec.name;state.status='tool-running';
        for(const origin of this.outputOrigins(state.sessionId,state.turn))this.progress(origin,state);
        try{const result=await next();activity.status=result?.isError?'failed':'completed';return result;}
        catch(error){activity.status='failed';throw error;}
        finally{
          state.tools.delete(exec.callId);state.tool=[...state.tools.values()].at(-1);state.status=state.tool?'tool-running':'thinking';
          for(const origin of this.outputOrigins(state.sessionId,state.turn))this.progress(origin,state);
        }
      },{global:true,prepend:true}),
    ];
  }
  register(provider,accountId,adapter) {
    if(this.closed) throw new Error('channel-bridge-closed');
    const key=keyOf(provider,accountId);
    if(this.adapters.has(key))throw new Error('channel-account-already-connected');
    const registration={adapter,generation:randomUUID(),tails:new Map(),timers:new Map(),progress:new Map(),progressQueued:new Set(),closed:false};
    this.adapters.set(key,registration);
    const recovery=(async()=>{while(!registration.closed){const rows=this.store.pending(provider,accountId);if(!rows.length)break;await Promise.allSettled(rows.map(row=>this.deliver(row,registration)));}})();
    this.running.add(recovery);recovery.finally(()=>this.running.delete(recovery)).catch(()=>{});
    return async()=>{
      registration.closed=true;
      if(this.adapters.get(key)===registration)this.adapters.delete(key);
      this.interactions.disconnected();
      for(const timer of registration.timers.values())clearTimeout(timer);
      registration.timers.clear();registration.progress.clear();
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
    const originKey=JSON.stringify([origin.provider,origin.accountId,origin.conversationId,origin.threadId??'',origin.messageId]);
    state.usedOrigins??=[];
    if(!state.usedOrigins.some(item=>item.key===originKey))state.usedOrigins.push({key:originKey,origin});
    this.noteSteerClaim(state,origin);
    for(const item of this.outputOrigins(session.id,turn))this.progress(item,state);
  }
  /** Native Steer can claim multiple inputs within the same Turn.
   * A conversation has one visible progress/final response per Turn;
   * input receipts stay intact for attribution and replay.
   */
  outputOrigins(sessionId,turn,latest=false) {
    const positions=new Map(),targets=[];
    for(const origin of this.store.origins(sessionId,turn)){
      const key=JSON.stringify([origin.provider,origin.accountId,origin.conversationId,origin.threadId??'']);
      if(!positions.has(key)){positions.set(key,targets.length);targets.push(origin);}
      else if(latest)targets[positions.get(key)]=origin;
    }
    if(!latest){
      const state=this.turns.get(JSON.stringify([sessionId,turn]));
      if(state?.activeOrigins?.size)
        return targets.map(item=>item.provider==='feishu'?(state.activeOrigins.get(conversationKey(item))??item):item);
    }
    return targets;
  }
  /** A native Steer claims another input inside the same Turn. Feishu freezes the
   * earlier card and continues on a card anchored to the newest user message. */
  noteSteerClaim(state,origin) {
    if(origin.provider!=='feishu'||state.terminal)return;
    const key=conversationKey(origin);
    const seen=state.originCounts.get(key)??0;
    state.originCounts.set(key,seen+1);
    if(seen===0){if(!state.activeOrigins.has(key))state.activeOrigins.set(key,origin);return;}
    const previous=state.activeOrigins.get(key)??origin;
    const cut={kind:'steer',stream:state.stream,streamCursor:state.stream?.text?.length??0,
      narrationCursor:state.narration.length,commentaryCursor:(state.commentary??'').length,anchorOrigin:origin};
    pushTimeline(state,{type:'steer-boundary',anchorOrigin:origin});
    cut.seq=state.timeline[state.timeline.length-1].seq;
    state.steerCut=cut;
    state.activeOrigins.set(key,origin);
    const registration=this.adapters.get(keyOf(origin.provider,origin.accountId));
    // Freeze off the send queue: the new segment must not wait for the old card to
    // finish closing. The transport serializes per card id, so sequences stay safe.
    if(registration?.adapter.cutProgress)
      void Promise.resolve()
        .then(()=>registration.adapter.cutProgress({sessionId:state.sessionId,turn:state.turn,previousOrigin:previous,nextOrigin:origin}))
        .catch(()=>{});
  }
  /** Latest visible boundary, whichever mechanism produced it. */
  effectiveCut(state) {
    const candidates=[];
    if(state.steerCut)candidates.push(state.steerCut);
    const index=state.timeline.findLastIndex(item=>item.type==='question-boundary');
    if(index>=0)candidates.push({kind:'question',seq:state.timeline[index].seq??-1,stream:state.questionStream,
      streamCursor:state.questionStreamCursor??0,narrationCursor:state.questionNarrationCursor??0,commentaryCursor:0,suppressCommentary:true});
    if(!candidates.length)return null;
    return candidates.reduce((a,b)=>((b.seq??-1)>=(a.seq??-1)?b:a));
  }
  state(sessionId,turn) {
    const key=JSON.stringify([sessionId,turn]);
    let state=this.turns.get(key);
    if(!state){state={sessionId,turn,startedAt:Date.now(),status:'thinking',text:'',committed:'',lastReplyText:'',activity:[],timeline:[],commentary:'',narration:'',narrationCursor:0,narrationTruncated:false,stream:null,terminal:false,timelineSeq:0,steerCut:null,activeOrigins:new Map(),originCounts:new Map()};this.turns.set(key,state);}
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
      if(text){state.committed+=(state.committed?'\n\n':'')+text;pushTimeline(state,{type:'public-draft',text:text.slice(-6000)});}
      state.text=state.committed;state.status='generating';state.stream=null;
      const blocks=event.data.message?.content??[];
      // A native tool-call message can contain public pre-tool commentary.
      // It belongs in the progress timeline, not in Feishu's final answer.
      if(blocks.some(block=>block.type==='tool-call'))state.lastReplyText='';
      else if(text)state.lastReplyText=text;
      // Capture all available reasoning up to a bounded in-memory buffer.
      const reasoning=blocks.filter(block=>block.type==='reasoning').map(block=>block.text??'').join('');
      // Committed blocks may repeat the already-streamed reasoning; do not double it.
      if(reasoning)reconcileReasoning(state,reasoning);
      flushDraft(state);
      const tools=blocks.filter(block=>block.type==='tool-call');
      if(tools.length){state.status='tool-running';state.tool=tools.at(-1).name??tools.at(-1).toolName;if(text)state.commentary=text.slice(0,4096);}
    }else if(event.type==='assistant/attempt'){state.stream=null;state.text=state.committed;return;}
    else if(event.type==='turn/end'){
      flushDraft(state);
      state.terminal=true;
      state.status=event.data.reason?.kind==='aborted'?'cancelled':['error','blocked'].includes(event.data.reason?.kind)?'failed':event.data.reason?.kind==='max-tokens'?'truncated':'completed';
      const progressTargets=this.outputOrigins(session.id,turn),latestTargets=this.outputOrigins(session.id,turn,true);
      // Retire pending progress before enqueuing finals; an already running
      // Discord edit completes first, but no queued stale snapshot can follow it.
      for(const progressOrigin of progressTargets){
        const adapter=this.adapters.get(keyOf(progressOrigin.provider,progressOrigin.accountId));
        if(adapter?.adapter.coalesceProgress)this.discardProgress(adapter,state,progressOrigin);
      }
      for(const [index,progressOrigin] of progressTargets.entries()){
        // A native Steer stays in this Turn, but its final must follow the last
        // user message on Discord. Keep progress on the original message.
        const latest=latestTargets[index];
        // Feishu keeps progress on the original card but, once this Turn was
        // steered, the final answer must follow the newest user message too.
        const steered=progressOrigin.provider==='feishu'&&!!state.steerCut;
        const origin=progressOrigin.provider==='discord'||steered?latest:progressOrigin;
        const id=deliveryKey([session.id,turn,origin.provider,origin.accountId,origin.conversationId,origin.threadId??'',origin.messageId]);
        const registration=this.adapters.get(keyOf(origin.provider,origin.accountId));
        const owner=this.core.store.owner?.(origin.provider,origin.accountId);
        const verifiedOwner=origin.kind==='dm'&&owner?.userId===origin.userId;
        const showThinking=verifiedOwner&&registration?.adapter.showNarration===true;
        const showPublicDrafts=verifiedOwner&&registration?.adapter.showPublicDrafts===true;
        // The pre-question prose already has its own frozen Feishu card.
        // The retained post-question progress card may contain only the later
        // committed drafts and reasoning, not a second copy of that prose.
        // Final delivery obeys the same segment rule as the live card, so an
        // interjection cut (or an Ask User boundary) never repeats shown text.
        const finalCut=origin.provider==='feishu'?this.effectiveCut(state):null;
        const finalTimeline=finalCut?state.timeline.filter(item=>(item.seq??0)>finalCut.seq):state.timeline;
        const reasoningEntries=finalCut?[
          ...finalTimeline.filter(item=>item.type==='draft').map(item=>item.text),
          state.narration.slice(Math.max(state.narrationCursor,finalCut.narrationCursor??0)).trim()
        ].filter(Boolean):draftEntries(state);
        const history=showThinking?trimDrafts(reasoningEntries):null;
        const publicMessages=finalTimeline.filter(item=>item.type==='public-draft').map(item=>item.text);
        const publicHistory=showPublicDrafts?(state.lastReplyText?publicMessages.slice(0,-1):publicMessages):[];
        const fullText=state.committed||state.text;
        const finalReply=state.lastReplyText;
        // The native assistant/message boundary is the source of truth:
        // previous committed public messages are progress drafts, and only a
        // separate last non-tool message is the completed public reply.
        const hasSeparateReply=origin.provider==='discord'&&state.status==='completed'&&
          !!finalReply&&fullText.endsWith('\n\n'+finalReply);
        const publicPrelude=hasSeparateReply&&showPublicDrafts?fullText.slice(0,-finalReply.length-2):'';
        // Feishu always sends only the last reply. Discord keeps the full text so
        // the transport can split draft from answer, but when the draft switch is
        // off the committed drafts must not leak into the final message either.
        const replyOnly=origin.provider==='feishu'||(hasSeparateReply&&!showPublicDrafts);
        const body={sessionId:session.id,turn,status:state.status,durationMs:Date.now()-state.startedAt,text:(replyOnly?state.lastReplyText:fullText)||({cancelled:'本轮已停止。',failed:'本轮执行失败，请在 DSH 中查看详情。',completed:'本轮已完成。',truncated:'本轮达到输出限制。'}[state.status]),final:true,
          ...(publicPrelude?{draftPrelude:publicPrelude,finalReplyText:finalReply}:{}),
          ...(history?.drafts.length?{drafts:history.drafts,draftsTruncated:history.truncated||state.narrationTruncated}:{}),
          ...(publicHistory.length?{publicDrafts:publicHistory}:{}),
          ...(origin.provider==='discord'&&progressOrigin.messageId!==origin.messageId?{progressOriginMessageId:progressOrigin.messageId}:{})};
        const row=this.store.enqueue(id,origin,body);
        if(registration)this.deliver(row,registration);
      }
      const activeKeys=new Set(this.outputOrigins(session.id,turn).map(item=>JSON.stringify([item.provider,item.accountId,item.conversationId,item.threadId??'',item.messageId])));
      for(const used of state.usedOrigins??[]){
        if(activeKeys.has(used.key))continue;
        const registration=this.adapters.get(keyOf(used.origin.provider,used.origin.accountId));
        if(registration?.adapter.cutProgress)
          void Promise.resolve().then(()=>registration.adapter.cutProgress({sessionId:session.id,turn,previousOrigin:used.origin,retire:true})).catch(()=>{});
      }
      this.turns.delete(JSON.stringify([session.id,turn]));return;
    }else return;
    for(const origin of this.outputOrigins(session.id,turn))this.progress(origin,state);
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
    if(frame.type==='end'){if(frame.outcome?.kind==='abandoned'){state.stream=null;state.text=state.committed;state.narration=state.narration.slice(0,state.narrationCursor);}return;}
    if(frame.index!==stream.nextIndex){state.stream=null;state.text=state.committed;return;}
    stream.nextIndex++;
    const chunk=frame.chunk;
    if(chunk.type==='block-start')stream.blocks.set(chunk.index,chunk.blockType);
    if(chunk.type==='text-delta'&&stream.blocks.get(chunk.index)==='text'){
      stream.text+=chunk.text;
      if(stream.text.length>128*1024)stream.text=stream.text.slice(0,128*1024);
      state.text=state.committed+stream.text;state.status='generating';
      for(const origin of this.outputOrigins(session.id,state.turn))this.progress(origin,state);
    }
    if(chunk.type==='block-end'&&chunk.block?.type==='reasoning'&&typeof chunk.block.text==='string'&&chunk.block.text&&!state.narration.endsWith(chunk.block.text)){
      reconcileReasoning(state,chunk.block.text);
      for(const origin of this.outputOrigins(session.id,state.turn))this.progress(origin,state);
    }
    if(chunk.type==='reasoning-delta'){
      const piece=typeof chunk.text==='string'?chunk.text:'';
      if(piece){
        updateReasoning(state,piece);
        for(const origin of this.outputOrigins(session.id,state.turn))this.progress(origin,state);
      }
    }
  }
  discardProgress(registration,state,origin) {
    const key=deliveryKey([state.sessionId,state.turn,origin.conversationId,origin.threadId??'',origin.messageId]);
    const timer=registration.timers.get(key);
    if(timer)clearTimeout(timer);
    registration.timers.delete(key);
    registration.progress.delete(key);
    // Do not clear progressQueued: the queued/in-flight task owns that marker.
  }
  progress(origin,state) {
    if(state.waiting||state.terminal)return;
    const registration=this.adapters.get(keyOf(origin.provider,origin.accountId));
    if(!registration||registration.closed||!registration.adapter.progress)return;
    const key=deliveryKey([state.sessionId,state.turn,origin.conversationId,origin.threadId??'',origin.messageId]);
    // Reasoning can contain unreviewed content. Never post it to groups or strangers.
    const owner=this.core.store.owner?.(origin.provider,origin.accountId);
    const reasoningAllowed=origin.kind==='dm'&&owner?.userId===origin.userId;
    // Native Turn timelines include earlier committed output. After Ask User,
    // Feishu must render only new progress; the original prose is already
    // frozen into a separate process card. Keep full state for final delivery.
    const questionCut=state.timeline.findLastIndex(item=>item.type==='question-boundary');
    const cut=this.effectiveCut(state);
    const visibleTimeline=cut
      ?state.timeline.filter(item=>(item.seq??0)>cut.seq)
      :questionCut<0?state.timeline:state.timeline.slice(questionCut+1);
    const liveStream=state.stream?.text??'';
    const liveText=cut
      ?(state.stream!==cut.stream?liveStream:liveStream.slice(cut.streamCursor??0))
      :(questionCut<0||state.stream!==state.questionStream?liveStream:liveStream.slice(state.questionStreamCursor??0));
    const liveReasoning=state.narration.slice(cut?Math.max(state.narrationCursor,cut.narrationCursor??0):(questionCut<0?state.narrationCursor:Math.max(state.narrationCursor,state.questionNarrationCursor??0)));
    const visibleCommentary=cut?(cut.suppressCommentary?'':(state.commentary??'').slice(cut.commentaryCursor??0)):(questionCut<0?state.commentary:'');
    // A freshly split segment must not open a card that only says "thinking".
    // Ask User keeps its reset snapshot: that card is the question's successor.
    const segmentContent=visibleTimeline.length>0||visibleCommentary||(reasoningAllowed&&(liveText||liveReasoning));
    if(cut?.kind==='steer'&&!segmentContent)return;
    registration.progress.set(key,{origin,body:{sessionId:state.sessionId,turn:state.turn,status:state.status,durationMs:Date.now()-state.startedAt,text:state.tool&&state.status==='tool-running'?'正在执行：'+state.tool:state.text,activity:{tools:state.activity.map(item=>({...item})),timeline:visibleTimeline.filter(item=>item.type!=='draft'||reasoningAllowed).map(item=>item.type==='tool'?{type:'tool',activity:{...item.activity}}:{...item}),activeDraft:reasoningAllowed?liveReasoning:'',activeTextDraft:reasoningAllowed?liveText:'',commentary:visibleCommentary,narration:reasoningAllowed?state.narration:'',narrationTruncated:reasoningAllowed&&state.narrationTruncated},final:false}});
    if(registration.timers.has(key))return;
    const timer=setTimeout(()=>{
      registration.timers.delete(key);
      if(registration.adapter.coalesceProgress){
        // One queued/in-flight sender per Turn and origin. The map continues to
        // hold only the newest unsent snapshot, even while Discord.js is
        // waiting for a rate-limit bucket.
        if(state.terminal||state.waiting||registration.closed){registration.progress.delete(key);return;}
        if(registration.progressQueued.has(key))return;
        registration.progressQueued.add(key);
        void this.queue(registration,origin,async()=>{
          try {
            while(!registration.closed&&!state.terminal&&!state.waiting){
              const latest=registration.progress.get(key);
              registration.progress.delete(key);
              if(!latest)break;
              await registration.adapter.progress(latest.origin,latest.body);
            }
          }finally{
            registration.progressQueued.delete(key);
            // A rejected edit is not replayed blindly; the next live model
            // event can schedule a fresh snapshot. Final delivery stays intact.
            registration.progress.delete(key);
          }
        });
        return;
      }
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
        if(body.final&&!body.proactive)this.ctx.get?.('pluginDiagnostics')?.record(
          'dsh-channel-core','info','channel.final-delivered',
          {provider:origin.provider,state:'sent',sessionId:body.sessionId,turn:body.turn});
      }catch(error){
        const status=error.definitelyNotSent?'failed':'uncertain';
        const code=String(error?.code??'delivery-failed').slice(0,96);
        this.store.finish(row.id,status,null,code);
        this.ctx.get?.('pluginDiagnostics')?.record('dsh-channel-core','error',
          body.final?'channel.final-delivery-failed':'channel.delivery-failed',
          {provider:origin.provider,state:status,code,sessionId:body.sessionId,turn:body.turn,
           cardEngine:registration.adapter?.details?.()?.feishuCardEngine});
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
