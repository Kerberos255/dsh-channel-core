# DSH 渠道与会话（Channel Core）

[English](README.md) · [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) · [安全说明](SECURITY.md)

**一个插件同时接入 Discord 与飞书（Lark）**，并统一管理身份核验、私聊 Session 绑定、消息投递和流式进度；Agent、历史、任务执行仍交给 DSH 原生服务。

## 主要功能

- Discord、飞书共用渠道桥接层，但各自保留独立凭证、收发设置和连接生命周期。
- 可让已确认是同一人的两个平台账号**共用同一个原生私聊 Session**；仅共享已核验长期记忆不要求共用 Session。
- 持久输入账本、重复投递去重、同 Session 顺序接纳及原生 steering / queue / interrupt。
- Discord Ask User 交互、飞书/Discord 进度显示；配合 Status Cards 查询当前会话的只读状态。
- 主人身份与工作区范围核验，防止未授权私聊读取私人记忆或继承其他人的历史。

## 主动消息投递

**会话界面已精简**：不再额外添加无效的「外发记录」选项卡。通用外发归档仍可用 `channel_send` 的 `action=list/read` 只读检索。本机私有新闻桥会在飞书确认发送后，另外通过 DSH 原生 Session Controller 把已投递新闻同步为「飞书-新闻」的真实会话回合；不会直接修改日志文件，也不会为了补录而重复发送飞书。

Channel Core 现支持**无需用户先发送消息的主动投递**。Agent 可以通过 `channel_send` 向自己原生 DSH Session **已经绑定、且当前授权有效**的飞书或 Discord 会话发送纯文本消息；定时任务、Dream 等可信插件也可调用 `ctx.channelCore.sendToBoundSession({ sessionId, text, idempotencyKey, bindingId?, source? })`，并通过 `outboundTargets(sessionId)` 查询可选的绑定 ID。

- **发送权限：** 只能发到当前 Session 已绑定的渠道。多目标需要显式填写 `bindingId`；不能随意填写任意群号或收件人，也不能跨 Session 发消息。发送前重新核验群聊允许列表和私聊/主人权限。
- **可靠性：** 使用原有的持久化发送队列及渠道适配器；稳定的 `idempotencyKey` 可防止重复群发。返回状态为 `pending`、`sent`、`failed` 或 `uncertain`，不确定是否送达时不会盲目重试。
- **使用方式：** 金融日报等任务可以先运行脚本、生成报告，然后显式调用 `channel_send`；插件也可直接调用内部接口。**不会自动向绑定的群聊广播所有定时任务结果**。
- **验证：** `npm test` 运行无需 DSH 宿主的公开回归；`npm run test:host` 需要兼容 DSH 宿主及其 peer 依赖。本地曾对飞书群完成真实发送与重启后幂等验证，公开 CI 不包含平台凭证。

## 流式进度、Ask User 和渠道命令

Discord 将思考、草稿和工具进度显示在滚动进度消息中。原生助手已提交的阶段性公开文字可在最终答复中用引用块与正文分开；私有推理、未提交草稿不会因此变成公开内容，实时草稿不附加虚构的“第一段”等标题。

飞书支持 CardKit 组件流式更新，并保留整卡兼容回退。思考和公开草稿独立控制，关闭思考不会隐藏草稿；完成后可以保留折叠的「📝 过程记录」。渠道刷新间隔、进度长度和状态脚注可分别配置。

两个渠道在 Ask User 回答提交后，原提问卡片变为包含问题与用户答案的只读回执，并移除可操作按钮。已发布的前文继续可见，不应在后续回复中重复发送。

Discord 提供平铺的 `/new`、`/stop`、`/status`、`/session`、`/answer`、`/prompt`、`/model`、`/think` 命令；飞书提供文本 `/new`、`/stop`、`/status`、`/session`、`/answer`、`/model`、`/think`。模型切换只在下一轮生效；同一 Provider 有多个模型时列出候选，不会随意猜选。

## 安装与兼容性

要求 DSH 提供原生会话、频道和插件服务；具体 peer 依赖见 [package.json](package.json)。

```sh
dsh plugin --profile desktop add github:Kerberos255/dsh-channel-core
```

Profile 名称按实际环境替换。首次安装或更新代码后重启 DSH。已有独立 Discord/飞书插件的用户，应先备份旧配置，再在当前 Profile 停用旧插件，避免双重收发；**不要删除现有会话和凭证数据**。

## 快速开始

1. 打开「设置 → 插件 → 渠道与会话」，分别进入 **通用与会话 / Discord / 飞书**。
2. 填写平台所需的机器人凭证以及明确的用户/频道允许规则。连接成功 ≠ 对所有来信放行。
3. 检查各渠道的「主人与记忆」设置：允许的首位私聊者可按配置认领，也可以选择手工指定。
4. 如需两平台共用相同原生私聊 Session，再建立身份关联并审阅会话绑定；工作区、预设不匹配时不能跨范围复用。
5. 用各渠道的测试私聊核对路由、消息续写、进度及状态。

## 身份、安全与故障处理

- 主人确认发生在消息通过渠道允许规则后，群聊不能冒充主人；换主人后旧身份不再获得共享私人记忆权限。
- 共享绑定及修改使用审阅记录、版本检查与提交后恢复核验；原始聊天历史不会因重新绑定而被删除。
- 重复投递和 Ask User 续写去重只清理确认过的重复部分；不确定状态保留证据，不擅自丢弃正文。
- 凭证交给 DSH Host；本机渠道配置位于 `DSH_HOME/plugins/dsh-channel-core/channels/` 下，勿将凭证、SQLite 或日志提交到公开仓库。
- 真实连接还受平台权限、网络代理和设备可达性影响；CI 的模拟测试不能替代实际收发验收。

配置模板：[config.example.json](config.example.json)，开发测试：`npm test`，发布历史：[CHANGELOG.md](CHANGELOG.md)。

相关：[状态卡片](https://github.com/Kerberos255/dsh-status-cards) · [Dream 与长期记忆](https://github.com/Kerberos255/dsh-memory-dreaming) · [无损上下文](https://github.com/Kerberos255/dsh-lossless-context)。

许可证：[MIT](LICENSE)。

## 任务通知（可选）

「通用与会话 → 任务通知」默认关闭。开启后显示「通知渠道」，可以从已配置并启用的飞书、Discord 中选择；没有可选渠道时显示「无」。自动任务确认失败时，Channel Core 才向**已核验的主人私聊**发送简短告警。目标从当前合法绑定动态解析，不保存可能因 `/new` 或归档失效的 Session ID；找不到唯一授权收件人时不发送，不尝试猜测。投递复用渠道的持久队列和幂等键；DSH 进程完全停止期间不能保证补发。

Dream 等插件不依赖 Channel Core，任务先持久记录失败，再选择性发布 `dsh/task-alert` 事件。仅自动任务第一次进入 `failed` 状态时通知；手动整理、正常完成和无新材料不通知。通知不包含原始会话、日记正文或模型错误细节，未安装 Channel Core 时 Dream 仍独立工作。

## Session 级只读外发归档

通过 Channel Core 的 `channel_send` 或 `sendToBoundSession` 主动投递到飞书、Discord 的消息（例如新闻、定时报告、任务异常提醒）会在外发前独立归档原文、来源、发送状态、时间和平台消息 ID。当前 Session 的模型可以通过唯一的只读工具 `channel_outbound_records` 检索、分页与读取；其它 Session 不能通过该模型工具访问。模型提示词只提供少量元数据，不会自动灌入整篇正文。读取不会重新发送消息或将外发内容伪装为用户消息，也不会直接成为 Dream 的输入。普通对话回复、绕过 Channel Core 的发送以及升级前的旧消息不自动补录。
