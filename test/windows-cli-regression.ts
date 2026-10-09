/**
 * Regression for #40: on Windows the resolver must never hand the Agent SDK a
 * `.cmd`/`.bat` shim (or a bare `claude` its spawn would resolve to one) —
 * Node/Bun refuse to spawn a batch file with the SDK's `--settings` JSON.
 * npm's shim is unwrapped to the native `claude.exe` / `cli.js` beside it.
 *
 * Runs on any OS: `process.platform` is pinned to win32 for this process.
 *
 * Run: bun test/windows-cli-regression.ts
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { assert } from "./helpers.ts";

function touch(path: string, body = "") {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

async function main() {
  Object.defineProperty(process, "platform", { value: "win32" });
  const { resetClaudeCliResolutionCache, resolveClaudeCli, resolveWindowsClaudePath } =
    await import("../src/executable-path.ts");

  const root = mkdtempSync(join(tmpdir(), "opencode-claude-win-"));
  try {
    const empty = join(root, "empty");
    mkdirSync(empty);
    const pkg = (dir: string) => join(dir, "node_modules", "@anthropic-ai", "claude-code");
    const resolve = (env: Record<string, string>) => {
      resetClaudeCliResolutionCache();
      return resolveClaudeCli({ HOME: empty, APPDATA: empty, ...env });
    };

    // npm global bin on PATH: the shim resolves to the native exe beside it.
    const npm = join(root, "npm");
    touch(join(npm, "claude.cmd"), "@echo off\r\n");
    touch(join(pkg(npm), "bin", "claude.exe"));
    touch(join(pkg(npm), "cli.js"));
    assert.equal(await resolve({ PATH: npm }), join(pkg(npm), "bin", "claude.exe"));

    // Older installs without the native binary fall back to cli.js.
    const legacy = join(root, "legacy");
    touch(join(legacy, "claude.cmd"), "@echo off\r\n");
    touch(join(pkg(legacy), "cli.js"));
    assert.equal(await resolve({ PATH: legacy }), join(pkg(legacy), "cli.js"));

    // A native exe on PATH wins over a shim in the same directory.
    const native = join(root, "native");
    touch(join(native, "claude.exe"));
    touch(join(native, "claude.cmd"), "@echo off\r\n");
    assert.equal(await resolve({ PATH: native }), `${native}/claude.exe`);

    // A shim with no target, npm's sh shim and the bare name are all unusable:
    // no path at all lets the SDK use its bundled executable instead.
    const orphan = join(root, "orphan");
    touch(join(orphan, "claude.cmd"), "@echo off\r\n");
    touch(join(orphan, "claude"), '#!/bin/sh\necho "2.1.300 (Claude Code)"\n');
    assert.equal(await resolve({ PATH: orphan }), null);
    assert.equal(await resolveWindowsClaudePath(join(orphan, "claude")), null);

    // Off PATH: found in npm's Windows global bin under %APPDATA%.
    const appData = join(root, "AppData", "Roaming");
    touch(join(appData, "npm", "claude.cmd"), "@echo off\r\n");
    touch(join(pkg(join(appData, "npm")), "bin", "claude.exe"));
    assert.equal(
      await resolve({ PATH: empty, APPDATA: appData }),
      join(pkg(join(appData, "npm")), "bin", "claude.exe"),
    );

    // …and in the official installer's ~/.local/bin.
    const home = join(root, "home");
    touch(join(home, ".local", "bin", "claude.exe"));
    assert.equal(
      await resolve({ PATH: empty, HOME: home }),
      join(home, ".local", "bin", "claude.exe"),
    );
    resetClaudeCliResolutionCache();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  console.log("ok — windows cli regression passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});