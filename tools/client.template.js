window.__ModuleLoader__.load({
  id: 'dsh-channel-core',
  factory(require) {
    const React = require('react');
    const { Switch, Button } = require('@deepseek-ai/dsh-client-ui-primitives');
    const e = React.createElement;
    /* CHANNEL_COMPONENTS_RENDERER */
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
