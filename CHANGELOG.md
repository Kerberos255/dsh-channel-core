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
