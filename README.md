# Channel Core for DeepSeek Harness

[简体中文](README.zh-CN.md) · [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) · [Security](SECURITY.md)

**One plugin for Discord and Feishu/Lark channels**, with shared session routing, verified owner identity, reliable message delivery, and progress/status integration.

## Features

- Discord and Feishu adapters live in the same package with independent credentials and connection lifecycles.
- Map verified direct messages from the same owner to a shared **native DSH session** when explicitly configured.
- Durable inbound receipts, serialized session admission, and native steer/queue/interrupt handling avoid replaying messages.
- Native Ask User interactions and progress/status integration preserve conversational continuity.
- Owner verification guards personal-memory access and cross-channel session transitions.

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
