// Timezone helpers built only on Intl, so they behave the same in browsers, Node, and Cloudflare Workers.

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number; // 0 = Sunday
}

const weekdayIndex: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const formatterCache = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string) {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23",
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

export function isTimezone(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 80 || !/^[A-Za-z_]+(?:\/[A-Za-z0-9_-]+){0,2}$/.test(value)) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

export function localParts(instant: number | Date, timeZone: string): LocalParts {
  const values: Record<string, string> = {};
  for (const part of partsFormatter(timeZone).formatToParts(instant)) values[part.type] = part.value;
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour) % 24,
    minute: Number(values.minute),
    weekday: weekdayIndex[values.weekday] ?? 0,
  };
}

export function localDateKey(instant: number | Date, timeZone: string) {
  const parts = localParts(instant, timeZone);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

export function isDateKey(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function isUtcTimestamp(value: unknown): value is string {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
    && Number.isFinite(Date.parse(value));
}

/** Weekday (0 = Sunday) of a calendar date, independent of timezone. */
export function weekdayOfDateKey(date: string) {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

export function addDaysToDateKey(date: string, days: number) {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/**
 * Converts a clinic-local wall-clock time to a UTC instant. Returns null for a local time that does not
 * exist (spring-forward gap). For an ambiguous fall-back time it picks the first occurrence.
 */
export function zonedTimeToUtc(date: string, time: string, timeZone: string): string | null {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  if (![year, month, day, hour, minute].every(Number.isFinite)) return null;
  const target = Date.UTC(year, month - 1, day, hour, minute);
  let guess = target;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const local = localParts(guess, timeZone);
    const represented = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
    guess += target - represented;
  }
  // Prefer the earlier of two valid candidates when the clock falls back.
  const earlier = guess - 60 * 60 * 1000;
  const earlierParts = localParts(earlier, timeZone);
  if (earlierParts.year === year && earlierParts.month === month && earlierParts.day === day
    && earlierParts.hour === hour && earlierParts.minute === minute) guess = earlier;
  const check = localParts(guess, timeZone);
  if (check.year !== year || check.month !== month || check.day !== day || check.hour !== hour || check.minute !== minute) return null;
  return new Date(guess).toISOString();
}

/** Intl output can contain narrow no-break spaces (for example before "AM"); keep stored text plain ASCII. */
export function plainSpaces(value: string) {
  return value.replace(/[   ]/g, " ");
}

export function formatLocalLong(instant: string | number, timeZone: string) {
  return plainSpaces(new Intl.DateTimeFormat("en-US", {
    weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", timeZone,
  }).format(new Date(instant)));
}

export function timezoneLabel(timeZone: string) {
  return timeZone.replaceAll("_", " ").replaceAll("/", " / ");
}
