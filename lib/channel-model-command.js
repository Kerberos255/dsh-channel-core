import { currentSelection, decodeModel, defaultEffort, describeSelection, findModel, effortChoices } from '../channels/discord/model-commands.js';

/** Same native Host model interface as Discord; returned text is safe to show
 * after ChannelRuntime's sender/owner checks and ChannelCore's binding checks. */
export async function channelModelCommand(controller, sessionId, command, input) {
  if(!controller?.modelCatalog||!controller?.projections||!controller?.selectModel)
    return '当前 DSH Host 不支持模型命令。';
  const catalog=await controller.modelCatalog();
  const selected=currentSelection(catalog,await controller.projections({sessionId}));
  const args=String(input??'').trim();
  const bullet=rows=>rows.map(row=>'• '+row).join('\n');
  const candidates=groups=>groups.flatMap(group=>(group.models??[]).map(entry=>({provider:group.id,model:entry.id,name:entry.name??entry.id})));
  const display=rows=>bullet(rows.slice(0,50).map(item=>item.provider+'/'+item.model+' · '+item.name))+(rows.length>50?'\n（其余 '+(rows.length-50)+' 个模型未显示）':'');
  if(command==='model'){
    if(!args){
      const listed=candidates(catalog?.groups??[]);
      return '当前模型：'+describeSelection(catalog,selected)+'\n\n使用 /model provider/model 切换；单模型提供方也可直接使用 /model provider。\n\n可选模型：\n'+(listed.length?display(listed):'（无可用模型）');
    }
    let chosen=decodeModel(args);
    if(!chosen){
      // Only an exact provider ID resolves; never auto-select from multiple models.
      const matches=(catalog?.groups??[]).filter(group=>group.id===args);
      if(matches.length!==1)return '未找到这个提供方。使用 /model 查看可选的提供方和模型。';
      const models=candidates(matches);
      if(!models.length)return '提供方 '+args+' 当前没有可用模型。';
      if(models.length>1)return '提供方 '+args+' 有 '+models.length+' 个可选模型，请指定完整名称：\n\n'+display(models)+'\n\n使用 /model provider/model 切换。';
      chosen={provider:models[0].provider,model:models[0].model};
    }
    if(!findModel(catalog,chosen.provider,chosen.model))
      return '未找到这个模型。使用 /model 查看可选的 provider/model。';
    const effort=defaultEffort(catalog,chosen.provider,chosen.model);
    const result=await controller.selectModel({sessionId,...chosen,...(effort===undefined?{}:{reasoningEffort:effort})});
    return '已切换模型：'+describeSelection(catalog,result?.selected??{...chosen,reasoningEffort:effort})+'\n从下一次请求开始生效。';
  }
  if(command==='think'){
    if(!selected?.provider||!selected?.model)return '当前会话尚未选择模型，请先用 /model。';
    const choices=effortChoices(catalog,selected.provider,selected.model);
    if(!choices.length)return '当前模型 '+selected.model+' 没有公布可选的推理强度。';
    const list=bullet(choices.map(c=>c.value+' · '+c.name));
    if(!args)return '当前推理强度：'+describeSelection(catalog,selected)+'\n\n使用 /think 强度ID 切换。\n\n可选强度：\n'+list;
    const found=choices.find(c=>c.value===args);
    if(!found)return '推理强度不可用。\n\n使用 /think 强度ID 切换。\n\n可选强度：\n'+list;
    const result=await controller.selectModel({sessionId,provider:selected.provider,model:selected.model,reasoningEffort:found.value});
    return '推理强度已更新：'+describeSelection(catalog,result?.selected??{...selected,reasoningEffort:found.value})+'\n从下一次请求开始生效。';
  }
  throw new Error('unsupported-model-command');
}
