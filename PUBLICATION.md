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
