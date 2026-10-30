/**
 * Regression: chat turns with OpenCode tools ran Claude Code with
 * bypassPermissions, which the CLI refuses to start with as root, so the
 * plugin did not work on a root-only VPS. The turn now uses dontAsk with
 * the bridged OpenCode tools allowed; anything else is refused.
 *
 * On the simulators (test/simulators/): a turn in OpenCode with its bash
 * tool; what the plugin passed Claude Code is in the query's parameters.
 *
 * Run: bun test/root-permissions-regression.ts
 */
import assert from "node:assert/strict";

import { createWorld } from "./simulators/world.ts";

async function main() {
  const world = await createWorld("root-permissions");
  const { opencode, claude } = world;
  try {
    await opencode.startPlugin();
    const chat = opencode.newChat();
    await opencode.say(chat, "hi");
    const turn = await opencode.turn(chat);
    assert.ok(turn.ok, `the turn answered: ${turn.requests.at(-1)?.status}`);
    const params = claude.queries.at(-1)!.params as Record<string, any>;
    assert.equal(params.permissionMode, "dontAsk");
    assert.notEqual(params.allowDangerouslySkipPermissions, true);
    assert.ok((params.allowedTools as string[] | undefined)?.some((name) => name.endsWith("bash")), "the bridged tools are allowed");
    assert.deepEqual(params.tools, [], "no built-in tools");
    assert.deepEqual(world.journal().filter((line) => /level=error/.test(line)), [], "no error in the plugin's journal");
    console.log("root-permissions regression ok");
  } finally {
    await world.dispose();
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
