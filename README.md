# DSH 渠道与会话（Channel Core）

[English](README.en.md) · [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) · [安全说明](SECURITY.md)

一个插件接入 **Discord 与飞书（Lark）**，统一处理消息、原生 DSH Session 绑定、身份核验、进度显示及主动投递。

## 主要功能

- **连接与恢复**：两渠道独立配置和连接；断线时优先使用 SDK 原生重连，持续故障再限速恢复，并可刷新网络代理配置，无需重启 DSH。
- **会话与权限**：已核验的主人私聊可按配置跨渠道共用原生 Session；群聊和帖子使用持久绑定、允许列表和独立权限边界。
- **可靠投递**：入站去重、按会话顺序处理、持久发送队列，以及送达不确定时避免盲目重发。
- **交互体验**：流式进度、Ask User、模型切换及 `/new`、`/status`、`/session` 等渠道命令；飞书支持 CardKit 进度卡。
- **主动发送**：`channel_send` 可向当前 Session 已授权的渠道目标发送文字，或向飞书发送工作区内图片/文件；也支持由可信任务调用内部发送接口。
- **任务与记忆**：`/new` 安全迁移旧 Session 的活动定时任务；按条件支持会话日志轮转。配合记忆插件，已持久绑定的群聊/帖子可以共享同工作区记忆。

## 安装和配置

```sh
dsh plugin --profile desktop add github:Kerberos255/dsh-channel-core
```

将 `desktop` 换成实际 Profile。安装或更新后重启 DSH，然后打开 **设置 → 插件 → 渠道与会话**：

1. 配置 Discord 和/或飞书凭证、允许的用户及群聊范围。
2. 明确主人身份确认方式；只有通过准入规则的私聊才有资格认领主人。
3. 按需关联跨渠道私聊 Session，并分别设置进度、草稿与通知。
4. 在实际渠道发送测试消息，核对收发和进度。

## 常用命令与发送

- 两渠道支持 `/new`、`/stop`、`/status`、`/session`、`/answer`、`/model`、`/think`、`/reason`；飞书也支持 `/models`。
- `/new` 会在满足安全条件时迁移**活动**定时任务，再归档旧 Session；已失活的一次性任务不会重新创建。`/session` 仅切换会话，不迁移任务。
- 使用原生 DSH Schedule 让定时任务结果进入会话历史。需要主动投递时调用 `channel_send`；只能发送到当前 Session 的有效绑定，不能指定任意外部收件人。
- 飞书图片支持 PNG/JPEG/GIF/WebP（不超过 10 MiB）；普通文件不超过 30 MB，且必须在当前工作区。发送本地路径文本不等于真正上传附件。

## 安全与限制

- **群聊共享记忆可能在回复中披露私人事实。** 请只允许可信群接入；未核验的其他人私聊仍隔离。
- 群聊可按开关展示**公开正文草稿**，但模型的私人推理仅对已核验主人私聊开放。
- 停用的渠道不会自动恢复连接；断网恢复受平台、网络和当前消息处理状态影响。CI 测试不能替代真实消息往返。
- 凭证、会话数据库和日志应留在本地。具体依赖及兼容声明以 [package.json](package.json) 为准。

测试：`npm test`；宿主集成：`npm run test:host`。配置参考 [config.example.json](config.example.json)，变更历史见 [CHANGELOG.md](CHANGELOG.md)，许可见 [LICENSE](LICENSE)。
