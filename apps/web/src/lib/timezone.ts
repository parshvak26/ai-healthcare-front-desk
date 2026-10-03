import type { Market } from "../types";

export const marketTimezones: Record<Market, string[]> = {
  USA: ["America/New_York", "America/Chicago", "America/Los_Angeles"],
  UAE: ["Asia/Dubai"],
  Europe: ["Europe/London", "Europe/Paris", "Europe/Berlin"],
  India: ["Asia/Kolkata"],
};

export const allTimezones = [...new Set(Object.values(marketTimezones).flat())];

export function formatDateTime(value: string, timeZone: string, options?: Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone,
    ...options,
  }).format(new Date(value));
}

export function formatDate(value: string, timeZone: string) {
  return new Intl.DateTimeFormat("en", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone,
  }).format(new Date(value));
}

export function formatTime(value: string, timeZone: string) {
  return new Intl.DateTimeFormat("en", {
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  }).format(new Date(value));
}

export function timezoneLabel(timeZone: string) {
  return timeZone.replaceAll("_", " ").replaceAll("/", " / ");
}

function getZonedParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);

  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

export function localDateTimeToUtc(localValue: string, timeZone: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(localValue);
  if (!match) throw new Error("Choose a valid date and time.");

  const [, year, month, day, hour, minute] = match;
  const desired = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute));
  let guess = desired;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = getZonedParts(new Date(guess), timeZone);
    const represented = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
    );
    guess += desired - represented;
  }

  const resolved = getZonedParts(new Date(guess), timeZone);
  if (
    resolved.year !== year ||
    resolved.month !== month ||
    resolved.day !== day ||
    resolved.hour !== hour ||
    resolved.minute !== minute
  ) {
    throw new Error("That local time does not exist because of a timezone clock change. Choose another time.");
  }

  return new Date(guess).toISOString();
}

export function addLocalDays(value: string, days: number, timeZone: string) {
  const parts = getZonedParts(new Date(value), timeZone);
  const nextDate = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day) + days));
  const dateParts = getZonedParts(nextDate, timeZone);
  return localDateTimeToUtc(
    `${dateParts.year}-${dateParts.month}-${dateParts.day}T${parts.hour}:${parts.minute}`,
    timeZone,
  );
}

export function defaultLocalDateTime(timeZone: string) {
  const date = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const parts = getZonedParts(date, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}T10:00`;
}
