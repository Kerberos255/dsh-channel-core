# Channel Core for DeepSeek Harness

[简体中文](README.zh-CN.md) · [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) · [Security](SECURITY.md)

**One plugin for Discord and Feishu/Lark channels**, with shared session routing, verified owner identity, reliable message delivery, and progress/status integration.

## Features

- Discord and Feishu adapters live in the same package with independent credentials and connection lifecycles.
- Map verified direct messages from the same owner to a shared **native DSH session** when explicitly configured.
- Durable inbound receipts, serialized session admission, and native steer/queue/interrupt handling avoid replaying messages.
- Native Ask User interactions and progress/status integration preserve conversational continuity.
- Owner verification guards personal-memory access and cross-channel session transitions.

## Proactive outbound messaging

Channel Core supports **agent-initiated outbound messages** without a preceding inbound message. The `channel_send` tool can send a text message from the current native DSH session to its **already bound and currently authorized** Feishu or Discord conversation. The host/plugin API `ctx.channelCore.sendToBoundSession({ sessionId, text, idempotencyKey, bindingId?, source? })` allows trusted schedulers and other integrations to send the same way; `outboundTargets(sessionId)` lists eligible binding IDs without exposing destination identifiers.

- **Scope:** A session can send only to its own eligible bindings. Multiple bindings require an explicit `bindingId`; arbitrary recipient IDs and cross-session delivery are not accepted. Group allowlists and current DM/owner permission are checked again on send.
- **Delivery:** Uses the existing durable outbox and platform send adapters, with state `pending`, `sent`, `failed`, or `uncertain`. Reusing a stable idempotency key does not send the same message twice. A potentially delivered but unacknowledged message is **not** blindly retried.
- **Automation:** Jobs can call `channel_send` after creating a report (e.g. a scheduled financial report), or trusted plugins can call `sendToBoundSession` directly. This does **not** automatically broadcast every scheduled result, and it does not grant an agent permission to send to arbitrary accounts.
- **Testing:** `npm test` runs dependency-free public regressions. `npm run test:host` runs the broader integration suite inside a configured DSH developer environment with host peer dependencies. Live Feishu/Discord delivery has been separately exercised locally; CI cannot verify third-party credentials.

## Install

Requires a compatible DSH host with the peer services in [package.json](package.json), and credentials for each channel you choose to enable.

```sh
dsh plugin --profile desktop add github:Kerberos255/dsh-channel-core
```

Use your DSH profile name. Pin an installation to a Git commit if reproducibility is required. Restart DSH after installing or updating code.

## Quick start

1. Open **Settings → Plugins → Channels & Sessions**.
2. Configure the **Discord** and/or **Feishu** tab, platform credentials, and allowed users/channels. A valid connection alone does not authorize message delivery.
3. Review the owner-identification mode in each channel. Automatic first-DM owner claim occurs only after the incoming message passes channel allow rules; manual owner selection is available.
4. Optional: link owner accounts when you want **the same live DSH session** across channels. Sharing verified long-term memory does not require sharing a session.
5. Send a test DM and check the bound workspace, session, and progress output.

## Security and operational boundaries

A channel owner is verified per bot account; group conversations and unverified users must not inherit personal-memory authority. Session mapping decisions are audited and cannot silently reuse sessions from another workspace. The native Host manages agent execution, cancellations, jobs, and saved histories. The plugin keeps independent delivery and receipt state, not a second model engine.

Settings and channel files are local to DSH; do not upload credentials, binding databases, or historical messages. Source template: [config.example.json](config.example.json).

## Testing and related projects

Run `npm test` for portable regressions. **A green CI run does not prove live Discord, Feishu, or network authentication.** Verify actual bot delivery and UI interactions in your own host.

Related: [Status Cards](https://github.com/Kerberos255/dsh-status-cards) · [Dream & Memory](https://github.com/Kerberos255/dsh-memory-dreaming) · [Lossless Context](https://github.com/Kerberos255/dsh-lossless-context).

MIT licensed. See [LICENSE](LICENSE). Historical release notes: [CHANGELOG.md](CHANGELOG.md).

## Streaming and progress

Discord shows thought, draft and tool activity in a single rolling progress message. When native assistant messages include separate committed interim text and a final reply, the completed message presents the interim text as a native Markdown blockquote and keeps the formal answer outside it. The runtime footer remains optional; long replies are split to fit Discord message limits. Ask User preserves committed pre-question text as an independent quoted draft card before the interactive prompt, so later replies do not re-send the same text. Live draft previews use only the 📝 icon without synthetic section names.

Feishu supports CardKit component-level streaming with an IM-card compatibility fallback, agent role labels, and independently configurable runtime footer fields. Draft and thinking are separate switches: turning off thinking keeps public draft text visible. Completed turns may retain a collapsed **📝 过程记录** card containing enabled non-duplicate draft/thinking entries. Ask User freezes the preceding progress/context card and sends a separate interactive question card, without erasing the visible lead-in. The per-channel refresh intervals and progress budgets are configurable; real platform permissions and latency still need validation in your own environment.

## Ask User completion and optional diagnostics

Discord and Feishu now update the original Ask User message to a read-only completion receipt containing the submitted question and selected/custom answer, with controls removed. Historical pre-question text is non-interactive; Feishu stage records use a collapsed panel. The channels optionally emit privacy-restricted event and failure metadata through the dsh-plugin-diagnostics service when installed. The diagnostics plugin is not required for normal channel operation.
