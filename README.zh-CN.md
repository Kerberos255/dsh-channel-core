# DSH 渠道与会话（Channel Core）

[English](README.md) · [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) · [安全说明](SECURITY.md)

**一个插件同时接入 Discord 与飞书（Lark）**，并统一管理身份核验、私聊 Session 绑定、消息投递和流式进度；Agent、历史、任务执行仍交给 DSH 原生服务。

## 主要功能

- Discord、飞书共用渠道桥接层，但各自保留独立凭证、收发设置和连接生命周期。
- 可让已确认是同一人的两个平台账号**共用同一个原生私聊 Session**；仅共享已核验长期记忆不要求共用 Session。
- 持久输入账本、重复投递去重、同 Session 顺序接纳及原生 steering / queue / interrupt。
- Discord Ask User 交互、飞书/Discord 进度显示；配合 Status Cards 查询当前会话的只读状态。
- 主人身份与工作区范围核验，防止未授权私聊读取私人记忆或继承其他人的历史。

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
