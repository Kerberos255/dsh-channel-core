/** Feishu bot-menu push events are not IM messages and have no chat_id. */
export function parseStatusMenuEvent(raw){
  const event=raw?.event??raw;
  if(!event||event.event_key!=='status')return null;
  const userId=event.operator?.operator_id?.open_id??event.operator?.open_id;
  if(typeof userId!=='string'||!/^ou_[A-Za-z0-9_-]{6,200}$/.test(userId))return null;
  const eventId=raw?.header?.event_id??raw?.event_id??event.event_id;
  const eventTime=event.timestamp??event.menu_timestamp??event.create_time??raw?.header?.create_time;
  const fingerprint=typeof eventId==='string'&&eventId.length<=256&&eventId?
    'event:'+eventId:typeof eventTime==='string'&&eventTime.length<=48&&eventTime?
    'time:'+userId+':'+eventTime:'recent:'+userId;
  return {userId,fingerprint,expiresAfter:fingerprint.startsWith('recent:')?2000:60000};
}
export function installStatusMenu(channel,{onStatus,signal,state}){
  if(typeof channel.dispatcher?.register!=='function')return false;
  const seen=new Map();
  channel.dispatcher.register({'application.bot.menu_v6':async raw=>{
    if(signal.aborted)return;
    const menu=parseStatusMenuEvent(raw);
    if(!menu)return;
    const now=Date.now(),old=seen.get(menu.fingerprint);
    if(old&&now-old<menu.expiresAfter)return;
    seen.set(menu.fingerprint,now);
    for(const [k,t] of seen)if(now-t>60000)seen.delete(k);
    if(seen.size>256)seen.delete(seen.keys().next().value);
    try{
      // onStatus authenticates the channel owner; never send private data to strangers.
      const result=await onStatus?.({userId:menu.userId,eventKey:'status'});
      if(!result?.card||signal.aborted)return;
      const content=JSON.stringify(result.card);
      if(result.card.schema!=='2.0'||Buffer.byteLength(content,'utf8')>24000)
        throw new Error('feishu-status-card-invalid');
      const response=await channel.rawClient.im.v1.message.create({
        params:{receive_id_type:'open_id'},
        data:{receive_id:menu.userId,msg_type:'interactive',content}
      });
      if(response?.code&&response.code!==0)throw Object.assign(new Error('feishu-menu-send-failed'),{code:response.code});
    }catch(error){
      seen.delete(menu.fingerprint); // allow retries after a send failure
      state('飞书状态菜单发送失败：'+String(error?.code??'delivery-failed').slice(0,64),false);
    }
  }});
  return true;
}
