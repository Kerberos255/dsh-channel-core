import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url));
const plugins=path.resolve(here,'..');
const source=fs.readFileSync(path.join(here,'client.template.js'),'utf8');
const common=fs.readFileSync(path.join(plugins,'tools/settings/settings-client.inc.js'),'utf8');
const helpers=common.split('function installConfigPage(ctx, options) {')[0];
if(!helpers.includes('function FileConfigPage')||!helpers.includes('function CredentialsPage'))throw Error('shared config client changed');
const cssStart=common.indexOf('style.textContent = `');
const cssEnd=common.indexOf('`;\n',cssStart);
if(cssStart<0||cssEnd<0)throw Error('shared CSS not found');
const css=common.slice(cssStart+'style.textContent = `'.length,cssEnd).replaceAll('${options.packageName}','dsh-channel-core');
const pages=JSON.parse(fs.readFileSync(path.join(plugins,'tools/settings/pages.json'),'utf8'));
const adapt={
  discord:{...pages['dsh-channel-discord'],packageName:'dsh-channel-core',endpoint:'discordChannelSettings'},
  feishu:{...pages['dsh-channel-feishu'],packageName:'dsh-channel-core',endpoint:'feishuChannelSettings'},
};
if(adapt.discord.fields.length<5||adapt.feishu.fields.length<5)throw Error('missing channel settings');
const clientComponent=`
  const bundledChannelPanels=${JSON.stringify(adapt)};
  const bundledConfigCss=${JSON.stringify(css)};
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
`;
const output=source.replace('/* CHANNEL_COMPONENTS_RENDERER */',helpers+'\n'+clientComponent);
if(output===source||!output.includes('ChannelBundlePage'))throw Error('template insertion failed');
const target=path.join(plugins,'lib/client.js');
fs.writeFileSync(target,output);
console.log('built '+target+' length '+output.length);
