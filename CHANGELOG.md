# Changelog · Channel Core

This file holds historical behavior notes formerly embedded in README. For current setup and behavior, start with [README.md](README.md) or [简体中文](README.zh-CN.md).

## Earlier updates

- **Single-package channels:** Discord and Feishu adapters moved into one Channel Core package with shared bridge and separate credentials, settings, and connection lifecycle.
- **Owner recognition:** Optional first-eligible-DM claim or manual owner selection, with per-channel identity verification for private memory.
- **Trusted session rotation:** Native-session handoff checks Dream evidence, identity, workspace, session cursor, and pending messages before changing channel bindings.
- **Discord message continuation:** Ask User continuation de-duplicates only verified previously delivered text and preserves same-line rewrites.
- **Discord interaction delivery:** Component actions parse the actual platform interaction ID and forward verified responses to the native handler.

See Git commit history for exact release-to-release changes. Live Feishu/Discord authentication is a separate integration test and is not guaranteed by CI.
