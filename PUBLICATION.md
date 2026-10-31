# Public source release

This is the standalone source distribution for dsh-channel-core.
Only plugin source and example configuration belong here. Do not commit user
sessions, credentials, databases, or a full DSH installation.

Requires a compatible DeepSeek Harness host providing the peer services from package.json.
The CI runs host-free tests; a passing result does not imply real Discord, Feishu, or browser integration.
The included client code is already generated, so standard installation needs no generator.
Replace <DSH_ROOT> in legacy documentation examples with your DSH install path.
Upstream third-party dependencies retain their own licenses.

`npm test` runs the portable suite without installing DSH peers or contacting bot services. `npm run test:host` runs all suites in an environment that supplies the compatible DSH SDK and declared development dependencies. The network suite uses the project's `ws` dependency, OS temporary directories, and the included public test-only TLS fixtures; it never loads a personal DSH profile.

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

## 0.4.13 · Discord Ask User 交互按钮修复

修复公开源码中 Discord 按钮交互回调错误保留的占位表达式，改为从 `interaction.customId` 的 `dsh:` 前缀之后提取真实动作标识。新增模拟按钮测试，验证按钮动作实际抵达原生处理器，而不仅仅是发送提问消息；原有重复正文与连续 Ask User 测试保持通过。

## 2026-10-11 public synchronization

Production source is synchronized to the local Channel Core plugin. The public
settings bundle contains only the Discord and Feishu page definitions, extracted
from shared local settings; no user configuration, secrets, sessions, logs, or
runtime databases are included. Existing public documentation, license and
workflow are retained. Live CardKit authorization and Discord proxy behavior
must still be validated in a real bot deployment.


## 0.6.4 · Model-command compatibility

The production change matches the locally verified Channel Core 0.6.4: pass the native projection cancellation signal and accept the Feishu `/models` alias. Public documentation and example configuration are retained. Added portable regressions cover the required signal and cancelled lookups; SDK-backed tests also cover authorization, command lifetime propagation, and Discord reasoning autocomplete. Automated tests use fixtures; real bot permissions and message delivery require deployment verification.
