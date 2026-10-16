# Changelog · Channel Core

This file holds historical behavior notes formerly embedded in README. For current setup and behavior, start with [README.md](README.md) or [简体中文](README.zh-CN.md).

## Earlier updates

- **Single-package channels:** Discord and Feishu adapters moved into one Channel Core package with shared bridge and separate credentials, settings, and connection lifecycle.
- **Owner recognition:** Optional first-eligible-DM claim or manual owner selection, with per-channel identity verification for private memory.
- **Trusted session rotation:** Native-session handoff checks Dream evidence, identity, workspace, session cursor, and pending messages before changing channel bindings.
- **Discord message continuation:** Ask User continuation de-duplicates only verified previously delivered text and preserves same-line rewrites.
- **Discord interaction delivery:** Component actions parse the actual platform interaction ID and forward verified responses to the native handler.

See Git commit history for exact release-to-release changes. Live Feishu/Discord authentication is a separate integration test and is not guaranteed by CI.

## 公开源代码同步 · 2026-10-11

- 将公开源代码与已验证的本地 Channel Core 当前实现同步，包含 Discord 进度排版、消息积压合并、角色标题、Ask User 衔接、网络代理与正文脚注。
- Discord 最终答复使用原生消息边界区分已提交的阶段性公开文字，将其放入引用块；真正的回复保持正常 Markdown。不会把未提交的文字或私有思考当作过程草稿。
- 飞书增加 CardKit 文本组件更新与兼容回退，优化思考去重、折叠卡标题、段落布局和可选运行脚注。
- 公共 CI 仍以不依赖用户 DSH 宿主的单元测试为准；卡片权限、真实消息投递和用户账号认证需在运行环境验收。

## 2026-10-13 · 主动渠道投递

- 新增 `channel_send` Agent 工具及可信插件调用入口 `sendToBoundSession()`，复用已有 Feishu/Discord 适配器和 SQLite 持久队列。
- 仅允许向当前 DSH Session 已绑定且当前授权有效的目标发送消息；多个渠道绑定需显式选择。私聊授权撤销后不能凭旧绑定继续推送。
- 使用稳定幂等键避免重复发送，发送状态未知时禁止盲目重试，避免向群聊重复推送。
- 新增主动消息回归测试与工具输出格式测试，并区分公共 CI 的纯本地测试、需要宿主依赖的集成测试。飞书 Test 群已由本地 DSH 实机验证；公开 CI 不保证真实平台权限。

## 0.4.57 (2026-10-13)

- Discord now registers independent slash commands; Feishu adds safe `/model`, provider-only shorthand, and `/think`.
- Channel authorization and shared-session ownership are preserved.

## 0.4.62 (2026-10-16)

- Add optional task notifications, verified-owner DM routing, and stable-current-binding resolution; preserve Dream as a standalone plugin.
- Sync verified native owner `/status` dashboard integrations for Discord and Feishu, including their authorization and transport tests.
- Keep notifications disabled by default; live platform acceptance still requires an opt-in end-to-end test.
