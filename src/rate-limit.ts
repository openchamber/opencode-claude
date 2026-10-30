/**
 * Claude subscription rate-limit tracker.
 *
 * The Agent SDK emits structured `rate_limit_event` events
 * ({ status, resetsAt, rateLimitType, utilization, ... }) and, on a hard
 * session/usage limit, fails the turn with a human message like
 * "You've hit your session limit · resets 1:10am (Europe/Kyiv)".
 *
 * This module records both into a small durable store so the proxy can:
 * - answer `GET /v1/rate-limit` with a live countdown ("counter when limits
 *   are back"),
 * - fail fast with HTTP 429 + Retry-After while a confirmed hard limit is
 *   active instead of spawning a doomed Agent SDK turn,
 * - append the reset countdown to the streamed error note.
 *
 * Store: $XDG_DATA_HOME/opencode-claude/rate-limit.json
 * Env:
 * - OPENCODE_CLAUDE_RATE_LIMIT_STORE — override store path (tests)
 * - OPENCODE_CLAUDE_RATE_LIMIT_FAST_FAIL=0 — disable the 429 gate
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type ClaudeRateLimitState = {
  /** Hard limit confirmed by an error result — gates new turns. */
  limited: boolean;
  /** Do not start new turns until this epoch ms (resetsAt or fallback). */
  limitedUntil?: number;
  /** Last SDK rate_limit_event status (allowed | allowed_warning | rejected…). */
  status?: string;
  /** e.g. "five_hour". */
  rateLimitType?: string;
  /** 0..1 when the SDK reports it. */
  utilization?: number;
  /** Epoch ms when the limited window resets (from SDK or parsed text). */
  resetsAt?: number;
  /** Last human-readable limit message. */
  message?: string;
  /** Overage pool disabled at org level (from SDK event). */
  overageDisabled?: boolean;
  updatedAt: number;
};

/** When a hard limit error carries no reset time, block new turns briefly. */
const FALLBACK_BLOCK_MS = 10 * 60 * 1000;

/**
 * A stored `rejected` event older than this no longer describes the limit a
 * fresh error hit; its resetsAt must not be reused as the block deadline.
 */
const REJECTION_EVENT_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * A project mapped to another Claude account (`configDirs` option) keeps that
 * account's limits in a store of its own, so one account's limit never
 * blocks the other's turns.
 */
function storePath(configDir?: string): string {
  const override = process.env.OPENCODE_CLAUDE_RATE_LIMIT_STORE?.trim();
  const xdg = process.env.XDG_DATA_HOME;
  const base = xdg ? xdg : join(homedir(), ".local", "share");
  const path = override || join(base, "opencode-claude", "rate-limit.json");
  if (!configDir) return path;
  const account = createHash("sha256").update(configDir).digest("hex").slice(0, 12);
  return `${path.replace(/\.json$/, "")}-${account}.json`;
}

function readState(configDir?: string): ClaudeRateLimitState | null {
  const path = storePath(configDir);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as ClaudeRateLimitState;
  } catch {
    return null;
  }
}

function writeState(state: ClaudeRateLimitState, configDir?: string): void {
  try {
    const path = storePath(configDir);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(state, null, 2) + "\n", "utf8");
  } catch {
    // never let the tracker break the proxy
  }
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Record a structured SDK `rate_limit_event` payload. Never sets `limited`
 * on its own — the SDK reports "rejected" for turns that still complete
 * (overage pool rejection); only a hard error result confirms the limit.
 */
export function recordRateLimitInfo(
  info: unknown,
  configDir?: string,
): ClaudeRateLimitState | null {
  if (!info || typeof info !== "object") return null;
  const raw = info as Record<string, unknown>;
  const prev = readState(configDir) ?? { limited: false, updatedAt: 0 };
  const resetsAtSec = asNumber(raw.resetsAt);
  const next: ClaudeRateLimitState = {
    ...prev,
    status: asString(raw.status) ?? prev.status,
    rateLimitType: asString(raw.rateLimitType) ?? prev.rateLimitType,
    // Utilization is window-scoped: keep only what the CURRENT event
    // reports. Carrying an earlier event's value forward (the SDK omits
    // utilization on plenty of events) resurrects an exhausted window's
    // ~100% long after the reset — bogus "99% of window used" notes and
    // counter values on later healthy "allowed" events.
    utilization: asNumber(raw.utilization),
    overageDisabled:
      typeof raw.overageDisabledReason === "string" &&
      raw.overageDisabledReason.length > 0
        ? true
        : prev.overageDisabled,
    resetsAt:
      resetsAtSec !== undefined
        ? resetsAtSec > 1e12
          ? resetsAtSec // already ms
          : resetsAtSec * 1000 // SDK emits epoch seconds
        : prev.resetsAt,
    updatedAt: Date.now(),
  };
  // Claude reports the window open again (reset time passed, or the user
  // reset their limits early): lift the gate instead of waiting for the old
  // reset time.
  if (next.status === "allowed" || next.status === "allowed_warning") {
    next.limited = false;
    delete next.limitedUntil;
  }
  writeState(next, configDir);
  return next;
}

/**
 * Match hard-limit error text from the Agent SDK / API. Claude Code words
 * subscription limits as "You've hit your session limit", "You've hit your
 * weekly limit", "You've reached your … limit"; raw API throttling surfaces as
 * `API Error: 429 {"error":{"type":"rate_limit_error",…}}`. A bare "429"
 * elsewhere (a line number, a byte count) is not enough, so the status only
 * counts when it follows the "API Error:" prefix.
 */
export function isClaudeRateLimitText(text: string): boolean {
  return (
    /\b(hit|reached) your [^·\n]*?limit/i.test(text) ||
    /usage limit reached/i.test(text) ||
    /rate[ _-]?limit/i.test(text) ||
    /API Error:\s*429\b/i.test(text) ||
    /too many requests/i.test(text)
  );
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Full-precision wall-clock formatter for `zone`; undefined for an unknown zone. */
function zoneFormatter(zone: string): Intl.DateTimeFormat | undefined {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      hourCycle: "h23",
    });
  } catch {
    return undefined;
  }
}

/** Wall clock of instant `t` in the formatter's zone, encoded as a UTC epoch. */
function wallClockAsUtc(fmt: Intl.DateTimeFormat, t: number): number {
  const parts = fmt.formatToParts(new Date(t));
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value);
  return Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour") % 24,
    get("minute"),
    get("second"),
  );
}

/**
 * Instant whose wall clock in the formatter's zone is `wall` (a UTC-encoded
 * wall time). Two offset passes settle DST transitions; a wall time skipped
 * by a spring-forward gap does not exist and yields undefined.
 */
function zonedWallToEpoch(fmt: Intl.DateTimeFormat, wall: number): number | undefined {
  const offsetAt = (t: number) => wallClockAsUtc(fmt, t) - Math.floor(t / 1000) * 1000;
  let t = wall - offsetAt(wall);
  t = wall - offsetAt(t);
  return wallClockAsUtc(fmt, t) === wall ? t : undefined;
}

/**
 * Parse a reset hint into epoch ms. Returns undefined when no reset hint is
 * present. Claude Code formats reset times (`resets ${time} (${zone})`) as:
 * - within 24h: "1:10am (Europe/Kyiv)", "5pm (UTC)";
 * - further out: "Oct 6, 1pm (UTC)", "Oct 6, 1:30pm (America/New_York)";
 * - in another year: "Jan 2, 2027, 1pm (UTC)";
 * plus ISO "reset at 2026-08-09T01:10:00" / "resets 2026-10-06 13:00 UTC".
 */
export function parseResetTimeFromText(
  text: string,
  now: number = Date.now(),
): number | undefined {
  // ISO-ish absolute timestamp; a trailing " UTC" stands for "Z".
  const iso =
    /resets?\s+(?:at\s+)?(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?)(\s*UTC\b)?/i.exec(
      text,
    );
  if (iso) {
    const stamp = iso[1].replace(" ", "T") + (!iso[2] && iso[3] ? "Z" : "");
    const parsed = Date.parse(stamp);
    if (Number.isFinite(parsed)) return parsed;
  }

  // "resets Oct 6, 1pm (UTC)" / "resets Jan 2, 2027, 1:30pm (America/New_York)"
  const dated =
    /resets?\s+(?:at\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?(?:,\s*|\s+)(?:at\s+)?(\d{1,2})(?::(\d{2}))?[\s\u202f]*(am|pm)?\s*\(([^)]+)\)/i.exec(
      text,
    );
  if (dated) {
    const month = MONTHS.indexOf(dated[1].toLowerCase());
    const day = Number(dated[2]);
    let hour = Number(dated[4]);
    const minute = dated[5] === undefined ? 0 : Number(dated[5]);
    const meridiem = dated[6]?.toLowerCase();
    if (dated[5] === undefined && !meridiem) return undefined;
    if (meridiem) {
      if (hour < 1 || hour > 12) return undefined;
      if (meridiem === "pm" && hour < 12) hour += 12;
      if (meridiem === "am" && hour === 12) hour = 0;
    }
    if (hour > 23 || minute > 59) return undefined;
    const fmt = zoneFormatter(dated[7].trim());
    if (!fmt) return undefined; // unknown IANA zone
    const resolve = (year: number) => {
      const wall = Date.UTC(year, month, day, hour, minute);
      // Reject overflowed dates such as "Feb 30".
      if (new Date(wall).getUTCMonth() !== month) return undefined;
      return zonedWallToEpoch(fmt, wall);
    };
    if (dated[3] !== undefined) return resolve(Number(dated[3]));
    // No year: the CLI omits it for the current year, so take the nearest
    // occurrence that is not long past (Dec 30 → "Jan 2" is next year).
    const year = new Date(wallClockAsUtc(fmt, now)).getUTCFullYear();
    for (const y of [year - 1, year, year + 1]) {
      const t = resolve(y);
      if (t !== undefined && t > now - 24 * 3_600_000) return t;
    }
    return undefined;
  }

  // "resets 1:10am (Europe/Kyiv)" / "resets at 13:05 (UTC)" / "resets 5pm (UTC)"
  const wall =
    /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*\(([^)]+)\)/i.exec(
      text,
    );
  if (!wall) return undefined;
  // Hours without minutes need a meridiem; a lone "resets 5 (UTC)" is noise.
  if (wall[2] === undefined && !wall[3]) return undefined;
  let hour = Number(wall[1]);
  const minute = wall[2] === undefined ? 0 : Number(wall[2]);
  const meridiem = wall[3]?.toLowerCase();
  const zone = wall[4].trim();
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return undefined;

  const fmt = zoneFormatter(zone);
  if (!fmt) return undefined; // unknown IANA zone
  // Exact wall time today, else tomorrow (limit resets are within ~24h by
  // design). Resolving via the zone's offset avoids the drift of a stepped
  // scan, which could land minutes before the real reset. A DST-skipped wall
  // time has no instant, so that day is skipped.
  const today = new Date(wallClockAsUtc(fmt, now));
  for (let dayOffset = 0; dayOffset <= 2; dayOffset++) {
    const wallTarget = Date.UTC(
      today.getUTCFullYear(),
      today.getUTCMonth(),
      today.getUTCDate() + dayOffset,
      hour,
      minute,
    );
    const t = zonedWallToEpoch(fmt, wallTarget);
    if (t !== undefined && t > now) return t;
  }
  return undefined;
}

/**
 * Record a hard-limit error message. Returns the updated state, or null when
 * the text is not a limit error.
 *
 * Block deadline, in order: the reset parsed from the text; the resetsAt of a
 * recent `rejected` rate_limit_event (the SDK emits it right before the
 * failing result); an already-active confirmed block; else a short fallback.
 * The stored resetsAt of any other event (e.g. an `allowed` seven_day window
 * days away) describes an unrelated window and never becomes the deadline.
 */
export function recordRateLimitErrorText(
  text: string,
  configDir?: string,
): ClaudeRateLimitState | null {
  if (!text || !isClaudeRateLimitText(text)) return null;
  const stored: ClaudeRateLimitState = readState(configDir) ?? {
    limited: false,
    updatedAt: 0,
  };
  const { resetsAt: prevResetsAt, ...prev } = stored;
  const now = Date.now();
  const parsed = parseResetTimeFromText(text, now);
  const rejectionResetsAt =
    prev.status === "rejected" &&
    now - prev.updatedAt < REJECTION_EVENT_MAX_AGE_MS &&
    prevResetsAt !== undefined &&
    prevResetsAt > now
      ? prevResetsAt
      : undefined;
  const activeUntil =
    prev.limited && prev.limitedUntil !== undefined && prev.limitedUntil > now
      ? prev.limitedUntil
      : undefined;
  const resetsAt =
    parsed !== undefined && parsed > now
      ? parsed
      : (rejectionResetsAt ??
        (activeUntil !== undefined && activeUntil === prevResetsAt
          ? prevResetsAt
          : undefined));
  const next: ClaudeRateLimitState = {
    ...prev,
    limited: true,
    limitedUntil: resetsAt ?? activeUntil ?? now + FALLBACK_BLOCK_MS,
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    message: text.trim().slice(0, 300),
    updatedAt: now,
  };
  writeState(next, configDir);
  return next;
}

/** Strip wrapper prefixes so duplicate error emissions compare equal. */
export function normalizeClaudeErrorText(text: string): string {
  return text
    .replace(/^\[claude-code error\]\s*/i, "")
    .replace(/^claude code returned an error result:\s*/i, "")
    .replace(/^rate limit:\s*/i, "") // tag added for SDK rate_limit events
    .replace(/\s*·\s*limit resets in .*$/i, "") // appended countdown suffix
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function formatResetCountdown(ms: number): string {
  if (ms <= 0) return "now";
  const sec = Math.round(ms / 1000);
  if (sec < 90) return `${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 90) return `${min}m`;
  const h = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin ? `${h}h ${remMin}m` : `${h}h`;
}

export type RateLimitSnapshot = {
  limited: boolean;
  limitedUntil?: number;
  resetsAt?: number;
  resetsAtISO?: string;
  resetInSeconds?: number;
  status?: string;
  rateLimitType?: string;
  utilization?: number;
  overageDisabled?: boolean;
  message?: string;
  updatedAt?: number;
};

/** Current snapshot; auto-clears an expired hard block (self-healing). */
export function getRateLimitSnapshot(
  now: number = Date.now(),
  configDir?: string,
): RateLimitSnapshot {
  const state = readState(configDir);
  if (!state) return { limited: false };
  let { limited, limitedUntil } = state;
  if (limited && limitedUntil !== undefined && now >= limitedUntil) {
    limited = false;
    writeState({ ...state, limited: false, updatedAt: now }, configDir);
  }
  const resetsAt = state.resetsAt;
  const resetInSeconds =
    limited && limitedUntil !== undefined
      ? Math.max(0, Math.round((limitedUntil - now) / 1000))
      : resetsAt !== undefined
        ? Math.max(0, Math.round((resetsAt - now) / 1000))
        : undefined;
  return {
    limited,
    ...(limitedUntil !== undefined ? { limitedUntil } : {}),
    ...(resetsAt !== undefined
      ? { resetsAt, resetsAtISO: new Date(resetsAt).toISOString() }
      : {}),
    ...(resetInSeconds !== undefined ? { resetInSeconds } : {}),
    ...(state.status ? { status: state.status } : {}),
    ...(state.rateLimitType ? { rateLimitType: state.rateLimitType } : {}),
    ...(state.utilization !== undefined
      ? { utilization: state.utilization }
      : {}),
    ...(state.overageDisabled !== undefined
      ? { overageDisabled: state.overageDisabled }
      : {}),
    ...(state.message ? { message: state.message } : {}),
    ...(state.updatedAt ? { updatedAt: state.updatedAt } : {}),
  };
}

export type RateLimitGate =
  | { blocked: false }
  | {
      blocked: true;
      retryAfterSeconds: number;
      resetsAt?: number;
      message: string;
    };

/**
 * Gate for new Agent SDK turns. Only a confirmed hard limit blocks, and only
 * until the known/estimated reset. OPENCODE_CLAUDE_RATE_LIMIT_FAST_FAIL=0
 * disables the gate entirely.
 */
export function rateLimitGate(
  now: number = Date.now(),
  configDir?: string,
): RateLimitGate {
  const flag = (process.env.OPENCODE_CLAUDE_RATE_LIMIT_FAST_FAIL ?? "")
    .toLowerCase();
  if (flag === "0" || flag === "false" || flag === "off") {
    return { blocked: false };
  }
  const snap = getRateLimitSnapshot(now, configDir);
  if (!snap.limited) return { blocked: false };
  const until = snap.limitedUntil ?? snap.resetsAt;
  const retryAfterSeconds =
    until !== undefined
      ? Math.max(1, Math.round((until - now) / 1000))
      : Math.round(FALLBACK_BLOCK_MS / 1000);
  const countdown = formatResetCountdown(retryAfterSeconds * 1000);
  const base = snap.message || "Claude session/usage limit reached";
  return {
    blocked: true,
    retryAfterSeconds,
    ...(snap.resetsAt !== undefined ? { resetsAt: snap.resetsAt } : {}),
    message: `${base} · limit resets in ${countdown}${
      snap.resetsAtISO ? ` (${snap.resetsAtISO})` : ""
    }`,
  };
}

// ---------------------------------------------------------------------------
// Stream note dedupe — one rate-limit note per status/threshold per process.
// ---------------------------------------------------------------------------

let lastNoteSignature: string | null = null;

/**
 * Build a short user-facing note for a structured event, but only when the
 * situation meaningfully changed (status change, or utilization crossing
 * 0.9 / 0.95 / 0.99). Returns null when nothing new is worth surfacing.
 *
 * `fresh` is the raw `rate_limit_info` payload of the event that triggered
 * the call. When provided it is authoritative: the note decision and text
 * use ONLY the event's own status/utilization, never merged store history —
 * a stale utilization from an earlier event or an earlier limit window must
 * not resurrect a "99% of window used" warning on a healthy "allowed" event.
 */
export function maybeRateLimitNote(
  state: ClaudeRateLimitState | null,
  fresh?: Record<string, unknown>,
): string | null {
  if (!state || !state.status) return null;
  const freshStatus = fresh ? asString(fresh.status) : undefined;
  const freshUtil = fresh ? asNumber(fresh.utilization) : undefined;
  const status = freshStatus ?? state.status;
  const util = freshUtil ?? state.utilization;
  // Without a fresh event (legacy direct calls) fall back to stored values;
  // with a fresh event, only data the event itself carried can trigger a
  // warning — "allowed" with no fresh utilization is always quiet.
  const interesting =
    status === "rejected" ||
    status === "allowed_warning" ||
    (fresh ? freshUtil !== undefined && freshUtil >= 0.9
          : util !== undefined && util >= 0.9);
  if (!interesting) {
    lastNoteSignature = null;
    return null;
  }
  const bucket =
    status === "rejected"
      ? "rejected"
      : (util ?? 0) >= 0.99
        ? "u99"
        : (util ?? 0) >= 0.95
          ? "u95"
          : "u90";
  const signature = `${status}:${bucket}:${state.resetsAt ?? ""}`;
  if (signature === lastNoteSignature) return null;
  lastNoteSignature = signature;

  const parts = ["[rate-limit] Claude"];
  if (state.rateLimitType) parts.push(state.rateLimitType.replace(/_/g, " "));
  if (status === "rejected") {
    parts.push("request rejected by limiter");
  } else if (util !== undefined && util >= 0.9) {
    parts.push(`${Math.round(util * 100)}% of window used`);
  } else {
    parts.push(status);
  }
  if (state.resetsAt) {
    const ms = state.resetsAt - Date.now();
    if (ms > 0) parts.push(`resets in ${formatResetCountdown(ms)}`);
  }
  return `${parts.join(" · ")}.\n`;
}

/** Test helper: reset process-local note dedupe. */
export function __resetRateLimitNoteDedupe(): void {
  lastNoteSignature = null;
}
