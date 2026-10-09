# dsh-channel-core

本地迁移的渠道协调层。执行和历史由官方 Agent、Inbox、Jobs、Subagent、Session Controller 管理。

安装“状态卡片”时，飞书和 Discord `/status` 共用 `statusCenter` 的只读快照。展示当前会话范围的运行、模型、权限、任务和插件健康；本机路径、整机额度、其他会话和正文不会发到渠道。未安装状态服务时保留简短的连接与输入方式说明。

登录连接与消息接收授权分开：凭证有效即可连接，未配置允许范围时不会进入会话。Discord 可显式选择接收服务器内所有用户和频道；私聊继续单独管理。

Host 网络设置位于安装根目录 `config.json` 的 `network`：默认 `proxyMode: system`，跟随已启用的 Windows HTTP 代理，显式环境代理优先。该 HTTP 代理同时转发 HTTP、HTTPS 与 WSS 请求，具体目的地如何分流交给代理软件的路由。其他模式为 `environment`、`direct`、`custom`（使用 `proxyUrl`）。`noProxy` 可增加直连目的地，本地回环地址始终直连。fetch 使用 Node 24.14+ 公开代理接口，SDK WebSocket 使用 Discord.js 官方推荐的 global-agent；设置启动时读取，修改后重新打开客户端。停用服务时恢复先前网络代理设置。

已实现：SQLite 输入账本、验证后的身份别名、按 workspace/preset/namespace 隔离的 SessionBinding、默认 steering（可改 queue/interrupt）、交互 token 的身份/期限/单次消费限制。

“设置 → 插件 → 渠道与会话”提供身份和会话绑定管理。选择已从平台接收过消息的账号后，可生成同一人身份链接或解除链接的审阅记录；每个受影响范围明确选择继续已有原生会话或新建，确认后生效。既有会话原文保持原样。共享/独立私聊模式的页面保存也进入这一审阅流程，单个绑定可覆盖输入方式。

审阅核验原生会话的实际工作区与预设，候选会话只来自受影响账号的相同范围；不同路由范围不能选同一目标。数据库保存身份确认的时间、来源和操作审计；渠道 JSON 里的 identityLinks 仍由对应渠道页管理，避免第二来源覆盖。原始 JSON 修改遵循后续输入路由规则。

绑定提交使用带期限的审阅记录、版本检查、串行提交和预分配的原生 Session ID。若在创建会话或写入共享设置后中断，重启可核对后续完成；外部状态已改变时留下“需要重新核对”，保留新状态。历史绑定与原生日志继续保留。

Stop 使用 DSH 原生 `sessionController.cancel()`。Web 按钮、快捷键与 RPC 由官方组件负责。RC2 原生取消当前 Agent 轮次，并保留 Inbox 待办。`interrupt` 调用同一个原生取消方法，再通过 `mode=queue` 接收新输入；`steering` 使用 `mode=steer`，`queue` 使用 `mode=queue`。

身份别名只能由可信 Host 管理操作验证，未经验证的跨渠道账号保持隔离。`receive()` 是可信渠道适配器使用的内部接口，后续适配器负责平台验签、账号及对话授权、附件上传和外部交付。

直接注入官方 `sessionController` 与 `workspaceController` 服务。渠道未指定工作区时通过官方 `initializeDefault()` 取得客户端默认工作区，并明确传入 Session 创建请求；没有默认工作区时提示设置目录，避免回落到 Host 启动目录。工作区按真实目录生成隔离标识，切换工作区后新输入绑定新会话，旧记录保留。

渠道输入在单 Session 内串行 admission，持久 receipt 阻止重放；接收状态不明确时标为 uncertain，避免重复执行。Web 输入继续由官方接收。固定兼容目标为桌面 `0.2.0-rc.2` 及 CLI `0.2.1-alpha.1`，通过隔离环境验收后再安装日常 profile。

测试：使用普通 Node 24+ 的 `node --test tests/core.test.mjs`。开发机使用 `tooling/node/node.exe`，测试状态临时文件在项目当前目录内，结束时清理。


## 0.4.1 单包组件模式（2026-10-08）

**安装一个 `dsh-channel-core` 即可同时获得 Discord、飞书两个内部 Adapter。** 两者共享 ChannelBridge、会话路由与消息交付，仍有独立配置、凭证和连接生命周期；一个渠道不可用不应阻塞另一个渠道。

- 设置入口：「设置 → 插件 → 渠道与会话」，页内三个标签 **通用与会话 / Discord / 飞书**，复用原有 RPC endpoint `discordChannelSettings`、`feishuChannelSettings`。
- 配置目录：`DSH_HOME/plugins/dsh-channel-core/channels/discord/config.json` 和 `...\feishu\config.json`。首次启动仅在新文件不存在时从旧 `dsh-channel-discord` / `dsh-channel-feishu` 目录 **复制**配置，不删除、覆盖旧文件；原凭证仍由 DSH 凭证管理存储。
- Core 代码：`channels/discord`、`channels/feishu` + `lib/channel-components.js`。源码设置页由 `tooling/dsh-channel-bundle/build-client.mjs` 生成；不要直接修改生成的 `lib/client.js`。
- 安装顺序：先备份旧 profile、旧渠道配置；打包安装 Core 0.4.0，移除旧 Discord/Feishu **安装条目**；旧配置仍留本机作为回退，原有 SQLite/session/身份数据不迁移、不删除；重启客户端确认 Core、Discord 和飞书服务正常注册。
- 本地回归：Core 60 项 + Discord 24 项 + 飞书 7 项（含 ConfigFile 读写兼容），安装验证另测实际三标签 UI、渠道连接与健康状态；没有飞书凭证时不宣称已完成真实飞书连接验收。


## 0.4.3 主人自动认领

Discord / 飞书的「主人与记忆」默认使用 **首次私聊认领**，认领操作在消息经过渠道允许规则后、进入 Session 之前完成。SQLite `channel_owners` 按渠道+机器人账号保存主人 userId；后续普通私聊、重连和重启都不能覆盖，群聊不能认领。设置页可以查看「当前主人」，或切换为「手动指定主人」，填写平台 userId 来替换；替换后旧主人立即失去工作区共享记忆访问资格。

两个渠道分别识别平台账号，但统一向 Memory 提供逻辑主人标识 `owner`，因此**不需要额外设置 identityLinks** 即可共享已发布个人记忆；如需真正复用同一个原生 Session 才需要另行设置跨平台身份映射。认领者仍需满足其它已配置的渠道接收规则。

## 自动轮转的渠道安全边界（0.4.6）

仅供 LCM 内部调用的 `rotateTrustedDM` 会再次核验 Dream 已完成的运行记录与交接文件哈希、旧/新原生会话的工作区与预设、主人身份、待处理渠道消息以及事件游标。通过后在一个 SQLite 事务内一起切换飞书/Discord 共享私聊绑定，并保存归档会话的已核验来源归属。旧历史不删除；历史身份读取时仍按当前账号归属重新验证。非私聊、未知主人、混合身份、跨工作区、缺少已核实记忆产物等情况一律拒绝自动切换。
