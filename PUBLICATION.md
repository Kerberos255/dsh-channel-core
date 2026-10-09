# Public source release

This is the standalone source distribution for dsh-channel-core.
Only plugin source and example configuration belong here. Do not commit user
sessions, credentials, databases, or a full DSH installation.

Requires a compatible DeepSeek Harness host providing the peer services from package.json.
The CI runs host-free tests; a passing result does not imply real Discord, Feishu, or browser integration.
The included client code is already generated, so standard installation needs no generator.
Replace <DSH_ROOT> in legacy documentation examples with your DSH install path.
Upstream third-party dependencies retain their own licenses.

The legacy `runtime-network.test.mjs` depended on a personal DSH profile, the `ws` module from that profile, and temporary TLS fixture files; it is intentionally excluded from the public source snapshot. Recreate a self-contained network test with generated test-only TLS credentials before advertising that integration coverage.

Merged channel settings can be rebuilt with node tools/build-client.mjs.

Local-first performance optimization synchronized on 2026-10-08 from DSH plugin source 0.4.4. Changes: fewer repeated SQLite prepares; fresh Channel Core identity bindings are still checked on every recall. Regression tests were run against the local DSH SDK before this public-source sync.

## 0.4.10 · 2026-10-09

- 与本地 Core 对齐 Discord steering / 进度消息的事件交付、桥接与工具状态格式；保持同一轮 steer 与现有渠道身份核验。
- 公开仓库仅同步 `channels/discord/transport.js` 与 `lib/` 的经过差异核对的生产源码；未复制本地运行配置、凭据、Session 或工作区。
- CI 的宿主无关测试可验证公开进度格式和身份规则；真实 Discord/Feishu 连接及 DSH Desktop 的端到端认证仍需宿主验收。

## 0.4.11 · Discord Ask User 续写去重

Discord Ask User 提问前，会把本轮已经提交的公开文本展示成独立历史消息。回答后原生 Turn 的最终提交仍包含这段前缀。新版本仅在与已展示前缀完整匹配时过滤这段重复正文；连续提问、多次选项更新和随后 Steer 时继续保留原历史与来源核验。正文不匹配时不删减，以避免丢失内容。公开版新增使用模拟 Discord SDK 的独立回归，真实 Discord 连接须由 Host 实机验证。

## 0.4.12 · Discord Ask User 文本边界安全性

Ask User 已发送的前文仅在原生 assistant/message 的明确换行边界后扣除；同一行继续生成或改写时不进行猜测性裁剪，以免丢失正文。新增回归断言覆盖这一差异。
