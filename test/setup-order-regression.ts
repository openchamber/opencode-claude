/**
 * Regression: OpenCode v2 sets the plugin up again on a reload, and until
 * setup registers the provider its models are missing from the catalog; a
 * session stepping meanwhile failed with "Model unavailable". Setup waited
 * on the CLI probe (`claude --version`, `claude auth status`) first, and
 * every location ran its own.
 * - The provider and the model.request hook are registered while the CLI
 *   probe is still running.
 * - Setups running together share one probe.
 *
 * Run: bun test/setup-order-regression.ts
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert } from "./helpers.ts";

async function main() {
  const tmp = mkdtempSync(join(tmpdir(), "opencode-claude-setup-order-"));
  const bin = join(tmp, "bin");
  mkdirSync(bin);
  const calls = join(tmp, "calls.log");
  writeFileSync(
    join(bin, "claude"),
    `#!/bin/sh
echo "$*" >> "${calls}"
case "$1" in
  --version) echo "2.1.296 (Claude Code)" ;;
  auth) sleep 1; echo '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max"}' ;;
esac
`,
  );
  chmodSync(join(bin, "claude"), 0o755);
  process.env.PATH = `${bin}:/usr/bin:/bin`;
  process.env.HOME = tmp;
  process.env.XDG_DATA_HOME = tmp;

  const { ClaudeCodePlugin } = await import("../src/index.ts");
  const started = Date.now();
  const registered: number[] = [];
  const hooked: number[] = [];
  const fakeContext = () => {
    const stop = new AbortController();
    return {
      stop,
      ctx: {
        // The background CLI update is not what this checks, and on Windows
        // the PATH above does not apply: it could update the real CLI.
        options: { cliAutoUpdate: false },
        location: { directory: tmp },
        provider: {
          transform: async (fn: (p: { add: (x: unknown) => void }) => void) => {
            fn({ add: () => registered.push(Date.now() - started) });
          },
          reload: async () => {},
        },
        session: {
          hook: async (name: string) => {
            if (name === "model.request") hooked.push(Date.now() - started);
          },
          switchModel: async () => {},
        },
        integration: {
          transform: async (fn: (i: unknown) => void) =>
            fn({ method: { update: () => {} }, update: () => {} }),
        },
        event: {
          subscribe: ({ signal }: { signal: AbortSignal }) =>
            (async function* () {
              await new Promise((r) => signal.addEventListener("abort", r));
            })(),
        },
      } as any,
    };
  };

  const a = fakeContext();
  const b = fakeContext();
  const setups = Promise.all([ClaudeCodePlugin.setup(a.ctx), ClaudeCodePlugin.setup(b.ctx)]);
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(registered.length, 2, "both providers registered while the probe runs");
  assert.equal(hooked.length, 2, "both request hooks registered while the probe runs");
  const disposers = await setups;
  const authCalls = readFileSync(calls, "utf8").split("\n").filter((l) => l.startsWith("auth"));
  assert.equal(authCalls.length, 1, "one shared probe");
  for (const dispose of disposers) await (dispose as () => Promise<void>)();
  console.log("setup-order regression ok");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
