/**
 * Regressions for date-bearing reset times. Claude Code (2.1.x, `xc()` in the
 * CLI bundle) prints resets more than 24h away with a date:
 *   "You've hit your weekly limit · resets Oct 6, 1pm (UTC)"
 *   "... resets Oct 6, 1:30pm (America/New_York)"
 *   "... resets Jan 2, 2027, 1pm (UTC)"            (year shown when it differs)
 * These used to fall back to the 10-minute block. The five-hour one, within a
 * day, has the time alone; CLI 2.1.312 names it "5-hour limit" (no longer
 * "session limit"; BEHAVIOR.md "Failures of a model call").
 *
 * Ported from the fork's c74af3b. The texts are the CLI's as its formatter
 * writes them (`cliResetTime` below); the subscription's own limit result
 * around them needs a plan sign-in and is not simulated (BEHAVIOR.md, the
 * live run), so the store is fed the text as the plugin reads it from that
 * result. Each case is independent.
 *
 * Run: bun test/weekly-reset-regression.ts
 */
// A non-UTC process zone proves zone-less stamps are not read as local time.
process.env.TZ = "Asia/Tokyo";

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testCases } from "./simulators/cases.ts";
import { pluginModule } from "./simulators/world.ts";

// The plugin of the tree under test (OPENCODE_CLAUDE_PLUGIN_DIR), as every test reads it.
const { parseResetTimeFromText, recordRateLimitErrorText } = await pluginModule("rate-limit");

const HOUR = 3_600_000;

/**
 * The CLI's reset formatter, with the zone made explicit (the CLI uses the
 * system zone and prints it in parentheses).
 */
function cliResetTime(ms: number, zone: string, now: number): string {
  const date = new Date(ms);
  const zoned = (opts: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat("en-US", { timeZone: zone, ...opts });
  const minutes = Number(zoned({ minute: "numeric" }).format(date));
  const time = { hour: "numeric", minute: minutes === 0 ? undefined : "2-digit", hour12: true } as const;
  const text =
    (ms - now) / HOUR > 24
      ? date.toLocaleString("en-US", {
          timeZone: zone,
          month: "short",
          day: "numeric",
          ...time,
          ...(zoned({ year: "numeric" }).format(date) !== zoned({ year: "numeric" }).format(new Date(now))
            ? { year: "numeric" }
            : {}),
        })
      : date.toLocaleTimeString("en-US", { timeZone: zone, ...time });
  return `${text.replace(/[  ]([AP]M)/i, (_m, ap: string) => ap.toLowerCase())} (${zone})`;
}

async function main() {
  const tmp = mkdtempSync(join(tmpdir(), "opencode-claude-weekly-reset-"));
  process.env.OPENCODE_CLAUDE_RATE_LIMIT_STORE = join(tmp, "rate-limit.json");
  const cases = testCases();
  const sep22 = Date.UTC(2026, 8, 22, 12);

  try {
    await cases.run("the CLI's exact strings in UTC: a date, minutes, midnight and noon", () => {
      // ICU versions differ on the date/time joiner (", " vs " at "); the
      // parser takes both, so the round trips below hold either way.
      assert.match(cliResetTime(Date.UTC(2026, 9, 6, 13), "UTC", sep22), /^Oct 6(,| at) 1pm \(UTC\)$/);
      assert.equal(
        parseResetTimeFromText("You've hit your weekly limit · resets Oct 6, 1pm (UTC)", sep22),
        Date.UTC(2026, 9, 6, 13),
      );
      assert.equal(
        parseResetTimeFromText("You've hit your Opus limit · resets Oct 6, 1:30pm (UTC) · progress saved", sep22),
        Date.UTC(2026, 9, 6, 13, 30),
      );
      assert.equal(
        parseResetTimeFromText("You've hit your weekly limit · resets Sep 25, 12am (UTC)", sep22),
        Date.UTC(2026, 8, 25, 0),
        "12am is midnight",
      );
      assert.equal(
        parseResetTimeFromText("You've hit your weekly limit · resets Sep 25, 12pm (UTC)", sep22),
        Date.UTC(2026, 8, 25, 12),
        "12pm is noon",
      );
    });

    await cases.run("a zone with daylight saving: EDT before Nov 1 2026, EST after, spring forward", () => {
      const oct28 = Date.UTC(2026, 9, 28, 12);
      assert.equal(
        parseResetTimeFromText("You've hit your weekly limit · resets Oct 30, 11pm (America/New_York)", oct28),
        Date.UTC(2026, 9, 31, 3),
        "EDT is UTC-4",
      );
      assert.equal(
        parseResetTimeFromText("You've hit your weekly limit · resets Nov 3, 9:15am (America/New_York)", oct28),
        Date.UTC(2026, 10, 3, 14, 15),
        "EST is UTC-5",
      );
      // Spring forward (Mar 8 2026): 3:30am exists only as EDT.
      assert.equal(
        parseResetTimeFromText("resets Mar 8, 3:30am (America/New_York)", Date.UTC(2026, 2, 5)),
        Date.UTC(2026, 2, 8, 7, 30),
      );
    });

    await cases.run("the year rolls over: shown when it differs, a yearless date before now is next year's", () => {
      const dec30 = Date.UTC(2026, 11, 30, 12);
      assert.match(cliResetTime(Date.UTC(2027, 0, 2, 13), "UTC", dec30), /^Jan 2, 2027(,| at) 1pm \(UTC\)$/);
      assert.equal(
        parseResetTimeFromText("You've hit your weekly limit · resets Oct 6 at 1pm (UTC)", sep22),
        Date.UTC(2026, 9, 6, 13),
      );
      assert.equal(
        parseResetTimeFromText("You've hit your weekly limit · resets Jan 2, 2027, 1pm (UTC)", dec30),
        Date.UTC(2027, 0, 2, 13),
      );
      assert.equal(
        parseResetTimeFromText("You've hit your weekly limit · resets Jan 2, 1pm (UTC)", dec30),
        Date.UTC(2027, 0, 2, 13),
        "yearless date before now rolls into next year",
      );
      assert.equal(
        parseResetTimeFromText("You've hit your weekly limit · resets Jan 2, 1pm (America/New_York)", dec30),
        Date.UTC(2027, 0, 2, 18),
      );
    });

    await cases.run("a round trip every 7 hours for a year across zones, a 30-minute daylight saving shift too", () => {
      const zones = ["UTC", "America/New_York", "Europe/Kyiv", "Australia/Lord_Howe", "Asia/Kolkata"];
      for (const zone of zones) {
        for (let now = Date.UTC(2026, 0, 1); now < Date.UTC(2027, 0, 1); now += 7 * HOUR) {
          const reset = now + 25 * HOUR + ((now / HOUR) % 5) * 37 * HOUR + (now % 3 === 0 ? 30 * 60_000 : 0);
          const shown = cliResetTime(reset, zone, now);
          const parsed = parseResetTimeFromText(`You've hit your weekly limit · resets ${shown}`, now);
          // A fall-back hour prints the same for both instants; the earlier wins.
          const ambiguous = cliResetTime(reset - HOUR, zone, now) === shown;
          assert.equal(parsed, ambiguous ? reset - HOUR : reset, `${zone} ${shown} from ${new Date(now).toISOString()}`);
        }
      }
    });

    await cases.run("an unknown zone and a non-date stay unparsed; the time alone (the 5-hour limit) still works", () => {
      assert.equal(parseResetTimeFromText("resets Oct 6, 1pm (Mars/Olympus)", sep22), undefined);
      assert.equal(parseResetTimeFromText("resets Feb 30, 1pm (UTC)", sep22), undefined);
      // Time-only: its 5-minute scan lands within 2 minutes. CLI 2.1.312's words for the five-hour limit.
      const fivePm = parseResetTimeFromText("You've hit your 5-hour limit · resets 5pm (UTC)", sep22)!;
      assert.ok(Math.abs(fivePm - Date.UTC(2026, 8, 22, 17)) <= 2 * 60_000, String(fivePm));
    });

    await cases.run("a gateway's spend limit: resets 2026-10-06 13:00 UTC is UTC, not local", () => {
      assert.equal(
        parseResetTimeFromText("spend limit reached (monthly; resets 2026-10-06 13:00 UTC)"),
        Date.UTC(2026, 9, 6, 13),
      );
    });

    await cases.run("the limit's text blocks until the dated reset", () => {
      const reset = Math.floor(Date.now() / HOUR) * HOUR + 3 * 24 * HOUR;
      const message = `You've hit your weekly limit · resets ${cliResetTime(reset, "America/New_York", Date.now())}`;
      const state = recordRateLimitErrorText(message);
      assert.ok(state?.limited, message);
      assert.equal(state!.limitedUntil, reset, message);
      assert.equal(state!.resetsAt, reset);
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  cases.done();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
