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
