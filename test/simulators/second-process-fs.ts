/**
 * `node:fs` as the plugin's modules see it in a second process
 * (second-process.ts): the real module, except that the process can be killed
 * while it rewrites one file (`killAtWrite`), or paused there (`holdAtWrite`,
 * below). What such a kill leaves is
 * what a server killed then leaves (measured on
 * Windows, bun 1.3.13: a process rewriting a
 * file of 20 KB to 3 MB with `writeFileSync`, killed at random 300 times -
 * the file whole, or empty (6-9 %): truncated, nothing written; never a part
 * of it): `writeFileSync` truncates the file and the process dies; a rename
 * onto it does not happen (the file before and the temporary one stay).
 */
import * as fs from "node:fs";
import fsDefault from "node:fs";
import { basename } from "node:path";

export * from "node:fs";

const armed = (path: unknown): boolean => {
  const name = (globalThis as { __worldKillAtWrite?: string }).__worldKillAtWrite;
  return !!name && typeof path === "string" && basename(path) === name;
};

const die = (): never => {
  process.kill(process.pid, "SIGKILL");
  // TerminateProcess returns before the process is gone: nothing more of it runs.
  for (;;) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
};

/**
 * The process paused in its next rewrite of one file (`armHoldAtWrite`), as a server the system stops running right
 * after `writeFileSync` truncated the file: the file stays empty until the process runs again. The pause is the whole
 * process (the plugin's write is synchronous); the test's process sees it start by `<flag>.held` and ends it by
 * `<flag>.go` - files, as nothing else of this process runs meanwhile. A rename onto the file waits before it happens.
 */
const pauseAt = (path: unknown, flagOf: (path: string) => void): boolean => {
  const hold = (globalThis as { __worldHoldAtWrite?: { file: string; flag: string } }).__worldHoldAtWrite;
  if (!hold || typeof path !== "string" || basename(path) !== hold.file) return false;
  (globalThis as { __worldHoldAtWrite?: unknown }).__worldHoldAtWrite = undefined;
  flagOf(path);
  fs.writeFileSync(`${hold.flag}.held`, "");
  // Given up after a minute, so a test that broke before it let go does not keep the process forever.
  const until = performance.now() + 60_000;
  while (!fs.existsSync(`${hold.flag}.go`) && performance.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  return true;
};

export function writeFileSync(...args: Parameters<typeof fs.writeFileSync>): void {
  if (armed(args[0])) {
    fs.writeFileSync(args[0], "");
    die();
  }
  pauseAt(args[0], (path) => fs.writeFileSync(path, ""));
  return fs.writeFileSync(...args);
}

export function renameSync(...args: Parameters<typeof fs.renameSync>): void {
  if (armed(args[1])) die();
  pauseAt(args[1], () => {});
  return fs.renameSync(...args);
}

export default { ...fsDefault, writeFileSync, renameSync };
