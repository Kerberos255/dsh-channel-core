import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

// Keep npm test independent of DSH peers, bot credentials, and local profiles.
// The full SDK-backed suite remains available as npm run test:host.
const files=[
  "channels/discord/tests/final-format.test.mjs",
  "channels/discord/tests/model-commands.test.mjs",
  "channels/discord/tests/tables.test.mjs",
  "tests/answered-question.test.mjs",
  "tests/auto-rotation.test.mjs",
  "tests/channel-model-portable.test.mjs",
  "tests/client-outbound-view.test.mjs",
  "tests/config.test.mjs",
  "tests/core.test.mjs",
  "tests/feishu-steer-segmentation.test.mjs",
  "tests/memory-access.test.mjs",
  "tests/new-session-migration.test.mjs",
  "tests/outbound-agent-tool.test.mjs",
  "tests/proactive-outbound.test.mjs",
  "tests/progress-lines.test.mjs",
  "tests/retired-route.test.mjs",
  "tests/rotation.test.mjs",
  "tests/task-notifications.test.mjs",
  "tests/tool-detail.test.mjs"
];
const root=fileURLToPath(new URL('../',import.meta.url));
const result=spawnSync(process.execPath,['--test','--test-reporter=tap',...files],{
 cwd:root,stdio:'inherit'
});
if(result.error)throw result.error;
process.exitCode=result.status??1;
