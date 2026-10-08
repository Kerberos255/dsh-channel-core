import fs from 'node:fs';
import path from 'node:path';
import { PluginConfig } from './channel-plugin-settings/remote-config.js';
import { ChannelRuntime } from './channel-runtime.js';
import { schema as discordSchema } from '../channels/discord/config.js';
import { createTransport as discordTransport } from '../channels/discord/transport.js';
import { schema as feishuSchema } from '../channels/feishu/config.js';
import { createTransport as feishuTransport } from '../channels/feishu/transport.js';

const channels=[
  {name:'discord',schema:discordSchema,service:'discordChannelSettings',
   credentialRefs:config=>[config.tokenRef]},
  {name:'feishu',schema:feishuSchema,service:'feishuChannelSettings',
   credentialRefs:config=>[config.appSecretRef]},
];

/** Copy old config into the single-package namespace without moving/deleting the original. */
export function migrateChannelConfigs(home) {
  const plugins=path.resolve(home,'..','plugins');
  const result=[];
  for(const {name} of channels){
    const previous=path.join(plugins,'dsh-channel-'+name,'config.json');
    const current=path.join(plugins,'dsh-channel-core','channels',name,'config.json');
    if(fs.existsSync(current)){result.push({name,result:'existing'});continue;}
    if(!fs.existsSync(previous)){result.push({name,result:'defaults'});continue;}
    fs.mkdirSync(path.dirname(current),{recursive:true});
    try{fs.copyFileSync(previous,current,fs.constants.COPYFILE_EXCL);result.push({name,result:'copied'});}
    catch(error){if(error.code==='EEXIST')result.push({name,result:'existing'});else throw error;}
  }
  return result;
}

/** The Core owns both adapters, but each keeps its own credentials, RPC service and lifecycle. */
export function registerChannelAdapters(ctx,core){
  const hosts=[];
  const specs=[
    {...channels[0],createTransport:(deps,sdk)=>discordTransport({...deps,host:{
      modelCatalog:()=>ctx.sessionController.modelCatalog(),
      projections:request=>ctx.sessionController.projections(request),
      selectModel:request=>ctx.sessionController.selectModel(request),
    }},sdk)},
    {...channels[1],createTransport:feishuTransport},
  ];
  for(const spec of specs){
    let runtime;
    const settings=new PluginConfig(ctx,{
      service:spec.service,packageName:'dsh-channel-core/channels/'+spec.name,
      schema:spec.schema,details:()=>runtime?.details(),action:()=>runtime.reconfigure(),
    });
    runtime=new ChannelRuntime(ctx,settings,{
      provider:spec.name,credentialRefs:spec.credentialRefs,createTransport:spec.createTransport,core,
    });
    hosts.push(runtime);
    ctx.effect(()=>{void runtime.reconfigure();return()=>runtime.close();});
  }
  return hosts;
}
