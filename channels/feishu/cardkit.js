/** CardKit API adapter: scoped to Feishu, no session policy. */
const checked=(kind,res)=>{if(res?.code&&res.code!==0)throw Object.assign(new Error('feishu-cardkit-'+kind+'-'+res.code),{code:res.code});return res;};
/** The progress text has a stable element ID across structural updates. */
export function streamingCard(payload){
 return {...payload,config:{...payload.config,streaming_mode:true},
  body:{...payload.body,elements:payload.body.elements.map((v,i)=>i===0?
    {...v,element_id:'dsh_progress_text'}:v)}};
}
export function createCardKitChannel(channel){
 const client=channel.rawClient,kit=client?.cardkit?.v1;
 if(!kit?.card?.create||!kit?.card?.update||!kit?.card?.settings||!kit?.cardElement?.content||!client?.im?.v1?.message?.reply)return null;
 const run=async(kind,call)=>checked(kind,await call());
 return {
  async create(origin,payload){
   const initial=streamingCard(payload);
   let cardId;
   try{
    const res=await run('create',()=>kit.card.create({data:{type:'card_json',data:JSON.stringify(initial)}}));
    cardId=res?.data?.card_id??res?.card_id;
    if(!cardId)throw new Error('feishu-cardkit-missing-card-id');
   }catch(error){
    // No IM message has been attempted: reverting to Patch cannot duplicate.
    error.cardKitFallbackSafe=true;
    throw error;
   }
   const content=JSON.stringify({type:'card',data:{card_id:cardId}});
   const sent=origin.messageId?
    await run('reply',()=>client.im.v1.message.reply({path:{message_id:origin.messageId},
     data:{msg_type:'interactive',content,reply_in_thread:!!origin.threadId}})):
    await run('send',()=>client.im.v1.message.create({params:{receive_id_type:'chat_id'},data:{receive_id:origin.conversationId,msg_type:'interactive',content}}));
   const messageId=sent?.data?.message_id;
   if(!messageId)throw new Error('feishu-cardkit-ambiguous-message-id');
   return {messageId,cardId,sequence:1,streaming:true,text:initial.body.elements[0].content,
    structural:JSON.stringify({header:initial.header,extra:initial.body.elements.slice(1)})};
  },
  async text(record,content){
   if(record.text===content)return;
   const sequence=record.sequence+1;
   record.sequence=sequence; // sequence must not be reused after an ambiguous network error
   await run('content',()=>kit.cardElement.content({data:{content,sequence},path:{card_id:record.cardId,element_id:'dsh_progress_text'}}));
   record.sequence=sequence;record.text=content;
  },
  async update(record,payload){
   const sequence=record.sequence+1;
   record.sequence=sequence;
   await run('update',()=>kit.card.update({path:{card_id:record.cardId},data:{card:{type:'card_json',data:JSON.stringify(payload)},sequence}}));
   record.sequence=sequence;record.text=payload.body?.elements?.[0]?.content;
   record.structural=JSON.stringify({header:payload.header,extra:payload.body?.elements?.slice(1)});
  },
  async close(record){
   if(!record.streaming)return;
   const sequence=record.sequence+1;
   record.sequence=sequence;
   await run('settings',()=>kit.card.settings({path:{card_id:record.cardId},data:{settings:JSON.stringify({streaming_mode:false}),sequence}}));
   record.sequence=sequence;record.streaming=false;
  },
 };
}
