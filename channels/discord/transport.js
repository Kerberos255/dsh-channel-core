import { checkAbort, discordAttachment, splitDiscord, statusLabel } from 'dsh-channel-core/transport-utils';
import { renderProgress,renderNotice,renderHeading,footerSuffix } from './progress.js';
import { renderFooter } from './footer.js';
import { afterPresentedContext } from './question-context.js';
import { formatFinalWithQuotedDraft } from './final-format.js';
import { currentSelection, decodeModel, defaultEffort, describeSelection, effortChoices, modelChoices } from './model-commands.js';

// Discord 的"正在输入"提示约 10 秒后自动消失，所以按心跳刷新；上限是保险丝，
// 防止异常回合把提示一直挂着。心跳失败只影响这个提示，绝不影响回复本身。
const TYPING_REFRESH_MS=8000;
const TYPING_MAX_MS=10*60*1000;

export function normalize(message,config,botId){
  const thread=message.channel.isThread?.();
  const conversationId=thread?message.channel.parentId:message.channelId;
  const text=(message.content??'').replace(new RegExp('<@!?'+botId+'>','g'),'').trim();
  return {provider:'discord',accountId:config.accountId,conversationId,userId:message.author.id,messageId:message.id,
    ...(thread?{threadId:message.channelId}:{}),...(message.reference?.messageId?{replyTo:message.reference.messageId}:{}),
    kind:!message.guildId?'dm':thread?'thread':'group',text,attachments:[],resources:[...message.attachments.values()].map(file=>({id:file.id,url:file.url,fileName:file.name,size:file.size})),
    timestamp:Math.trunc(message.createdTimestamp),mentionedBot:message.mentions?.users?.has(botId)??false};
}
export const slashCommand={name:'dsh',description:'与 DeepSeek Harness 会话',options:[
  {type:1,name:'prompt',description:'向当前会话发送消息',options:[{type:3,name:'text',description:'消息内容',required:true}]},
  ...['new','stop','status'].map(name=>({type:1,name,description:{new:'创建新会话',stop:'停止当前轮次',status:'查看渠道状态'}[name]})),
  {type:1,name:'session',description:'查看或切换本渠道的会话',options:[{type:3,name:'id',description:'会话 ID',autocomplete:true}]},
  {type:1,name:'answer',description:'回答 DSH 的问题',options:[{type:3,name:'token',description:'问题中显示的回答令牌',required:true},{type:3,name:'text',description:'你的回答',required:true}]},
]};
export const modelCommand={name:'model',description:'切换本渠道会话使用的模型',options:[
  {type:3,name:'model',description:'模型（输入可搜索）',required:true,autocomplete:true}]};
export const thinkCommand={name:'think',description:'设置本渠道会话的推理强度',options:[
  {type:3,name:'effort',description:'推理强度（输入可搜索）',required:true,autocomplete:true}]};
export const slashCommands=[slashCommand,modelCommand,thinkCommand];
const slashCommandNames=new Set(slashCommands.map(item=>item.name));
function interactionMessage(interaction,config,text){const thread=interaction.channel?.isThread?.();return {provider:'discord',accountId:config.accountId,conversationId:thread?interaction.channel.parentId:interaction.channelId,threadId:thread?interaction.channelId:undefined,userId:interaction.user.id,messageId:'interaction:'+interaction.id,kind:interaction.guildId?(thread?'thread':'group'):'dm',text,attachments:[],resources:[],timestamp:Math.trunc(interaction.createdTimestamp??Date.now()),mentionedBot:true};}
export async function createTransport({config,credentials,signal,receive,state,action,sessions,host},sdkOverride){
  const sdk=sdkOverride??await import('discord.js');
  const client=new sdk.Client({intents:[sdk.GatewayIntentBits.Guilds,sdk.GatewayIntentBits.GuildMessages,sdk.GatewayIntentBits.DirectMessages,sdk.GatewayIntentBits.MessageContent],partials:[sdk.Partials.Channel],
    rest:{timeout:15000,retries:0},makeCache:sdk.Options.cacheWithLimits({MessageManager:0,ThreadManager:100,GuildMemberManager:0,PresenceManager:0})});
  const progress=new Map(),presented=new Map(),interactions=new Map(),questionContexts=new Map(),questions=new Map(),progressIdentities=new Map(),listeners=[];
  const key=origin=>JSON.stringify([origin.conversationId,origin.threadId??'',origin.messageId]);
  const on=(name,handler)=>{client.on(name,handler);listeners.push(()=>client.off(name,handler));};
  on('messageCreate',async message=>{
    if(signal.aborted||message.author.bot||message.webhookId||message.system)return;
    const origin=normalize(message,config,client.user.id);
    try{await receive(origin);}catch(error){state('消息处理失败：'+(error.code??'请查看 DSH 日志'));await present(origin,{text:'消息未被接收，请查看渠道设置与 DSH 日志。',status:'failed',final:true}).catch(()=>{});progress.delete(key(origin));presented.delete(key(origin));}
  });
  const hostReady=()=>Boolean(host?.modelCatalog&&host?.selectModel&&host?.projections);
  const sessionFor=async interaction=>{try{return (await sessions(interactionMessage(interaction,config,'/session')))[0];}catch{return undefined;}};
  const ephemeral=(interaction,content)=>interaction.editReply({content,allowedMentions:{parse:[]}});
  const failure=error=>'操作失败：'+String(error?.message??error).replace(/\s+/g,' ').slice(0,300);
  on('interactionCreate',async interaction=>{
    if(signal.aborted)return;
    try{
      if(interaction.isAutocomplete?.()&&slashCommandNames.has(interaction.commandName)){
        const query=interaction.options.getFocused();
        if(interaction.commandName==='dsh'){
          const message=interactionMessage(interaction,config,'/session');
          await interaction.respond((await sessions(message)).filter(id=>id.includes(query)).slice(0,25).map(id=>({name:id,value:id})));return;
        }
        if(!hostReady()){await interaction.respond([]);return;}
        const catalog=await host.modelCatalog();
        if(interaction.commandName==='model'){await interaction.respond(modelChoices(catalog,query));return;}
        const sessionId=await sessionFor(interaction);
        const selection=sessionId?currentSelection(catalog,await host.projections({sessionId})):undefined;
        await interaction.respond(effortChoices(catalog,selection?.provider,selection?.model,query));return;
      }
      if(interaction.isChatInputCommand?.()&&(interaction.commandName==='model'||interaction.commandName==='think')){
        await interaction.deferReply({flags:64});
        try{
          if(!hostReady()){await ephemeral(interaction,'当前 Host 不支持模型命令。');return;}
          const sessionId=await sessionFor(interaction);
          if(!sessionId){await ephemeral(interaction,'这个频道还没有可用会话（也可能当前账号或频道未被授权）。先发一句话，再来设置。');return;}
          const catalog=await host.modelCatalog();
          if(interaction.commandName==='model'){
            const chosen=decodeModel(interaction.options.getString('model'));
            if(!chosen){await ephemeral(interaction,'请从列表里选一个模型。');return;}
            const effort=defaultEffort(catalog,chosen.provider,chosen.model);
            const result=await host.selectModel({sessionId,provider:chosen.provider,model:chosen.model,...(effort===undefined?{}:{reasoningEffort:effort})});
            await ephemeral(interaction,'已切换模型：'+(result?.selected?describeSelection(catalog,result.selected):chosen.provider+'/'+chosen.model)+'\n从下一次请求开始生效。');return;
          }
          const selection=currentSelection(catalog,await host.projections({sessionId}));
          if(!selection?.provider||!selection?.model){await ephemeral(interaction,'还不知道当前模型，先用 /model 选一个。');return;}
          if(!effortChoices(catalog,selection.provider,selection.model).length){await ephemeral(interaction,'当前模型 '+selection.model+' 没有公布可选的推理强度。');return;}
          const effort=String(interaction.options.getString('effort'));
          const result=await host.selectModel({sessionId,provider:selection.provider,model:selection.model,reasoningEffort:effort});
          await ephemeral(interaction,'推理强度已更新：'+describeSelection(catalog,result?.selected??{...selection,reasoningEffort:effort})+'\n从下一次请求开始生效。');return;
        }catch(error){await ephemeral(interaction,failure(error));return;}
      }
      if(interaction.isChatInputCommand?.()&&interaction.commandName==='dsh'){
        await interaction.deferReply();
        const command=interaction.options.getSubcommand(),args=command==='answer'?interaction.options.getString('token')+' '+interaction.options.getString('text'):command==='session'?interaction.options.getString('id')??'':'';
        const message=interactionMessage(interaction,config,command==='prompt'?interaction.options.getString('text'):'/'+command+(args?' '+args:''));
        interactions.set(message.messageId,interaction);
        while(interactions.size>256)interactions.delete(interactions.keys().next().value);
        const result=await receive(message);
        if(result?.ignored||command==='answer')await interaction.editReply({content:result?.ignored?'当前账号或频道未被允许使用。':'回答已提交。',allowedMentions:{parse:[]}});
        return;
      }
      if(!interaction.isMessageComponent?.()||!interaction.customId.startsWith('dsh:'))return;
      await interaction.deferUpdate();
      await action({token:interaction.customId.slice(4),userId:interaction.user.id,conversationId:interaction.channel?.isThread?.()?interaction.channel.parentId:interaction.channelId,threadId:interaction.channel?.isThread?.()?interaction.channelId:undefined,messageId:interaction.message.id,values:interaction.values});
    }catch{
      const body={content:'该操作已失效，或当前账号与频道无权执行。',flags:64,allowedMentions:{parse:[]}};
      if(interaction.deferred||interaction.replied)await interaction.followUp(body).catch(()=>{});else await interaction.reply(body).catch(()=>{});
    }
  });
  on('error',()=>state('Discord 连接发生错误'));
  on('shardReconnecting',()=>state('Discord 正在重连…',false));
  on('shardDisconnect',()=>state('Discord 连接已断开，等待重连…',false));
  on('shardResume',()=>state('Discord 已重新连接',true));
  on('clientReady',()=>state('Discord 已连接',true));
  async function channelFor(origin){checkAbort(signal);const channel=await client.channels.fetch(origin.threadId??origin.conversationId);if(!channel?.isTextBased())throw Object.assign(new Error('channel-unavailable'),{definitelyNotSent:true});return channel;}
  const typing=new Map();
  function stopTyping(origin){
    const id=key(origin),entry=typing.get(id);
    if(!entry)return;
    typing.delete(id);
    if(entry.timer)clearInterval(entry.timer);
  }
  // 回合一开始（第一次进度）就点亮"正在输入"，随后按心跳续期；最终回复、
  // 等待用户回答或超时都会停。渠道频道本身不缓存 typing 状态，所以每次都用
  // channelFor 拿到的同一个频道对象发送即可。
  function startTyping(origin){
    const id=key(origin);
    if(typing.has(id))return;
    const entry={timer:null,channel:null,deadline:Date.now()+TYPING_MAX_MS};
    typing.set(id,entry);
    const ping=async()=>{
      if(Date.now()>=entry.deadline||signal.aborted){stopTyping(origin);return;}
      try{entry.channel??=await channelFor(origin);await entry.channel.sendTyping();}
      catch{/* 输入状态只是提示：失败静默跳过，绝不打断回合 */}
    };
    void ping();
    entry.timer=setInterval(()=>{void ping();},TYPING_REFRESH_MS);
    entry.timer.unref?.();
  }
  const options=(content,origin,body)=>({content,allowedMentions:{parse:[],repliedUser:false},...(origin.messageId&&!origin.messageId.startsWith('interaction:')?{reply:{messageReference:origin.messageId,failIfNotExists:false}}:{}),...(body.id?{nonce:body.id.slice(0,24),enforceNonce:true}:{})});
  const runtimeMetrics=new Map();
  async function readRuntimeMetrics(sessionId,force=false){
    if(!sessionId||!host?.runtimeMetrics)return {};
    const previous=runtimeMetrics.get(sessionId);
    if(!force&&previous&&Date.now()-previous.at<6000)return previous.value;
    try{
      const value=await host.runtimeMetrics(sessionId);
      if(value&&typeof value==='object'){
        runtimeMetrics.set(sessionId,{at:Date.now(),value});
        if(runtimeMetrics.size>256)runtimeMetrics.delete(runtimeMetrics.keys().next().value);
        return value;
      }
    }catch{/* Footer availability never blocks message delivery. */}
    return previous?.value??{};
  }
  const displayIdentity=metrics=>({icon:config.displayIcon,name:metrics?.agentName||host?.defaultAgentName?.()||'Agent'});
  async function present(origin,body,actions=[],content=renderNotice(body,displayIdentity())){
    const id=key(origin),existing=progress.get(id);
    const components=[];
    for(let i=0;i<Math.min(actions.length,25);i+=5)components.push({type:1,components:actions.slice(i,i+5).map(item=>({type:2,style:2,label:item.label.slice(0,80),custom_id:'dsh:'+item.token}))});
    const signature=JSON.stringify([content,components]);
    if(existing&&presented.get(id)===signature)return {messageId:existing};
    const channel=await channelFor(origin);
    if(existing){await channel.messages.edit(existing,{content,components,allowedMentions:{parse:[]}});presented.set(id,signature);return {messageId:existing};}
    const interaction=interactions.get(origin.messageId);
    const message=interaction?await interaction.editReply({content,components,allowedMentions:{parse:[]}}):await channel.send({...options(content,origin,body),components});
    progress.set(id,message.id);presented.set(id,signature);return {messageId:message.id};
  }
  function preserve(origin){
    // The current Discord message becomes history; subsequent progress needs a
    // new message, including when the first one was a slash-command response.
    progress.delete(key(origin));presented.delete(key(origin));interactions.delete(origin.messageId);
  }
  async function question(origin,body,actions){
    stopTyping(origin);
    const id=key(origin),context=String(body.context??''),previous=questionContexts.get(id)??'';
    const added=context.startsWith(previous)?context.slice(previous.length).trimStart():context;
    if(added){
      for(const part of splitDiscord(added)){
        checkAbort(signal);await present(origin,body,[],part);preserve(origin);
      }
      questionContexts.set(id,context);
    }
    // Never clip a question or its custom-answer token. Keep buttons on its last
    // message and only edit that message when a multi-select choice changes.
    const text=renderHeading(body.status,progressIdentities.get(id)??displayIdentity())+'\n'+(body.text||'请回答。');
    const parts=splitDiscord(text);
    if(questions.get(id)!==text){
      for(const part of parts.slice(0,-1)){
        checkAbort(signal);await present(origin,body,[],part);preserve(origin);
      }
    }
    const sent=await present(origin,body,actions,parts.at(-1));questions.set(id,text);return sent;
  }
  let closing;const close=()=>closing??=(async()=>{signal.removeEventListener('abort',onAbort);listeners.splice(0).forEach(dispose=>dispose());await client.destroy();typing.forEach(entry=>{if(entry.timer)clearInterval(entry.timer);});typing.clear();progress.clear();presented.clear();interactions.clear();questionContexts.clear();questions.clear();progressIdentities.clear();})();
  const onAbort=()=>{void close().catch(()=>{});};signal.addEventListener('abort',onAbort,{once:true});
  return {
    throttleMs:config.throttleMs,
    coalesceProgress:true,
    // Discord shows draft only while running; final delivery stores no draft text.
    showNarration:false,
    details:()=>({applicationId:client.application?.id??'',botId:client.user?.id??''}),
    async start(){await client.login(credentials[0]);checkAbort(signal);if(config.registerCommands)for(const command of slashCommands)await client.application.commands.create(command);},
    close,
    progress:config.streaming.mode!=='off'?async(origin,body)=>{
      if(body?.final===true)stopTyping(origin);else startTyping(origin);
      const metrics=await readRuntimeMetrics(body.sessionId);
      const footer=renderFooter(config.streaming.footer,body,metrics);
      const identity=displayIdentity(metrics);
      progressIdentities.set(key(origin),identity);
      return present(origin,body,[],renderProgress(body,config.streaming,footer,identity));
    }:undefined,
    question,
    async send(origin,body){
      stopTyping(origin);
      const channel=await channelFor(origin),existing=progress.get(key(origin));
      // Ask User already published the committed prefix as standalone history.
      // turn/end still includes that prefix; only emit the continuation.
      const oldContextKey=body.progressOriginMessageId?key({...origin,messageId:body.progressOriginMessageId}):null;
      const context=questionContexts.get(key(origin))??(oldContextKey?questionContexts.get(oldContextKey):null);
      const remainder=afterPresentedContext(body.text,context);
      const finalText=remainder||(context&&String(body.text??'')===context?(body.status==='completed'?'本轮已完成。':body.status==='cancelled'?'本轮已停止。':'本轮已结束。'):body.text);
      const metrics=await readRuntimeMetrics(body.sessionId,true);
      const footer=renderFooter(config.streaming.footer,body,metrics);
      const footnote=footerSuffix(footer);
      const parts=body.status==='completed'
        ?formatFinalWithQuotedDraft(finalText,{draftPrelude:body.draftPrelude,finalReplyText:body.finalReplyText,footnote})
        :formatFinalWithQuotedDraft(finalText,{footnote});
      const oldKey=body.progressOriginMessageId?key({...origin,messageId:body.progressOriginMessageId}):null;
      const oldProgress=oldKey&&oldKey!==key(origin)?progress.get(oldKey):null;
      if(oldProgress)stopTyping({...origin,messageId:body.progressOriginMessageId});
      let first;
      for(let i=0;i<parts.length;i++){
        checkAbort(signal);
        const content=(i===0&&body.status!=='completed'?'**'+statusLabel(body.status)+'**\n':'')+parts[i];
        const interaction=i===0&&!existing?interactions.get(origin.messageId):undefined;
        const message=i===0&&existing?await channel.messages.edit(existing,{content,components:[],allowedMentions:{parse:[]}}):interaction?await interaction.editReply({content,components:[],allowedMentions:{parse:[]}}):await channel.send(options(content,origin,{id:body.id?body.id.slice(0,20)+'-'+i:undefined}));
        first??=message.id;
      }
      // Retire old Steer progress only after a confirmed final message.
      if(oldProgress){
        try{await channel.messages.delete(oldProgress);progress.delete(oldKey);presented.delete(oldKey);}
        catch(error){state('Discord 已发出最终回复，但旧进度消息清理失败：'+(error.code??'unknown'));}
      }
      progress.delete(key(origin));presented.delete(key(origin));interactions.delete(origin.messageId);questionContexts.delete(key(origin));questions.delete(key(origin));progressIdentities.delete(key(origin));
      if(oldKey)progressIdentities.delete(oldKey);
      if(oldContextKey&&oldContextKey!==key(origin)){questionContexts.delete(oldContextKey);questions.delete(oldContextKey);}
      return {messageId:first};
    },
    async upload(message,sessionId,fileUploads,uploadSignal){
      if(!config.attachments)throw Object.assign(new Error('attachments-disabled'),{code:'attachments-disabled'});
      if(message.resources.length>16)throw new Error('too-many-attachments');
      const files=[];
      for(const resource of message.resources){
        const max=config.maxAttachmentMB*1024*1024;
        if(resource.size>max)throw new Error('attachment-too-large');
        const data=await discordAttachment(resource,uploadSignal,max);
        files.push(await fileUploads.uploadStream({sessionId,data,signal:uploadSignal,name:resource.fileName??'attachment'}));
      }
      return files;
    },
  };
}
