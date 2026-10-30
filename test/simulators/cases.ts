/**
 * Independent cases of one test file: a failed case does not stop the others.
 *
 *   const cases = testCases();
 *   await cases.run("a stopped answer keeps what the screen showed", async () => { ... });
 *   cases.done();
 *
 * Each case prints one line from the line's start, the form the test system
 * reads: `ok   <name>` or `FAIL <name>`,
 * and the detail on the lines below it, indented. A case's name is one line,
 * without "|", and unique within its file: a row of expected.md names it. A
 * body may return a short text of what it saw, printed under an ok case.
 *
 * A case that does not end in time (`timeoutMs`, 120 s unless set) prints
 * FAIL with "no end in <n> s" and the next case runs; what it left running
 * may still disturb the cases after it. `done()` prints "<n> passed, <m>
 * failed" and sets the exit code to 1 when a case failed; it does not call
 * process.exit, so the output and the test system's records are written in
 * full (call process.exit after it when the world leaves handles open).
 */
export type CaseOutcome = { name: string; ok: boolean; detail: string };

export function testCases(options: { timeoutMs?: number } = {}) {
  const outcomes: CaseOutcome[] = [];
  const names = new Set<string>();
  const defaultTimeout = options.timeoutMs ?? 120_000;

  async function run(name: string, body: () => Promise<string | void> | string | void, timeoutMs = defaultTimeout): Promise<boolean> {
    if (name.includes("\n") || name.includes("|")) throw new Error(`a case's name is one line without "|": ${JSON.stringify(name)}`);
    if (names.has(name)) throw new Error(`two cases named "${name}" in one file`);
    names.add(name);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const lateText = `no end in ${timeoutMs >= 1000 ? Math.round(timeoutMs / 1000) : timeoutMs / 1000} s`;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(lateText), timeoutMs);
    });
    let outcome: CaseOutcome;
    try {
      const detail = (await Promise.race([Promise.resolve().then(body), late])) ?? "";
      outcome = { name, ok: true, detail };
    } catch (error) {
      outcome = { name, ok: false, detail: error instanceof Error ? (error.stack ?? error.message) : String(error) };
    } finally {
      clearTimeout(timer);
    }
    outcomes.push(outcome);
    const detail = outcome.detail ? `\n${outcome.detail.split("\n").map((line) => `       ${line}`).join("\n")}` : "";
    console.log(`${outcome.ok ? "ok  " : "FAIL"} ${name}${detail}`);
    return outcome.ok;
  }

  function done(): CaseOutcome[] {
    const failed = outcomes.filter((o) => !o.ok);
    console.log(`\n${outcomes.length - failed.length} passed, ${failed.length} failed`);
    if (failed.length > 0) process.exitCode = 1;
    return outcomes;
  }

  return { run, done, outcomes };
}
