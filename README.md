# Channel Core for DeepSeek Harness

[简体中文](README.zh-CN.md) · [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) · [Security](SECURITY.md)

Connect **Discord and Feishu/Lark** to native DSH sessions with shared message routing, verified identity, progress updates and reliable outbound delivery.

## Features

- **Connection recovery:** Each channel has independent settings and connectivity. Native SDK reconnects are preferred; persistent failures trigger bounded recovery and can refresh network proxy settings without restarting DSH.
- **Sessions and permissions:** Verified owner DMs can share one native session across channels when configured. Groups and threads use durable bindings and separate admission checks.
- **Reliable delivery:** Deduplicated inbound receipts, serialized session admission, durable outbound records and no blind resend of uncertain deliveries.
- **Interaction:** Streaming progress, Ask User, model selection and channel commands including `/new`, `/status` and `/session`; Feishu supports CardKit updates.
- **Outbound messaging:** `channel_send` sends text to authorized bindings of the current session, and Feishu images/files from its workspace. Trusted jobs may use the host API.
- **Schedules and memory:** `/new` safely migrates active scheduled tasks; eligible sessions support log rotation. Durably bound groups/threads can share workspace memory through compatible memory plugins.

## Install and configure

```sh
dsh plugin --profile desktop add github:Kerberos255/dsh-channel-core
```

Replace `desktop` with the target profile and restart DSH after installation or code changes. Open **Settings → Plugins → Channels & Sessions**:

1. Configure Discord and/or Feishu credentials and allowed users/channels.
2. Review owner verification; a first-DM claim is permitted only after channel admission.
3. Optionally link verified owner DMs across channels, and configure progress, drafts and notifications.
4. Test an actual message round trip on each enabled platform.

## Commands and outbound delivery

- Both channels support `/new`, `/stop`, `/status`, `/session`, `/answer`, `/model`, `/think` and `/reason`. Feishu also accepts `/models`.
- `/new` migrates **active** scheduled tasks before archiving the old session when safety checks pass. Completed one-shot jobs are not recreated. `/session` switches sessions without migrating tasks.
- Use native DSH Schedule to retain scheduled results in conversation history. `channel_send` can send only to currently authorized session bindings, never arbitrary recipients.
- Feishu images: PNG/JPEG/GIF/WebP up to 10 MiB. Ordinary files: up to 30 MB, within the session workspace. Printing a local path does not upload a file.

## Safety and limits

- **Shared group memory can reveal private facts in bot replies.** Admit only trusted groups; unverified private DMs remain isolated.
- Groups can display **public text drafts** when enabled. Private model reasoning remains limited to verified owner DMs.
- Disabled channels stay disabled. Recovery depends on platform connectivity and in-flight work; CI does not establish live delivery.
- Keep credentials, session databases and logs local. See [package.json](package.json) for runtime compatibility.

Tests: `npm test`; host integration: `npm run test:host`. See [config.example.json](config.example.json), [CHANGELOG.md](CHANGELOG.md) and [LICENSE](LICENSE).
