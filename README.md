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

Channel Core supports **agent-initiated outbound messages** without a preceding inbound message. The **single** model tool `channel_send` sends from the current native DSH Session to its **already bound and currently authorized** Feishu or Discord conversation, and also provides read-only access to that Session's proactive outbound history. The host/plugin API `ctx.channelCore.sendToBoundSession({ sessionId, text, idempotencyKey, bindingId?, source? })` allows trusted schedulers and other integrations to send the same way; `outboundTargets(sessionId)` lists eligible binding IDs without exposing destination identifiers.

- **Tool actions:** `channel_send({ text, bindingId?, idempotencyKey? })` remains the default **send** operation (compatible with existing calls). `channel_send({ action: 'list', query?, source?, limit?, before?, cursorId? })` lists archived outbound messages, and `channel_send({ action: 'read', id, offset? })` reads original text. `list`/`read` never send anything; mixing send and read arguments is rejected. No separate outbound-records model tool is registered.
- **Scope:** A session can send only to its own eligible bindings. Multiple bindings require an explicit `bindingId`; arbitrary recipient IDs and cross-session delivery are not accepted. Group allowlists and current DM/owner permission are checked again on send.
- **Delivery:** Uses the existing durable outbox and platform send adapters, with state `pending`, `sent`, `failed`, or `uncertain`. Reusing a stable idempotency key does not send the same message twice. A potentially delivered but unacknowledged message is **not** blindly retried.
- **Automation:** Jobs can call `channel_send` after creating a report (e.g. a scheduled financial report), or trusted plugins can call `sendToBoundSession` directly. This does **not** automatically broadcast every scheduled result, and it does not grant an agent permission to send to arbitrary accounts.
- **Testing:** `npm test` runs dependency-free public regressions. `npm run test:host` runs the broader integration suite inside a configured DSH developer environment with host peer dependencies. Live Feishu/Discord delivery has been separately exercised locally; CI cannot verify third-party credentials.

## Streaming, Ask User and commands

Discord streams thinking, draft and tool activity in a rolling progress message. Committed interim text can appear as a native blockquote in the completed message, separate from the final answer; unpublished/private reasoning is not promoted to public draft text. Live previews show 📝 without artificial section names.

Feishu supports CardKit component streaming with an IM-card fallback. Draft and thinking have independent visibility switches; disabling thinking does not hide public draft text. Completed turns may retain a collapsed 📝 过程记录 panel when enabled. Refresh limits and optional runtime footers are channel-specific.

On both channels, a submitted Ask User question becomes a read-only receipt of the question and selected or custom answer, with interactive controls removed. Previously committed context remains visible and is not re-sent as a duplicate answer.

Discord uses flat `/new`, `/stop`, `/status`, `/session`, `/answer`, `/prompt`, `/model`, `/think` commands. Feishu supports text `/new`, `/stop`, `/status`, `/session`, `/answer`, `/model`, `/think`. Model selection is constrained to available models and takes effect from the next turn; ambiguous provider selections present candidates.

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

## Optional task notifications

Channel Core's **General & Sessions → Task notifications** option is off by default. Enabling it reveals a notification-channel selector (None, Feishu, or Discord), limited to channels enabled and configured in the current host. A failed scheduled task may send a brief alert to the verified owner's DM, never to an arbitrary chat. Recipient resolution follows the current authorized channel binding, rather than storing a Session ID, so normal `/new` and archived-session handoffs do not require reconfiguration. If there is no uniquely authorized owner destination, nothing is sent. Alert delivery uses the existing durable channel queue and stable idempotency keys; an unavailable host cannot guarantee alerts during downtime.

Other plugins remain independent: they can optionally emit `dsh/task-alert` with a trusted task identifier, task kind, source and terminal state after persisting the failure. Channel Core handles selection, authorization, and delivery. Dream emits this event only on a scheduled workflow's first transition to `failed`; manual runs and successful/empty runs remain silent. Payloads exclude private conversation text, model errors and memory artifacts. No channel plugin is required to run Dream.

## Session-scoped outbound archive

**UI simplification:** The unused additional “Outbound records” conversation view has been removed. It no longer registers a separate Session renderer or needs Workspace / Conversation / Chat client providers. The existing `channel_send` model tool retains read-only `list` and `read` actions for archived outbound messages.

The optional private news relay can mirror a confirmed Feishu newsletter into the owning DSH Session as a model-invisible, ignorable plugin record, using DSH's experimental `appendPluginRecord` API. Its Chat Node contribution presents the record in the normal conversation timeline without creating a user/assistant turn, starting another LLM request or directly editing the compressed Session log. No such mirroring occurs for other proactive sources by default.

Every proactive message sent through Channel Core's `channel_send` or `sendToBoundSession` (including scheduled reports, task alerts and news integrations) is persistently archived **before** transport with original text, platform, source, status, delivery time and remote message ID. The owning native DSH Session's agent reads only its own records using `channel_send` with `action: 'list'` (optional search/paging) or `action: 'read'` (record ID and offset). Other Sessions cannot inspect the content through this model tool. The model normally sees only a small recent metadata hint. In the designated Feishu-news Session only, the next normal model request receives up to 3 latest confirmed news bodies, bounded to 12,000 characters total; older or longer news remains available via `channel_send(action='list'/'read')`. The news is labeled as untrusted reference material, not a user instruction. This does not create a model call at delivery time. Archive reads neither resend messages nor add native user turns or Dream input. It covers Feishu and Discord proactive sends, not ordinary interactive replies or external systems bypassing Channel Core. Historical messages from before installation are not backfilled.
