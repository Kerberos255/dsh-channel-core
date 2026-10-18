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

Channel Core supports agent-initiated outbound messages without a preceding inbound message. The only model-facing channel tool, `channel_send({ text?, imagePath?, filePath?, bindingId?, idempotencyKey? })`, sends to the current native Session's existing and currently authorized Feishu or Discord destination. It has no archive search/read actions or news-specific tools. The trusted host API `ctx.channelCore.sendToBoundSession({ sessionId, text, idempotencyKey, bindingId?, source? })` remains available to schedulers and other plugins; `outboundTargets(sessionId)` returns eligible binding IDs without exposing recipient IDs.

- **Tool scope:** One call sends text, one Feishu image or one Feishu file. File paths must be within the current workspace and are uploaded as media, not sent as a Markdown path. To persist scheduled output to conversation history, use native DSH Schedule bound to the relevant Session.
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

## Sending ordinary files to Feishu

The existing Session-scoped `channel_send` tool also supports `{action:"send",filePath:"_scratch/report.pdf"}` to send an **actual downloadable Feishu file attachment**. Supported formats include PDF, Word, Excel, PowerPoint, ZIP, 7z, RAR, TXT, CSV, Markdown, JSON and related document formats (max 30 MB per file). Images continue to use `imagePath`.

Files are restricted to the current authorized Session workspace, validated by canonical path and content signature, and fingerprinted with SHA-256 both before queuing and delivery. Existing binding authorization, outbound idempotency, and uncertain-delivery safeguards apply. One call sends one attachment. Native file messages do not carry captions: send any explanatory text separately.

## Sending images to Feishu

The Session-scoped `channel_send` model tool supports `{action:"send",imagePath:"..."}` for a **real outbound Feishu image**. The image must be a PNG/JPEG/GIF/WebP inside the current DSH workspace, at most 10 MiB. The adapter validates canonical paths, file magic and SHA-256, then lets the Feishu SDK upload the media and send a native image message; a Markdown `![image](local-path)` reference alone does **not** send a picture. Existing Session binding authorization and durable idempotency continue to apply.

Feishu CardKit final replies retry closing/updating **the same existing card** once when the initial terminal edit fails. The delivery ledger keeps ambiguous failures as `uncertain` rather than blindly sending a duplicate, and `channel.final-delivered` / `channel.final-delivery-failed` diagnostics make stuck progress easier to investigate.

## Native Session scheduling and outbound records

The global `channel_send` tool only delivers messages; it does not offer news history tools, outbound archive queries, or news system prompt injection. A private transport ledger retains delivery state, remote IDs and idempotency keys to avoid duplicates.

To retain recurring results in a native Session, use the Host's built-in DSH Schedule bound to that Session. Each run creates a normal model turn and its reply becomes part of the ordinary Session history. This incurs a model call, unlike zero-LLM direct pushes; historical search uses standard Session / LCM abilities rather than a bespoke news tool.
