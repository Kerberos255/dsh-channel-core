window.__ModuleLoader__.load({
  id: 'dsh-channel-core',
  factory(require) {
    const React = require('react');
    const { Switch, Button } = require('@deepseek-ai/dsh-client-ui-primitives');
    const e = React.createElement;
    // Embedded by build.mjs. React and the official Connection are provided by DSH.
const { Switch: DshSwitch, Button: DshButton } = require('@deepseek-ai/dsh-client-ui-primitives');
function createConfigScope(connection, endpoint) {
  let state = { status: 'loading', writable: connection.isLoopback !== false }, closed = false, serial = 0, saving = false;
  const listeners = new Set(), requests = new Set();
  const publish = next => { if (!closed) { state = next; for (const fn of listeners) fn(); } };
  const call = async (method, args) => {
    if (closed) throw new Error('插件已停用');
    const abort = new AbortController(); requests.add(abort);
    const timeout = setTimeout(() => abort.abort(), 15000);
    try {
      const result = await connection.rpc.call('/api', endpoint + '/' + method, { args }, abort.signal);
      if (!result.ok) throw Object.assign(new Error(result.error?.message || result.error?.code || '请求失败'), { code: result.error?.code });
      return result.value;
    } finally { clearTimeout(timeout); requests.delete(abort); }
  };
  const accept = value => publish({ ...value, status: 'ready', writable: connection.isLoopback !== false, requestError: '' });
  const scope = {
    getSnapshot: () => state,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    async reload() {
      const sequence = ++serial;
      try { const value = await call('getConfig', {}); if (sequence === serial) accept(value); return value; }
      catch (error) { if (sequence === serial) publish({ ...state, requestError: error.message }); throw error; }
    },
    async update(value, revision = state.revision) {
      if (saving) throw new Error('正在保存，请稍候');
      saving = true; ++serial;
      try { const result = await call('setConfig', { value, revision }); accept(result); return result; }
      finally { saving = false; }
    },
    set(key, value) { return scope.update({ ...state.value, [key]: value }); },
    call,
    async runAction() { const result = await call('runAction', {}); accept(result); return result; },
    close() { closed = true; ++serial; for (const abort of requests) abort.abort(); listeners.clear(); },
  };
  return scope;
}
function useFileConfig(scope) {
  return React.useSyncExternalStore(scope.subscribe, scope.getSnapshot, scope.getSnapshot);
}
const configValue=(value,key)=>key.split('.').reduce((current,part)=>current?.[part],value);
const configChange=(value,key,next)=>{
  const [head,...tail]=key.split('.');
  return {...value,[head]:tail.length?configChange(value[head],tail.join('.'),next):next};
};
function ModelPicker({ scope, kind='chat', provider, model, disabled, label, emptyLabel, onChange }) {
  const e=React.createElement, [catalog,setCatalog]=React.useState({groups:[]}), [error,setError]=React.useState('');
  React.useEffect(()=>{
    let active=true,sequence=0;
    const load=()=>{const current=++sequence;scope.call('modelCatalog',{kind}).then(value=>{if(active&&current===sequence){setCatalog(value);setError('');}}).catch(failure=>{if(active&&current===sequence)setError(failure.message);});};
    load();window.addEventListener('focus',load);return()=>{active=false;window.removeEventListener('focus',load);};
  },[scope,kind]);
  const encode=(provider,model)=>JSON.stringify([provider,model]),value=encode(provider||'',model||'');
  const known=catalog.groups.some(group=>group.models.some(entry=>group.id===provider&&entry.id===model));
  return e('div',null,e('select',{'aria-label':label,value,disabled,onChange:event=>{const [provider,model]=JSON.parse(event.target.value);onChange({provider,model});}},
    e('option',{value:encode('','')},emptyLabel || (kind==='embedding'?'词语检索（不使用向量模型）':'继承 DSH 默认模型')),
    provider&&model&&!known?e('option',{value},`${provider} / ${model}（当前配置）`):null,
    catalog.groups.map(group=>e('optgroup',{key:group.id,label:group.name||group.id},group.models.map(entry=>e('option',{key:entry.id,value:encode(group.id,entry.id)},entry.name||entry.id))))),
    error?e('small',{role:'status'},'模型目录暂不可用：'+error):kind==='embedding'&&!catalog.groups.length?e('small',null,'尚未注册向量模型。'):null);
}
function FileConfigPage({ scope, title, description, fields, actionLabel, credentialApi, credentials, credentialTitle='凭证', credentialsFirst=false }) {
  const e = React.createElement, snapshot = useFileConfig(scope);
  const [editor, setEditor] = React.useState({ base: null, draft: null, error: '', saved: false });
  const [busy, setBusy] = React.useState(false);
  const busyRef = React.useRef(false), alive = React.useRef(false);
  const dirty = !!editor.base && JSON.stringify(editor.draft) !== JSON.stringify(editor.base.value);
  const external = !!editor.base && snapshot.revision !== editor.base.revision;
  React.useEffect(() => {
    if (snapshot.status !== 'ready') return;
    setEditor(previous => !previous.base || (!busyRef.current && JSON.stringify(previous.draft) === JSON.stringify(previous.base.value))
      ? { base: snapshot, draft: structuredClone(snapshot.value), error: '', saved: previous.saved } : previous);
  }, [snapshot]);
  React.useEffect(() => {
    alive.current = true;
    let reloading = false;
    const reload = () => {
      if (busyRef.current || reloading) return;
      reloading = true;
      void scope.reload().catch(() => {}).finally(() => { reloading = false; });
    };
    reload(); window.addEventListener('focus', reload);
    const interval = actionLabel ? setInterval(() => { if (document.visibilityState !== 'hidden') reload(); }, 2000) : null;
    return () => { alive.current = false; window.removeEventListener('focus', reload); if (interval) clearInterval(interval); };
  }, [scope, actionLabel]);
  const work = async operation => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true);
    try { await operation(); }
    catch (error) { if (alive.current) setEditor(previous => ({ ...previous, error: error.message, errorCode: error.code, saved: false })); }
    finally { busyRef.current = false; if (alive.current) setBusy(false); }
  };
  const replace = result => { if (alive.current) setEditor({ base: result, draft: structuredClone(result.value), error: '', saved: false }); };
  const change = (key, value) => setEditor(previous => ({ ...previous, draft: configChange(previous.draft,key,value), error: '', errorCode: '', saved: false }));
  const disabled = busy || !snapshot.writable || !editor.draft;
  const field = spec => {
    const value = configValue(editor.draft,spec.key), id = 'dsh-config-' + spec.key;
    const common = { id, disabled: disabled || spec.disabled, 'aria-label': spec.label };
    let input;
    if (spec.type === 'readonly') input = e('input', { ...common, type: 'text', readOnly: true, value: snapshot.details?.[spec.detail] ?? '', placeholder: spec.placeholder });
    else if (spec.type === 'boolean') input = e(DshSwitch, { label: spec.label, disabled: common.disabled, checked: value, onChange: next => change(spec.key, next) });
    else if (spec.type === 'multiline') input = e('textarea', {...common,rows:5,value,onChange:event=>change(spec.key,event.target.value)});
    else if (spec.type === 'list') input = e('textarea', {...common, rows: Math.max(3,Math.min(8,value.length+1)), value:editor.listText?.[spec.key]??value.join('\n'),
      onChange:event=>{const text=event.target.value;setEditor(previous=>({...previous,draft:configChange(previous.draft,spec.key,text.split(/[\n,]/).map(item=>item.trim()).filter(Boolean)),listText:{...previous.listText,[spec.key]:text},error:'',errorCode:'',saved:false}));} });
    else if (spec.type === 'model') input = e(ModelPicker,{scope,kind:spec.kind,provider:configValue(editor.draft,spec.providerKey),model:value,emptyLabel:spec.emptyLabel,disabled:common.disabled,label:spec.label,onChange:selection=>setEditor(previous=>({...previous,draft:configChange(configChange(previous.draft,spec.providerKey,selection.provider),spec.key,selection.model),error:'',errorCode:'',saved:false}))});
    else if (spec.type === 'select') input = e('select', { ...common, value, onChange: event => change(spec.key, spec.numeric ? Number(event.target.value) : event.target.value) }, spec.options.map(([key, label]) => e('option', { key, value: key }, label)));
    else if (spec.type === 'order' || spec.type === 'providers') input = e('ol', { className: 'dpc-order' }, value.map((key, index) => e('li', { key },
      e('span', { className: 'dpc-rank', 'aria-hidden': true }, index + 1), e('span', { className: 'dpc-provider-name' }, spec.labels[key] || key),
      spec.type === 'providers' ? e(DshSwitch, { label: '启用 ' + (spec.labels[key] || key), checked: editor.draft.enabledProviders.includes(key), disabled,
        onChange: next => change('enabledProviders', next ? [...editor.draft.enabledProviders, key] : editor.draft.enabledProviders.filter(item => item !== key)) }) : null,
      e('div', { className: 'dpc-order-actions' }, ...[-1, 1].map(delta => e(DshButton, {
        key: delta, type: 'button', disabled: disabled || index + delta < 0 || index + delta >= value.length,
        variant: 'ghost', size: 'sm', className: 'dpc-arrow', title: delta < 0 ? '上移' : '下移',
        'aria-label': (delta < 0 ? '上移 ' : '下移 ') + (spec.labels[key] || key),
        onClick: () => { const next = [...value]; [next[index], next[index + delta]] = [next[index + delta], next[index]]; change(spec.key, next); },
      }, e('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, 'aria-hidden': true },
        e('path', { d: delta < 0 ? 'm6 15 6-6 6 6' : 'm6 9 6 6 6-6' }))))))));
    else if (spec.type === 'choices') input = e('div', null, Object.entries(spec.labels).map(([key, label]) => e('label', { className: 'dpc-choice', key }, e('input', {
      type: 'checkbox', checked: value.includes(key), disabled, onChange: event => change(spec.key, event.target.checked ? [...value, key] : value.filter(x => x !== key)),
    }), ' ', label)));
    else input = e('input', { ...common, type: spec.type === 'number' ? 'number' : 'text', value,
      min: spec.min, max: spec.max, step: spec.step ?? 1,
      onChange: event => change(spec.key, spec.type === 'number' ? Number(event.target.value) : event.target.value),
    });
    return e('div', { className: 'dpc-field dpc-' + spec.type, key: spec.key },
      e('div', { className: 'dpc-label' }, e('label', { htmlFor: spec.type === 'boolean' ? undefined : id }, spec.label), spec.help ? e('small', null, spec.help) : null, spec.emptyHelp&&Array.isArray(value)&&!value.length?e('small',null,spec.emptyHelp):null),
      e('div', { className: 'dpc-control' }, input));
  };
  const visible=spec=>!spec.when||(Array.isArray(spec.when)?spec.when:[spec.when]).some(condition=>Object.entries(condition).every(([key,value])=>configValue(editor.draft,key)===value));
  const grouped=advanced=>{
    const groups=[];
    for(const spec of fields.filter(spec=>!!spec.advanced===advanced&&visible(spec))){
      if(!groups.length||groups.at(-1).title!==(spec.group||''))groups.push({title:spec.group||'',fields:[]});
      groups.at(-1).fields.push(spec);
    }
    return groups.map((group,index)=>e('section',{className:'dpc-group',key:index},group.title?e('h4',null,group.title):null,group.fields.map(field)));
  };
  const credentialView=credentialApi&&credentials&&snapshot.value?e(CredentialsPage,{api:credentialApi,refs:credentials(snapshot.value),writable:snapshot.writable,title:credentialTitle,expanded:credentialsFirst}):null;
  const reloadNeeded = external || snapshot.requestError || editor.errorCode?.includes('conflict');
  return e('form', { className: 'dpc-page', 'aria-label': title, onSubmit: event => { event.preventDefault(); if (disabled || external || (!dirty && !snapshot.error)) return;
    void work(async () => { const result = await scope.update(editor.draft, editor.base.revision); replace(result); if (alive.current) setEditor(previous => ({ ...previous, saved: true })); });
  } },credentialsFirst?credentialView:null,editor.draft?grouped(false):e('p',null,'正在读取配置…'),
    editor.draft&&fields.some(spec=>spec.advanced&&visible(spec))?e('details',{className:'dpc-advanced'},e('summary',null,'高级设置'),grouped(true)):null,
    snapshot.error ? e('p', { role: 'alert' }, '文件有误，运行时保留上一次有效设置。', snapshot.error.message, '；保存可修复文件。') : null,
    external ? e('p', { role: 'alert' }, '配置已被其他页面或文件编辑修改。重新载入后再保存，可避免覆盖外部修改。') : null,
    editor.error || snapshot.requestError ? e('p', { role: 'alert' }, editor.error || snapshot.requestError) : null,
    e('div', { className: 'dpc-actions' }, e(DshButton, { type: 'submit', variant: 'primary', disabled: disabled || external || (!dirty && !snapshot.error) }, busy ? '处理中…' : '保存'),
      reloadNeeded ? e(DshButton, { type: 'button', variant: 'outline', disabled: busy, onClick: () => void work(async () => replace(await scope.reload())) }, dirty ? '放弃草稿并重新载入' : '重新载入') : null,
      actionLabel ? e(DshButton, { type: 'button', variant: 'outline', disabled: busy || !snapshot.writable, onClick: () => void work(async () => { await scope.runAction(); }) }, actionLabel) : null,
      e('span', { role: 'status' }, editor.saved ? '已保存并生效' : dirty ? '尚未保存' : '')),
    snapshot.details ? e('p', { role: 'status' }, snapshot.details.message) : null,
    e('p', { className: 'dpc-note' }, '保存后自动应用，后续操作使用新配置。'),
    snapshot.configFile ? e('details', { className: 'dpc-path' }, e('summary', null, '配置文件'), e('code', null, snapshot.configFile)) : null,
    credentialsFirst?null:credentialView,
  );
}
function CredentialsPage({ api, refs, writable, title, expanded=false }) {
  const e = React.createElement;
  const [status, setStatus] = React.useState({}), [drafts, setDrafts] = React.useState({}), [busy, setBusy] = React.useState(false), [error, setError] = React.useState('');
  const alive = React.useRef(false), running = React.useRef(false);
  const identity = JSON.stringify(refs);
  React.useEffect(() => {
    let active = true;
    alive.current = true;
    void api.describe(Object.keys(refs)).then(result => {
      if (!active) return;
      if (!result.ok) throw new Error(result.error?.message || '读取凭证状态失败');
      setStatus(result.value);
    }).catch(reason => { if (active) setError(reason.message); });
    return () => { active = false; alive.current = false; };
  }, [api, identity]);
  const save = async (ref, clear) => {
    if (running.current || !writable) return; running.current = true; setBusy(true); setError('');
    try {
      const result = clear ? await api.unset(ref) : await api.set(ref, drafts[ref]);
      if (!result.ok) throw new Error(result.error?.message || '保存凭证失败');
      if (!alive.current) return;
      setDrafts(previous => ({ ...previous, [ref]: '' }));
      setStatus(previous => ({ ...previous, [ref]: { configured: !clear } }));
    } catch (reason) { if (alive.current) setError(reason.message); }
    finally { running.current = false; if (alive.current) setBusy(false); }
  };
  return e(expanded?'section':'details', { className: 'dpc-credentials' }, e(expanded?'h4':'summary', null, title), e('fieldset', { disabled: busy || !writable },
    e('p', null, '密钥单独保存到 DSH 凭证管理；已有密钥只显示配置状态。'),
    Object.entries(refs).map(([ref, label]) => e('div', { className: 'dpc-field', key: ref }, e('label', null, label, ' · ', ref),
      e('input', { type: 'password', autoComplete: 'new-password', 'aria-label': label + ' 密钥', value: drafts[ref] || '', placeholder: status[ref]?.configured ? '已配置；留空保持' : '未配置',
        onChange: event => setDrafts(previous => ({ ...previous, [ref]: event.target.value })) }),
      e('div', { className: 'dpc-actions' }, e(DshButton, { type: 'button', variant: 'outline', disabled: !drafts[ref], onClick: () => void save(ref, false) }, '保存密钥'),
        e(DshButton, { type: 'button', variant: 'ghost', disabled: !status[ref]?.configured, onClick: () => void save(ref, true) }, '清除密钥')))),
    error ? e('p', { role: 'alert' }, error) : null));
}


  const bundledChannelPanels={"discord":{"rowId":"channel-discord","endpoint":"discordChannelSettings","title":"Discord 渠道","description":"将 Discord 消息接入 DSH 原生会话，支持线程、交互和渠道设置。","standalone":true,"actionLabel":"重新连接","credentialFields":{"tokenRef":"Discord Bot Token"},"fields":[{"key":"enabled","label":"连接渠道","type":"boolean","help":"保存后自动连接；有效凭证用于登录，消息接收范围单独配置。","group":"账号与连接","advanced":false},{"key":"dmPolicy","group":"接收范围","label":"私聊接收范围","type":"select","options":[["disabled","关闭私聊"],["allowlist","仅指定用户"],["all","所有私聊用户"]],"help":"与服务器范围分别设置；选择所有私聊用户后无需填写用户 ID，各用户的私聊会话独立。","advanced":false},{"key":"allowGroups","group":"接收范围","label":"接收服务器消息","type":"boolean","advanced":false},{"key":"groupPolicy","group":"接收范围","label":"服务器接收范围","type":"select","options":[["allowlist","指定允许的用户和频道"],["all","服务器内所有用户、所有频道"]],"help":"只应用于服务器消息；私聊由私聊接收范围单独设置。","when":{"allowGroups":true},"advanced":false},{"key":"requireMention","group":"接收范围","label":"服务器消息需要 @ 机器人","type":"boolean","when":{"allowGroups":true},"advanced":false},{"key":"allowedUsers","group":"接收范围","label":"允许使用的用户 ID","type":"list","help":"私聊选择指定用户、服务器选择指定范围时使用，每行一个；选择全部范围时无需填写。","when":[{"dmPolicy":"allowlist"},{"allowGroups":true,"groupPolicy":"allowlist"}],"emptyHelp":"指定用户模式需要填写用户 ID，空列表暂不接收消息。","advanced":false},{"key":"allowedGroups","group":"接收范围","label":"允许的频道 ID","type":"list","help":"指定范围时使用，每行一个频道 ID；选择全部范围时无需填写。","when":{"allowGroups":true,"groupPolicy":"allowlist"},"emptyHelp":"指定频道模式需要填写频道 ID，空列表暂不接收服务器消息。","advanced":false},{"key":"streaming.mode","group":"回复显示","label":"回复显示方式","type":"select","options":[["progress","执行进度（progress）"],["partial","实时正文（partial）"],["off","仅最终回复（off）"]],"help":"执行进度更新同一条消息，完成后显示完整回答。","advanced":false},{"key":"accountId","label":"账号标识","type":"text","help":"本地用于区分机器人账号，配置后保持稳定。","group":"账号与连接","advanced":true},{"key":"applicationId","type":"readonly","label":"应用 ID（自动识别）","detail":"applicationId","placeholder":"连接后自动识别","help":"根据 Bot Token 识别对应应用。","group":"账号与连接","advanced":true},{"key":"tokenRef","label":"凭证名称","type":"text","help":"Bot Token 在上方机器人凭证区保存。","group":"账号与连接","advanced":true},{"key":"registerCommands","label":"注册 /dsh 指令","group":"会话与输入","type":"boolean","help":"连接后自动添加 /dsh；保留该机器人已有的其他指令。","advanced":true},{"key":"inputMode","group":"会话与输入","label":"新消息输入方式","type":"select","options":[["inherit","跟随“渠道与会话”设置"],["steering","Steering：加入当前任务"],["queue","Queue：排入后续轮次"],["interrupt","Interrupt：停止当前轮次并接收新输入"]],"advanced":true},{"key":"agentPreset","group":"会话与输入","label":"Agent 预设 ID","type":"text","advanced":true},{"key":"workspacePath","group":"会话与输入","label":"工作区路径","type":"text","help":"留空跟随客户端已登记的默认工作区；填写后使用指定目录。","advanced":true},{"key":"resolvedWorkspace","label":"实际工作区","type":"readonly","detail":"workspacePath","placeholder":"渠道连接后显示","group":"会话与输入","advanced":true,"help":"显示渠道新会话实际使用的目录。"},{"key":"memoryNamespace","group":"会话与输入","label":"记忆命名空间","type":"text","advanced":true},{"key":"ownerMode","group":"主人与记忆","label":"主人认领方式","type":"select","options":[["first-dm","首次私聊自动认领（默认）"],["manual","手动指定主人"]],"help":"首次认领仅接受该机器人首位私聊用户；群聊不会认领。认领后永久保存，重启或新会话不会更换。"},{"key":"ownerUserId","group":"主人与记忆","label":"主人平台用户 ID","type":"text","when":{"ownerMode":"manual"},"help":"手动填写 Discord 用户 ID；保存后立即覆盖该渠道主人。"},{"key":"ownerStatus","group":"主人与记忆","label":"当前主人","type":"readonly","detail":"ownerStatus","help":"当前主人已持久记录，不因重启或新建会话改变。"},{"key":"identityLinks","group":"会话与输入","label":"跨渠道身份绑定","type":"list","help":"可选，每行填写 用户ID=共同身份标识；只接受允许列表中的用户，双方填写相同标识才共享私聊。","advanced":true},{"key":"throttleMs","group":"回复与附件","label":"进度更新间隔（毫秒）","type":"number","min":400,"max":5000,"when":[{"streaming.mode":"progress"},{"streaming.mode":"partial"}],"advanced":true},{"key":"attachments","group":"回复与附件","label":"接收附件","type":"boolean","advanced":true},{"key":"maxAttachmentMB","group":"回复与附件","label":"单附件大小限制（MiB）","type":"number","min":1,"max":20,"advanced":true},{"key":"streaming.progress.toolProgress","label":"显示工具进度","type":"boolean","group":"进度显示","advanced":true,"when":{"streaming.mode":"progress"}},{"key":"streaming.progress.commentary","label":"显示简短执行说明","type":"boolean","group":"进度显示","advanced":true,"when":{"streaming.mode":"progress"},"help":"显示模型公开的执行说明，完成后由完整回答替换。"},{"key":"streaming.progress.toolDetail","label":"显示命令与目标摘要","type":"boolean","group":"进度显示","advanced":true,"when":{"streaming.mode":"progress"},"help":"在工具名后附上简短目标，例如“执行命令 · npm pack”；敏感内容自动打码。"},{"key":"streaming.progress.narration","label":"显示思考过程（碎碎念）","type":"boolean","group":"进度显示","advanced":true,"when":{"streaming.mode":"progress"},"help":"显示模型推理片段的最新一行（截断）。默认关闭。"},{"key":"streaming.progress.maxLines","label":"最多显示进度行数","type":"number","group":"进度显示","advanced":true,"when":{"streaming.mode":"progress"},"min":1,"max":12},{"key":"streaming.progress.maxLineChars","label":"每行最多字符数","type":"number","group":"进度显示","advanced":true,"when":{"streaming.mode":"progress"},"min":40,"max":300}],"credentialTitle":"机器人凭证","credentialsFirst":true,"packageName":"dsh-channel-core"},"feishu":{"rowId":"channel-feishu","endpoint":"feishuChannelSettings","title":"飞书渠道","description":"将飞书消息接入 DSH 原生会话，支持回复、附件和渠道设置。","standalone":true,"actionLabel":"重新连接","credentialFields":{"appSecretRef":"飞书应用密钥"},"fields":[{"key":"enabled","label":"连接渠道","type":"boolean","help":"保存后自动连接；有效凭证用于登录，消息接收范围单独配置。","group":"账号与连接"},{"key":"accountId","label":"账号标识","type":"text","help":"本地用于区分机器人账号，配置后保持稳定。","group":"账号与连接"},{"key":"appId","label":"飞书应用 App ID","type":"text","group":"账号与连接"},{"key":"domain","label":"应用区域","type":"select","options":[["feishu","飞书"],["lark","Lark"]],"group":"账号与连接"},{"key":"appSecretRef","label":"凭证名称","type":"text","help":"密钥在下方凭证区单独保存，config.json 只保存引用名称。","group":"账号与连接"},{"key":"allowedUsers","group":"接收范围","label":"允许使用的用户 ID","type":"list","help":"每行一个；留空时仍可连接，但不接收会话消息。"},{"key":"allowGroups","group":"接收范围","label":"接收群聊消息","type":"boolean"},{"key":"allowedGroups","group":"接收范围","label":"允许的群 chat_id","type":"list","help":"每行一个；只有列表中的会话可以进入 DSH。"},{"key":"requireMention","group":"接收范围","label":"群聊需要 @ 机器人","type":"boolean"},{"key":"inputMode","group":"会话与输入","label":"新消息输入方式","type":"select","options":[["inherit","跟随“渠道与会话”设置"],["steering","Steering：加入当前任务"],["queue","Queue：排入后续轮次"],["interrupt","Interrupt：停止当前轮次并接收新输入"]]},{"key":"agentPreset","group":"会话与输入","label":"Agent 预设 ID","type":"text"},{"key":"workspacePath","group":"会话与输入","label":"工作区路径","type":"text","help":"留空使用官方默认工作区；填写后按工作区隔离会话。"},{"key":"memoryNamespace","group":"会话与输入","label":"记忆命名空间","type":"text"},{"key":"ownerMode","group":"主人与记忆","label":"主人认领方式","type":"select","options":[["first-dm","首次私聊自动认领（默认）"],["manual","手动指定主人"]],"help":"首次认领仅接受该机器人首位私聊用户；群聊不会认领。认领后永久保存，重启或新会话不会更换。"},{"key":"ownerUserId","group":"主人与记忆","label":"主人平台用户 ID","type":"text","when":{"ownerMode":"manual"},"help":"手动模式填写 Discord 用户 ID 或飞书 open_id，保存后立即覆盖该渠道主人。两个渠道分别认领，统一访问 DSH 主人记忆。"},{"key":"ownerStatus","group":"主人与记忆","label":"当前主人","type":"readonly","detail":"ownerStatus","help":"第一位私聊者认领后自动更新；设置页可刷新查看。此信息保存在 Channel Core 数据库，而不是旧渠道配置文件。"},{"key":"identityLinks","group":"会话与输入","label":"跨渠道身份绑定","type":"list","help":"可选的高级功能：每行 用户ID=共同身份标识，用于跨渠道共用同一个 Session。仅共享长期记忆时无需设置此项。"},{"key":"streaming.mode","group":"回复与附件","label":"回复显示方式","type":"select","options":[["progress","执行进度（progress）"],["partial","实时正文（partial）"],["off","仅最终回复（off）"]],"help":"执行进度更新同一条卡片，完成后显示完整回答。"},{"key":"streaming.progress.toolProgress","group":"进度显示","label":"显示工具进度","type":"boolean","advanced":true,"when":{"streaming.mode":"progress"}},{"key":"streaming.progress.commentary","group":"进度显示","label":"显示简短执行说明","type":"boolean","advanced":true,"when":{"streaming.mode":"progress"},"help":"显示模型公开的执行说明，完成后由完整回答替换。"},{"key":"streaming.progress.toolDetail","group":"进度显示","label":"显示命令与目标摘要","type":"boolean","advanced":true,"when":{"streaming.mode":"progress"},"help":"在工具名后附上简短目标，例如“执行命令 · npm pack”；摘要经过脱敏，但不要在命令中放置凭证。"},{"key":"streaming.progress.narration","group":"进度显示","label":"显示思考片段（谨慎）","type":"boolean","advanced":true,"when":{"streaming.mode":"progress"},"help":"默认关闭。仅显示原始推理最新一行（截断），不保证脱敏；群聊请保持关闭。"},{"key":"streaming.progress.maxLines","group":"进度显示","label":"最多显示进度行数","type":"number","min":1,"max":12,"advanced":true,"when":{"streaming.mode":"progress"}},{"key":"streaming.progress.maxLineChars","group":"进度显示","label":"每行最多字符数","type":"number","min":40,"max":300,"advanced":true,"when":{"streaming.mode":"progress"}},{"key":"throttleMs","group":"回复与附件","label":"进度更新间隔（毫秒）","type":"number","min":400,"max":5000},{"key":"attachments","group":"回复与附件","label":"接收附件","type":"boolean"},{"key":"maxAttachmentMB","group":"回复与附件","label":"单附件大小限制（MiB）","type":"number","min":1,"max":20}],"packageName":"dsh-channel-core"}};
  const bundledConfigCss="\n      .dpc-page{max-width:760px;color:var(--dsw-alias-label-primary);font-size:14px}\n      .dpc-page p,.dpc-page small{line-height:1.65;color:var(--dsw-alias-label-secondary)}\n      .dpc-page [role=alert]{color:var(--dsw-alias-state-error-primary,#d64545)}\n      .dpc-group+.dpc-group{margin-top:28px}.dpc-group h4{margin:0 0 8px;font-size:14px;font-weight:600}\n      .dpc-field{display:grid;grid-template-columns:minmax(180px,1fr) minmax(160px,280px);gap:24px;padding:18px 0;border-bottom:1px solid var(--dsw-alias-border-l2);align-items:center}\n      .dpc-label label{line-height:22px;font-weight:500}.dpc-label small{display:block;margin-top:4px;font-size:12px}\n      .dpc-control{min-width:0}.dpc-boolean .dpc-control{justify-self:end}\n      .dpc-field input:not([type=checkbox]),.dpc-field select,.dpc-field textarea{box-sizing:border-box;width:100%;padding:9px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:inherit;font:inherit}.dpc-field textarea{resize:vertical;line-height:1.6}\n      .dpc-actions{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-top:24px}\n      .dpc-order{margin:0;padding:0;list-style:none;display:grid;gap:4px}.dpc-order li{display:flex;align-items:center;gap:12px;padding:10px 12px;border-radius:10px;background:var(--dsw-alias-bg-layer-2)}\n      .dpc-rank{font-size:12px;color:var(--dsw-alias-label-tertiary);width:20px;text-align:center;font-variant-numeric:tabular-nums}.dpc-provider-name{flex:1}.dpc-order-actions{display:flex;gap:2px}.dpc-arrow{min-width:28px;padding:0!important}\n      .dpc-providers,.dpc-order{grid-template-columns:1fr;gap:12px}.dpc-choice{display:inline-flex;gap:4px;margin:4px 12px 4px 0}\n      .dpc-note{font-size:12px}.dpc-path{overflow-wrap:anywhere;margin-top:16px;color:var(--dsw-alias-label-tertiary);font-size:12px}.dpc-path code{display:block;margin-top:8px;user-select:text}\n      .dpc-credentials{border-top:1px solid var(--dsw-alias-border-l2);margin-top:24px;padding-top:18px}.dpc-credentials fieldset{border:0;padding:0;min-width:0}.dpc-page summary{cursor:pointer;line-height:22px}\n      .dpc-credentials:first-child{border-top:0;margin-top:0;padding-top:0;margin-bottom:28px}.dpc-credentials h4{margin:0;font-size:14px;font-weight:600}\n      .dpc-advanced{margin-top:28px;padding:18px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px}.dpc-advanced>summary{font-weight:500}.dpc-advanced[open]>summary{margin-bottom:20px}\n      .dpc-credentials .dpc-field{grid-template-columns:140px minmax(0,1fr) auto;gap:14px}.dpc-credentials .dpc-actions{margin:0}\n      .dpc-page :is(select,input,textarea):focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4d6bfe);outline-offset:3px}\n      [data-plugin-detail=\"dsh-channel-core\"] [data-plugin-rows]:has(>ul>[data-plugin-row]:only-child):not(:has([data-state=failed],[data-state=off])){display:none}\n      @media(max-width:620px){.dpc-field,.dpc-credentials .dpc-field{grid-template-columns:1fr;gap:10px}.dpc-boolean{grid-template-columns:1fr auto;gap:20px}}\n    ";
  function ChannelConfigPanel({connection,credentialApi,kind}) {
    const page=bundledChannelPanels[kind];
    const scope=React.useMemo(()=>createConfigScope(connection,page.endpoint),[connection,kind]);
    React.useEffect(()=>()=>scope.close(),[scope]);
    const refs=page.credentialFields;
    const credentials=refs?value=>Object.fromEntries(Object.entries(refs).map(([key,label])=>[value[key],label])):undefined;
    return e(FileConfigPage,{...page,scope,credentialApi,credentials,credentialTitle:kind==='discord'?'Discord Bot Token':'飞书应用密钥',credentialsFirst:kind==='discord'});
  }
  function ChannelBundlePage({connection,credentialApi,t}) {
    const [tab,setTab]=React.useState('general');
    const tabs=[['general','通用与会话'],['discord','Discord'],['feishu','飞书']];
    React.useEffect(()=>{
      const style=document.createElement('style');style.dataset.channelBundle='true';
      style.textContent=bundledConfigCss+'.dcb-tabs{display:flex;gap:8px;margin-bottom:22px;flex-wrap:wrap}.dcb-tabs button{padding:9px 16px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;color:inherit;background:var(--dsw-alias-bg-layer-2);cursor:pointer}.dcb-tabs button[aria-selected=true]{border-color:var(--dsw-alias-brand-primary,#4d6bfe);font-weight:650}';
      document.head.appendChild(style);return()=>style.remove();
    },[]);
    return e('div',{className:'dcb-root'},
      e('div',{className:'dcb-tabs',role:'tablist','aria-label':'渠道设置'},
        ...tabs.map(([key,label])=>e('button',{key,type:'button',role:'tab','aria-selected':tab===key,tabIndex:tab===key?0:-1,onClick:()=>setTab(key)},label))),
      ...tabs.map(([key,label])=>e('section',{key,role:'tabpanel','aria-label':label,hidden:tab!==key},
        key==='general'?e(ConfigPage,{t,connection}):e(ChannelConfigPanel,{connection,credentialApi,kind:key}))));
  }

    const NS = 'channelCoreSettings';
    const locales = {
      zh: {
        mode: '忙碌时收到新输入', steering: 'Steering · 补充当前任务', queue: 'Queue · 排队执行', interrupt: 'Interrupt · 结束当前轮后接收',
        steeringHelp: '新消息在步骤边界接入当前任务。', queueHelp: '新消息进入待办，在后续轮次执行。',
        interruptHelp: '使用原生取消结束当前轮，再接收新消息；待办遵循 DSH 原生规则。',
        sharedDM: '跨渠道共享私聊会话', sharedDMHelp: '已验证为同一人的渠道账号，在同一工作区和预设下共享会话。群聊与 thread 独立。',
        save: '保存', saving: '正在保存…', saved: '已保存', loading: '正在读取配置…', retry: '重新读取', discard: '放弃修改并重新读取',
        unsaved: '有未保存的修改', external: '配置已在其他页面或文件中修改，请重新读取后保存。',
        effect: '保存后立即生效，后续输入使用新配置。', file: '配置文件', readFailed: '读取失败，请确认插件已启用后重试。',
        saveFailed: '保存失败，请重试。', unavailable: '插件已停用或连接已断开，请重新启用或连接后重试。',
        invalid: '配置文件有误，当前继续使用上一次有效值。可以修正文件，或在这里保存有效配置。',
        summary: '设置多渠道输入策略与私聊会话共享。',
      },
      en: {
        mode: 'New input while busy', steering: 'Steering · add to the current task', queue: 'Queue · run in a later turn', interrupt: 'Interrupt · end this turn and accept input',
        steeringHelp: 'New messages join the current task at a step boundary.', queueHelp: 'New messages enter the inbox for a later turn.',
        interruptHelp: 'Use native cancellation, then accept the message. Pending input follows DSH native rules.',
        sharedDM: 'Share direct-message sessions across channels', sharedDMHelp: 'Verified accounts for the same person share sessions within the same workspace and preset. Groups and threads remain separate.',
        save: 'Save', saving: 'Saving…', saved: 'Saved', loading: 'Loading configuration…', retry: 'Reload', discard: 'Discard changes and reload',
        unsaved: 'Unsaved changes', external: 'Configuration changed in another page or file. Reload before saving.',
        effect: 'Changes apply immediately to subsequent input.', file: 'Configuration file', readFailed: 'Could not load configuration. Enable the plugin and retry.',
        saveFailed: 'Could not save. Please retry.', unavailable: 'The plugin is disabled or disconnected. Enable it or reconnect and retry.',
        invalid: 'The configuration file is invalid. The last valid values remain active. Fix the file or save valid values here.',
        summary: 'Configure multi-channel input policy and shared direct-message sessions.',
      },
    };
    const same = (a, b) => a && b && a.defaultMode === b.defaultMode && a.sharedDM === b.sharedDM && a.schemaVersion === b.schemaVersion;
    const css = `
      .dcc-config{max-width:680px;color:var(--dsw-alias-label-primary);font-size:14px}
      .dcc-config fieldset{border:0;padding:0;margin:0;min-width:0}.dcc-config fieldset:disabled{opacity:.65}
      .dcc-field{display:block;padding:18px 0;border-bottom:1px solid var(--dsw-alias-border-l2)}
      .dcc-title{display:block;font-weight:600;margin-bottom:9px}.dcc-help{font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.65;margin:8px 0 0}
      .dcc-select{width:100%;max-width:370px;padding:9px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;color:inherit;background:var(--dsw-alias-bg-base);font:inherit}
      .dcc-check{display:flex;align-items:center;justify-content:space-between;gap:24px}.dcc-check .dcc-title{margin:0}
      .dcc-actions{display:flex;align-items:center;flex-wrap:wrap;gap:10px;margin-top:20px}
      .dcc-button{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base);color:inherit;padding:8px 14px;cursor:pointer;font:inherit}
      .dcc-button[type=submit]{background:var(--dsw-alias-brand-primary,#4d6bfe);color:white;border-color:transparent}.dcc-button:disabled{opacity:.5;cursor:default}
      .dcc-config :is(button,select,input):focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4d6bfe);outline-offset:3px}
      .dcc-notice{margin-top:14px;font-size:12px;line-height:1.65;color:var(--dsw-alias-label-secondary)}
      .dcc-error{color:var(--dsw-alias-state-error-primary,#d64545)}.dcc-file{margin-top:24px;font-size:12px;color:var(--dsw-alias-label-tertiary)}
      .dcc-file code{display:block;margin-top:6px;overflow-wrap:anywhere;user-select:text}
      .dcc-management{margin-top:32px;border-top:1px solid var(--dsw-alias-border-l2);padding-top:24px}.dcc-management h3{font-size:16px;margin:0 0 12px}.dcc-management h4{font-size:14px;margin:18px 0 8px}
      .dcc-accounts,.dcc-bindings{display:grid;gap:10px}.dcc-account,.dcc-binding{padding:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px}.dcc-account{display:flex;gap:12px;align-items:start}.dcc-account span{min-width:0}.dcc-account code,.dcc-binding code{font-size:12px;overflow-wrap:anywhere}.dcc-binding select{max-width:100%;margin-top:10px}
      .dcc-review{margin-top:18px;padding:16px;border:1px solid var(--dsw-alias-brand-primary,#4d6bfe);border-radius:12px}.dcc-review-group{padding:12px 0;border-bottom:1px solid var(--dsw-alias-border-l2)}.dcc-review-group ul{padding-left:20px}.dcc-id-input{box-sizing:border-box;width:100%;max-width:370px;padding:9px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;font:inherit;color:inherit;background:var(--dsw-alias-bg-base)}
      [data-plugin-detail="dsh-channel-core"] [data-plugin-rows]:has(>ul>[data-plugin-row]:only-child):not(:has([data-state=failed],[data-state=off])){display:none}
    `;

    class ConfigClient {
      constructor(connection) { this.connection = connection; this.requests = new Set(); this.closed = false }
      async call(method, args) {
        if (this.closed) throw new Error('Plugin configuration is unavailable');
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        this.requests.add(controller);
        try {
          const result = await this.connection.rpc.call('/api', 'channelCore/' + method, { args }, controller.signal);
          if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code });
          return result.value;
        } finally { clearTimeout(timeout); this.requests.delete(controller) }
      }
      get() { return this.call('getConfig', {}) }
      save(value, revision) { return this.call('setConfig', { value, revision }) }
      close() { this.closed = true; for (const request of this.requests) request.abort(); this.requests.clear() }
    }

    const BindingPanel=React.forwardRef(function BindingPanel({connection,onApplied},ref){
      const [state,setState]=React.useState({catalog:null,loading:true,busy:false,error:'',review:null,choices:{},selected:[],identity:'',saved:''});
      const client=React.useRef(null),epoch=React.useRef(0),serial=React.useRef(0),busy=React.useRef(false);
      const refresh=React.useCallback(async()=>{if(busy.current)return;const generation=epoch.current,request=++serial.current;
        try{const catalog=await client.current.call('bindingCatalog',{});if(epoch.current===generation&&serial.current===request)setState(value=>({...value,catalog,loading:false,error:''}));}
        catch(error){if(epoch.current===generation&&serial.current===request)setState(value=>({...value,loading:false,error:error.message}));}
      },[]);
      React.useEffect(()=>{epoch.current++;const owner=new ConfigClient(connection);client.current=owner;busy.current=false;void refresh();const focus=()=>{if(!document.hidden)void refresh();};window.addEventListener('focus',focus);document.addEventListener('visibilitychange',focus);return()=>{epoch.current++;serial.current++;owner.close();window.removeEventListener('focus',focus);document.removeEventListener('visibilitychange',focus);};},[connection,refresh]);
      const preview=async request=>{if(busy.current)return;busy.current=true;const generation=epoch.current,sequence=++serial.current;setState(value=>({...value,busy:true,error:'',saved:''}));
        try{const catalog=await client.current.call('bindingCatalog',{}),review=await client.current.call('previewBindings',{request,revision:catalog.revision});if(epoch.current===generation&&serial.current===sequence)setState(value=>({...value,catalog,review,choices:Object.fromEntries(review.groups.map(group=>[group.id,request.kind==='binding'&&group.currentSessions.length===1?group.currentSessions[0]:'new'])),busy:false}));}
        catch(error){if(epoch.current===generation&&serial.current===sequence)setState(value=>({...value,busy:false,error:error.message}));throw error;}
        finally{if(epoch.current===generation)busy.current=false;}
      };
      React.useImperativeHandle(ref,()=>({previewSharing:config=>preview({kind:'sharing',sharedDM:config.sharedDM,config})}));
      const propose=request=>{void preview(request).catch(()=>{});};
      const apply=async()=>{if(busy.current||!state.review)return;busy.current=true;const generation=epoch.current,request=++serial.current;setState(value=>({...value,busy:true,error:'',saved:''}));
        try{await client.current.call('applyBindings',{proposalId:state.review.id,decisions:state.review.groups.map(group=>({id:group.id,sessionId:state.choices[group.id]})),confirmation:state.review.id});const catalog=await client.current.call('bindingCatalog',{});if(epoch.current===generation&&serial.current===request){setState(value=>({...value,catalog,review:null,selected:[],busy:false,saved:'已应用，后续输入使用新的绑定。'}));onApplied(state.review.kind);}}
        catch(error){if(epoch.current===generation&&serial.current===request)setState(value=>({...value,busy:false,error:error.message}));}
        finally{if(epoch.current===generation)busy.current=false;}
      };
      const selected=state.catalog?.aliases.filter(alias=>state.selected.includes(JSON.stringify([alias.provider,alias.accountId,alias.userId])))??[];
      const cancel=async()=>{if(busy.current||!state.review)return;busy.current=true;const generation=epoch.current;setState(value=>({...value,busy:true,error:''}));
        try{await client.current.call('cancelBindings',{proposalId:state.review.id});if(epoch.current===generation)setState(value=>({...value,review:null,busy:false,saved:'已取消审阅，现有路由保持不变。'}));}
        catch(error){if(epoch.current===generation)setState(value=>({...value,busy:false,error:error.message}));}finally{if(epoch.current===generation)busy.current=false;}
      };
      const aliasLabel=alias=>(alias.provider==='discord'?'Discord':'飞书')+' · '+alias.accountId+' · '+alias.userId;
      return e('section',{className:'dcc-management','aria-busy':state.loading||state.busy},
        e('h3',null,'身份与会话绑定'),e('p',{className:'dcc-help'},'先选择真实渠道账号，再审阅会话范围。确认同一人后可共享私聊；群聊和线程保持各自范围。'),
        state.loading?e('p',{role:'status'},'正在读取渠道账号与会话…'):null,
        state.catalog?e(React.Fragment,null,
          state.catalog.truncated?e('p',{className:'dcc-help'},'账号或绑定超过 500 项，当前展示前 500 项。'):null,
          e('h4',null,'渠道账号'),state.catalog.aliases.length?e('div',{className:'dcc-accounts'},...state.catalog.aliases.map(alias=>{const key=JSON.stringify([alias.provider,alias.accountId,alias.userId]);return e('label',{key,className:'dcc-account'},e('input',{type:'checkbox',checked:state.selected.includes(key),disabled:state.busy||alias.source==='channel-config',onChange:event=>{const checked=event.target.checked;setState(value=>({...value,selected:checked?[...value.selected,key]:value.selected.filter(item=>item!==key)}));}}),e('span',null,e('strong',null,aliasLabel(alias)),e('p',{className:'dcc-help'},alias.verified?'身份已确认':'尚未跨渠道绑定',' · ',e('code',null,alias.identityId),alias.source==='channel-config'?'；在对应渠道页管理此映射。':'')));})):e('p',{className:'dcc-help'},'尚无已接收的渠道账号。让账号先向机器人发送一条消息后，这里即可选择。'),
          selected.length?e(React.Fragment,null,e('label',{className:'dcc-field'},e('span',{className:'dcc-title'},'共同身份标识（可选）'),e('input',{className:'dcc-id-input',value:state.identity,maxLength:256,disabled:state.busy,onChange:event=>{const identity=event.target.value;setState(value=>({...value,identity}));}}),e('p',{className:'dcc-help'},'留空创建新的共同身份；填写已有标识时，审阅会包含该身份的现有账号。')),
            e('div',{className:'dcc-actions'},e(Button,{type:'button',variant:'outline',disabled:state.busy,onClick:()=>propose({kind:'link',aliases:selected,identityId:state.identity})},'审阅身份绑定'),selected.length===1?e(Button,{type:'button',variant:'outline',disabled:state.busy,onClick:()=>propose({kind:'unlink',aliases:selected})},'审阅解除绑定'):null)):null,
          e('h4',null,'当前渠道绑定'),e('p',{className:'dcc-help'},'列出后续消息使用的会话。审阅用于切换路由，关闭审阅后绑定仍会显示。'),state.catalog.bindings.length?e('div',{className:'dcc-bindings'},...state.catalog.bindings.map(binding=>e('div',{key:binding.id,className:'dcc-binding'},e('strong',null,(binding.provider==='discord'?'Discord':'飞书')+' · '+(binding.kind==='dm'?'私聊':binding.kind==='thread'?'线程':'群聊')+' · '+binding.conversationId),e('p',{className:'dcc-help'},e('code',null,binding.sessionId),' · ',({running:'执行中',idle:'已加载 · 空闲','awaiting-user':'等待回答','awaiting-approval':'等待审批',inactive:'未加载'})[binding.activity]??binding.activity),e('p',{className:'dcc-help'},'预设：',binding.scope.presetId,' · 记忆域：',binding.scope.memoryNamespace),
            e('div',{className:'dcc-actions'},e('select',{className:'dcc-select','aria-label':'输入方式 '+binding.id,disabled:state.busy,value:binding.inboundMode??'inherit',onChange:event=>propose({kind:'binding',bindingId:binding.id,inputMode:event.target.value})},...['inherit','steering','queue','interrupt'].map(value=>e('option',{key:value,value},({inherit:'跟随渠道设置',steering:'Steering：加入当前任务',queue:'Queue：排队',interrupt:'Interrupt：取消当前轮后接收'})[value]))),e(Button,{type:'button',variant:'outline',disabled:state.busy,onClick:()=>propose({kind:'binding',bindingId:binding.id})},'管理会话'))))):e('p',{className:'dcc-help'},'接收消息后显示对应会话。'),
          state.catalog.historical?.length?e('details',null,e('summary',null,'历史绑定 · '+state.catalog.historical.length),state.catalog.historical.map(binding=>e('p',{className:'dcc-help',key:binding.id},binding.provider,' · ',e('code',null,binding.sessionId),' · 已不使用此工作区路由'))):null,
          state.catalog.proposals.length?e('p',{className:'dcc-help',role:'status'},'有 ',state.catalog.proposals.length,' 个操作需要重新核对。历史会话仍保留，请重新准备审阅。'):null
        ):null,
        state.review?e('div',{className:'dcc-review'},e('h4',null,'审阅后应用'),e('p',{className:'dcc-help'},'只调整后续输入的路由，既有会话内容保持原样。请为每个范围选择继续已有会话或新建。'),
          state.review.aliases.length?e('ul',null,...state.review.aliases.map(alias=>e('li',{key:aliasLabel(alias)},aliasLabel(alias),' → ',e('code',null,alias.after)))):null,
          ...state.review.groups.map(group=>e('div',{className:'dcc-review-group',key:group.id},e('strong',null,group.workspace),e('p',{className:'dcc-help'},'预设：',group.scope.presetId,' · 记忆域：',group.scope.memoryNamespace),e('ul',null,...group.members.map(member=>e('li',{key:member.id},aliasLabel(member),' · ',member.conversationId,' · ',e('code',null,member.sessionId)))),e('select',{className:'dcc-select','aria-label':'目标会话 '+group.id,disabled:state.busy,value:state.choices[group.id],onChange:event=>{const sessionId=event.target.value;setState(value=>({...value,choices:{...value.choices,[group.id]:sessionId}}));}},e('option',{value:'new'},'新建会话'),...group.options.map(sessionId=>e('option',{key:sessionId,value:sessionId},'继续 '+sessionId))))),
          e('div',{className:'dcc-actions'},e(Button,{type:'button',variant:'primary',disabled:state.busy,onClick:()=>{void apply();}},state.busy?'正在应用…':'确认应用'),e(Button,{type:'button',variant:'outline',disabled:state.busy,onClick:()=>{void cancel();}},'取消审阅'))):null,
        state.error?e('div',{className:'dcc-notice dcc-error',role:'alert'},state.error,e('div',{className:'dcc-actions'},e(Button,{type:'button',variant:'outline',disabled:state.busy,onClick:()=>{void refresh();}},'重新读取'))):null,
        state.saved?e('p',{className:'dcc-help',role:'status'},state.saved):null
      );
    });

    function ConfigPage({ connection, t }) {
      const [state, setState] = React.useState({ snapshot: null, draft: null, loading: true, saving: false, error: '', external: false, saved: false });
      const client = React.useRef(null);
      const sequence = React.useRef(0);
      const mounted = React.useRef(false);
      const busy = React.useRef(false);
      const management=React.useRef(null);
      const reload = React.useCallback(async (discard = false) => {
        if (busy.current) return;
        const request = ++sequence.current;
        setState(previous => ({ ...previous, loading: !previous.snapshot, error: '', saved: false }));
        try {
          const snapshot = await client.current.get();
          if (!mounted.current || sequence.current !== request) return;
          setState(previous => {
            const dirty = previous.draft && !same(previous.draft, previous.snapshot?.value);
            if (dirty && !discard) return { ...previous, loading: false, external: snapshot.revision !== previous.snapshot.revision };
            return { snapshot, draft: { ...snapshot.value }, loading: false, saving: false, error: '', external: false, saved: false };
          });
        } catch (error) {
          if (mounted.current && sequence.current === request) setState(previous => ({ ...previous, loading: false, error: t('readFailed') }));
        }
      }, [t]);
      React.useEffect(() => {
        mounted.current = true;
        busy.current = false;
        const owner = new ConfigClient(connection);
        client.current = owner;
        void reload();
        const focus = () => { void reload() };
        window.addEventListener('focus', focus);
        return () => { mounted.current = false; sequence.current++; owner.close(); window.removeEventListener('focus', focus) };
      }, [connection, reload]);
      const dirty = !same(state.draft, state.snapshot?.value);
      const edit = (field, value) => setState(previous => ({ ...previous, draft: { ...previous.draft, [field]: value }, saved: false }));
      const save = async event => {
        event.preventDefault();
        if (busy.current || !state.snapshot || state.external) return;
        busy.current = true;
        const request = ++sequence.current;
        setState(previous => ({ ...previous, saving: true, error: '', saved: false }));
        try {
          if(state.draft.sharedDM!==state.snapshot.value.sharedDM){await management.current.previewSharing(state.draft);if(mounted.current&&sequence.current===request)setState(previous=>({...previous,saving:false}));return;}
          const snapshot = await client.current.save(state.draft, state.snapshot.revision);
          if (mounted.current && sequence.current === request) setState({ snapshot, draft: { ...snapshot.value }, loading: false, saving: false, error: '', external: false, saved: true });
        } catch (error) {
          if (mounted.current && sequence.current === request) setState(previous => ({ ...previous, saving: false,
            external: error.code === 'channel-config/config-conflict', error: error.code === 'channel-config/config-conflict'||error.code?.startsWith('channel-binding/') ? '' : error.message || t('saveFailed'),
          }));
        } finally { if (sequence.current === request) busy.current = false }
      };
      return e('form', { className: 'dcc-config', onSubmit: save, 'aria-busy': state.loading || state.saving },
        state.loading ? e('p', { role: 'status' }, t('loading')) : null,
        state.snapshot ? e('fieldset', { disabled: state.saving || state.loading },
          e('label', { className: 'dcc-field' }, e('span', { className: 'dcc-title' }, t('mode')),
            e('select', { className: 'dcc-select', value: state.draft.defaultMode, onChange: event => edit('defaultMode', event.target.value) },
              ...['steering', 'queue', 'interrupt'].map(value => e('option', { key: value, value }, t(value)))),
            e('p', { className: 'dcc-help' }, t(state.draft.defaultMode + 'Help'))),
          e('div', { className: 'dcc-field' },
            e('div', { className: 'dcc-check' }, e('span', { className: 'dcc-title' }, t('sharedDM')),
              e(Switch, { label: t('sharedDM'), checked: state.draft.sharedDM, disabled: state.saving || state.loading, onChange: value => edit('sharedDM', value) })),
            e('p', { className: 'dcc-help' }, t('sharedDMHelp'))),
        ) : null,
        state.snapshot?.error ? e('p', { className: 'dcc-notice dcc-error', role: 'alert' }, t('invalid'), ' ', state.snapshot.error.message) : null,
        state.external ? e('p', { className: 'dcc-notice dcc-error', role: 'alert' }, t('external')) : null,
        state.error ? e('p', { className: 'dcc-notice dcc-error', role: 'alert' }, state.error) : null,
        e('div', { className: 'dcc-actions' },
          state.snapshot ? e(Button, { variant: 'primary', type: 'submit', disabled: state.saving || state.loading || state.external || (!dirty && !state.snapshot.error) }, t(state.saving ? 'saving' : 'save')) : null,
          state.external || state.error ? e(Button, { variant: 'outline', type: 'button', disabled: state.saving || state.loading, onClick: () => { void reload(true) } }, t(dirty && state.snapshot ? 'discard' : 'retry')) : null,
          e('span', { className: 'dcc-help', role: 'status' }, state.saved ? t('saved') : state.snapshot && dirty ? t('unsaved') : ''),
        ),
        e('p', { className: 'dcc-notice' }, t('effect')),
        state.snapshot ? e('details', { className: 'dcc-file' }, e('summary', null, t('file')), e('code', null, state.snapshot.configFile)) : null,
        state.snapshot?e(BindingPanel,{ref:management,connection,onApplied:kind=>{void reload(kind==='sharing');}}):null,
      );
    }

    return {
      inject: ['slots', 'locale', 'connection', 'remote', 'remote.credentials'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, locales));
        ctx.effect(() => {
          const style = document.createElement('style');
          style.textContent = css; document.head.appendChild(style);
          return () => style.remove();
        });
        ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
          name: 'plugins.bundle.config', key: 'dsh-channel-core', locale: NS,
        }, ({ t, view }) => view === 'summary' ? t('summary') : e(ChannelBundlePage, { t, connection: ctx.connection, credentialApi: ctx.remote?.credentials })));
      },
    };
  },
});
