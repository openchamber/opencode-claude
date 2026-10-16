/**
 * Live check of the CLI auto-update (src/cli-update.ts) against the real
 * Claude Code CLI on this machine, through the plugin's own code.
 *
 * It changes the installed CLI: installs an older version with
 * `claude install <from>`, takes the newest version out of
 * $XDG_DATA_HOME/claude/versions (~/.local/share/claude/versions by
 * default) so that every update downloads it again
 * (one copy is kept beside that folder), and walks through the situations
 * below. It ends on the newest version: by `claude update`, or, if the
 * network is gone by then, by installing the kept copy. Native installs only
 * (`claude install <version>` and the versions folder exist only there; the
 * test refuses to run when the plugin resolves another `claude`, or on macOS
 * and Linux when ~/.local/bin/claude is not the installer's symlink); needs the
 * network; a few minutes, each download is the
 * whole ~270 MB binary. Stop running OpenCode servers first, or their own
 * hourly update may join in. On Windows each update leaves the replaced
 * launcher as ~/.local/bin/claude.exe.old.*; Claude Code deletes those older
 * than an hour on its next successful update.
 *
 * 1. Update from <from>: "updated", and `claude --version` agrees.
 * 2. Again: "up to date".
 * 3. No network (proxy on a closed port): failed with the cause, not the
 *    "claude doctor" hint; the CLI stays on <from>.
 * 4. Connection cut mid-download (a local proxy that closes each tunnel after
 *    1 MB): the same; then an update without the proxy recovers.
 * 5. Two server processes start the auto-update a second apart over one
 *    record file: one runs `claude update`, the other sees the claim and
 *    skips.
 * 6. Windows: the launcher held open by another program while the update
 *    swaps it. `claude update` still prints "Successfully updated"; the
 *    plugin records a failure, because `claude --version` disagrees.
 *
 * Verified on Windows 11 with Claude Code 2.1.300 -> 2.1.301. macOS and Linux
 * use the same commands (the launcher there is a symlink into the versions
 * folder, replaced by an atomic rename, so situation 6 does not arise), but
 * have not been run.
 *
 * Run: bun test/cli-update-live.ts --from <older version>   (e.g. --from 2.1.300)
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync } from "node:fs";
import { createServer, connect, type Server, type Socket } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { sleep } from "./helpers.ts";

const { readCliUpdateRecord, startClaudeCliAutoUpdate, updateClaudeCli } = await import(
  "../src/cli-update.ts"
);
const { resolveClaudeCli } = await import("../src/executable-path.ts");

type Outcome = Awaited<ReturnType<typeof updateClaudeCli>>;

// Where the CLI keeps its versions: $XDG_DATA_HOME/claude, else ~/.local/share/claude.
const versionsDir = join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "claude", "versions");
const doctorHint = /claude doctor/;

/** Child mode for situation 5: one "server process" over the given data dir. */
if (process.argv[2] === "--child") {
  const cliEnv = { ...process.env };
  const recordEnv = { ...process.env, XDG_DATA_HOME: process.argv[3]! };
  // The plugin log goes to the temp dir as well; the CLI keeps the real env.
  process.env.XDG_DATA_HOME = process.argv[3]!;
  let ran = false;
  const stop = startClaudeCliAutoUpdate({
    env: recordEnv,
    update: () => {
      ran = true;
      return updateClaudeCli({ env: cliEnv });
    },
  });
  // Done once the record holds an outcome, whoever wrote it: no record yet
  // means the first check has not got there (the CLI probe can take seconds).
  const deadline = Date.now() + 12 * 60_000;
  let done = false;
  while (!done && Date.now() < deadline) {
    await sleep(250);
    const kind = readCliUpdateRecord(recordEnv)?.outcome.kind;
    done = kind !== undefined && kind !== "running";
  }
  stop();
  console.log(JSON.stringify({ ran, done }));
  process.exit(0);
}

const fromIndex = process.argv.indexOf("--from");
const from = fromIndex > 0 ? process.argv[fromIndex + 1] : undefined;
if (!from || !/^\d+\.\d+\.\d+$/.test(from)) {
  console.log(
    "Usage: bun test/cli-update-live.ts --from <older version>\n" +
      "Changes the installed Claude Code CLI (see the comment at the top of this file).",
  );
  process.exit(2);
}

// The CLI the plugin resolves must be the native launcher: with an npm or
// package-manager install earlier on PATH the updates below would go there,
// while the versions folder belongs to another install.
const nativeLauncher = join(homedir(), ".local", "bin", process.platform === "win32" ? "claude.exe" : "claude");
const launcher = await resolveClaudeCli(process.env);
const samePath = (a: string, b: string) =>
  process.platform === "win32" ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);
if (!launcher || !samePath(launcher, nativeLauncher) || !existsSync(versionsDir)) {
  console.log(`Native Claude Code install not found: the plugin resolves ${launcher}, expected ${nativeLauncher} and ${versionsDir}.`);
  process.exit(2);
}
// macOS and Linux: the installer's launcher is a symlink into the versions
// folder; it does not replace anything else (a copied binary, a wrapper).
if (process.platform !== "win32") {
  const isInstallerLink =
    lstatSync(nativeLauncher).isSymbolicLink() && samePath(dirname(realpathSync(nativeLauncher)), realpathSync(versionsDir));
  if (!isInstallerLink) {
    console.log(`${nativeLauncher} is not the installer's symlink into ${versionsDir}; claude update would not replace it.`);
    process.exit(2);
  }
}

/** Run the launcher directly, as a user would. */
function cli(args: string[]): { code: number | null; output: string } {
  const run = spawnSync(launcher!, args, { encoding: "utf8", timeout: 10 * 60_000, windowsHide: true });
  return { code: run.status, output: `${run.stdout ?? ""}${run.stderr ?? ""}${run.error?.message ?? ""}` };
}

function installedVersion(): string | null {
  return /(\d+\.\d+\.\d+)/.exec(cli(["--version"]).output)?.[1] ?? null;
}

let latest = "";
/**
 * The newest version is taken out of the versions folder so that updates
 * download it; the first copy is kept here, beside the folder, so the end
 * can put it back without the network.
 */
const backupDir = join(dirname(versionsDir), "opencode-claude-live-test-backup");

/** Back to <from>; with `download`, the newest version must be fetched again. */
function prepare(download: boolean): void {
  const install = cli(["install", from!]);
  if (installedVersion() !== from) {
    throw new Error(`could not install ${from}: ${install.output.trim()}`);
  }
  if (!download) return;
  const newest = join(versionsDir, latest);
  const backup = join(backupDir, latest);
  if (existsSync(backup)) {
    rmSync(newest, { recursive: true, force: true });
  } else {
    mkdirSync(backupDir, { recursive: true });
    renameSync(newest, backup);
  }
}

/** End on the newest version: update, or without the network the kept copy. */
function restore(): string | null {
  cli(["update"]);
  let version = installedVersion();
  const backup = join(backupDir, latest);
  if (latest && version !== latest && existsSync(backup)) {
    const newest = join(versionsDir, latest);
    if (!existsSync(newest)) renameSync(backup, newest);
    // An explicit install of a version already on disk works offline.
    cli(["install", latest]);
    version = installedVersion();
  }
  if (version === latest) rmSync(backupDir, { recursive: true, force: true });
  return version;
}

/** A port nothing listens on: listen, read the port, close. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as { port: number }).port;
  await new Promise((done) => server.close(done));
  return port;
}

/** HTTP CONNECT proxy that closes every tunnel after `limit` bytes back to the client. */
async function cuttingProxy(limit: number): Promise<{ port: number; server: Server }> {
  const server = createServer((client: Socket) => {
    let head = Buffer.alloc(0);
    const onHead = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) return;
      client.off("data", onHead);
      const target = /^CONNECT ([^:\s]+):(\d+)/.exec(head.toString("latin1"));
      if (!target) {
        client.destroy();
        return;
      }
      const upstream = connect(Number(target[2]), target[1]!, () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        const rest = head.subarray(end + 4);
        if (rest.length) upstream.write(rest);
        client.pipe(upstream);
      });
      let carried = 0;
      upstream.on("data", (data: Buffer) => {
        carried += data.length;
        if (carried > limit) {
          upstream.destroy();
          client.destroy();
          return;
        }
        client.write(data);
      });
      upstream.on("error", () => client.destroy());
      client.on("error", () => upstream.destroy());
    };
    client.on("data", onHead);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return { port: (server.address() as { port: number }).port, server };
}

function describe(outcome: Outcome): string {
  const installed = `(CLI ${outcome.installed ?? "?"})`;
  switch (outcome.kind) {
    case "updated":
      return `updated ${outcome.from} -> ${outcome.to} ${installed}`;
    case "up-to-date":
      return `up to date ${outcome.version} ${installed}`;
    case "failed":
      return `failed ${installed}: ${outcome.message}`;
    default:
      return `${outcome.kind} ${installed}`;
  }
}

let failures = 0;
function check(name: string, ok: boolean, detail: string): void {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${detail}`);
}

/**
 * A failure that names its cause, on the version we started from: the
 * "Error:" line, the cause the situation produces, and not the doctor hint.
 */
function isFailureWithCause(outcome: Outcome, cause: RegExp): boolean {
  return (
    outcome.kind === "failed" &&
    outcome.message.startsWith("Error:") &&
    cause.test(outcome.message) &&
    !doctorHint.test(outcome.message) &&
    outcome.installed === from
  );
}

try {
  // The newest version, whatever it is today.
  const start = await updateClaudeCli({});
  if ((start.kind !== "updated" && start.kind !== "up-to-date") || !start.installed) {
    throw new Error(`could not reach the newest version first: ${describe(start)}`);
  }
  latest = start.installed;
  if (latest === from) throw new Error(`--from ${from} is the newest version; pass an older one`);
  console.log(`newest ${latest}, testing from ${from}`);

  // 1, 2
  prepare(true);
  const plain = await updateClaudeCli({});
  check("1 update", plain.kind === "updated" && plain.from === from && plain.to === latest && plain.installed === latest, describe(plain));
  const again = await updateClaudeCli({});
  check("2 again", again.kind === "up-to-date" && again.installed === latest, describe(again));

  // 3
  prepare(false);
  const offline = `http://127.0.0.1:${await closedPort()}`;
  const noNetwork = await updateClaudeCli({ env: { ...process.env, HTTPS_PROXY: offline, HTTP_PROXY: offline } });
  check("3 no network", isFailureWithCause(noNetwork, /ECONNREFUSED/), describe(noNetwork));

  // 4
  prepare(true);
  const proxy = await cuttingProxy(1_000_000);
  const via = `http://127.0.0.1:${proxy.port}`;
  const cut = await updateClaudeCli({ env: { ...process.env, HTTPS_PROXY: via, HTTP_PROXY: via } });
  proxy.server.close();
  check("4 cut mid-download", isFailureWithCause(cut, /download|connection|aborted|ECONNRESET/i), describe(cut));
  const recovered = await updateClaudeCli({});
  check("4 recovers", recovered.kind === "updated" && recovered.installed === latest, describe(recovered));

  // 5
  prepare(true);
  const data = mkdtempSync(join(tmpdir(), "opencode-claude-update-live-"));
  try {
    const child = () =>
      new Promise<{ ran: boolean; done: boolean }>((done, fail) => {
        const proc = spawn(process.execPath, [import.meta.path, "--child", data], { stdio: ["ignore", "pipe", "inherit"] });
        let out = "";
        proc.stdout!.on("data", (chunk) => (out += chunk));
        proc.on("close", () => {
          try {
            done(JSON.parse(out.trim().split("\n").at(-1)!));
          } catch {
            fail(new Error(`child printed: ${out}`));
          }
        });
      });
    const first = child();
    await sleep(1000);
    const second = child();
    const results = await Promise.all([first, second]);
    const runs = results.filter((result) => result.ran).length;
    const record = readCliUpdateRecord({ XDG_DATA_HOME: data });
    const finished = results.filter((result) => result.done).length;
    check("5 two servers", runs === 1 && finished === 2, `${runs} of 2 ran claude update, ${finished} of 2 saw the outcome`);
    check(
      "5 record",
      record?.outcome.kind === "updated" && record.outcome.installed === latest,
      JSON.stringify(record?.outcome),
    );
  } finally {
    rmSync(data, { recursive: true, force: true });
  }

  // 6
  if (process.platform === "win32") {
    prepare(true);
    // Open the launcher with no sharing, as an antivirus scan may.
    const holder: ChildProcess = spawn(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `$s=[IO.File]::Open('${launcher}','Open','Read','None'); Write-Output held; Start-Sleep 600`,
      ],
      { stdio: ["ignore", "pipe", "inherit"], windowsHide: true },
    );
    // Listened for from the start: the holder may end on its own (its sleep
    // runs out during a slow update) before the check below waits for it.
    const holderGone = new Promise<void>((done) => holder.once("close", () => done()));
    const ready = await Promise.race([
      new Promise<boolean>((done) => holder.stdout!.once("data", () => done(true))),
      holderGone.then(() => false),
    ]);
    if (!ready) throw new Error("could not hold the launcher open");
    // The launcher itself cannot start while held; a copy of the same
    // version runs the update, which then swaps the launcher. Named .exe:
    // Bun does not start extensionless files on Windows.
    const copyDir = mkdtempSync(join(tmpdir(), "opencode-claude-update-exe-"));
    try {
      const copy = join(copyDir, "claude.exe");
      copyFileSync(join(versionsDir, from), copy);
      const held = await updateClaudeCli({
        binaryPath: copy,
        // By the time of the check the other program is gone.
        async probeVersion() {
          holder.kill();
          await holderGone;
          return installedVersion();
        },
      });
      check(
        "6 launcher held",
        held.kind === "failed" && held.installed === from && held.message.includes("`claude --version` reports"),
        describe(held),
      );
    } finally {
      holder.kill();
      await holderGone;
      rmSync(copyDir, { recursive: true, force: true });
    }
  } else {
    console.log("skip 6 launcher held: Windows only (POSIX renames over an open file)");
  }
} catch (err) {
  failures += 1;
  console.log(`FAIL ${err instanceof Error ? err.message : err}`);
} finally {
  // Whatever happened, end on the newest version.
  const version = restore();
  const kept = existsSync(backupDir) ? `; the newest version is kept in ${backupDir}` : "";
  console.log(`end: CLI ${version}${latest && version !== latest ? ` (expected ${latest})${kept}` : ""}`);
  if (latest && version !== latest) failures += 1;
}

console.log(failures === 0 ? "ok — cli update live check passed" : `${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
