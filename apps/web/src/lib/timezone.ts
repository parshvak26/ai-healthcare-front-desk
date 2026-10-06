import { addDaysToDateKey, clinicHours, localDateKey, localParts, weekdayOfDateKey } from "../../../../packages/shared/src/index.ts";

export { allClinicTimezones as allTimezones, marketTimezones, timezoneLabel } from "../../../../packages/shared/src/index.ts";

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
  return new Intl.DateTimeFormat("en", { weekday: "short", month: "short", day: "numeric", timeZone }).format(new Date(value));
}

export function formatTime(value: string, timeZone: string) {
  return new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit", timeZone }).format(new Date(value));
}

export function formatDateKey(date: string) {
  const [year, month, day] = date.split("-").map(Number);
  return new Intl.DateTimeFormat("en", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(year, month - 1, day)));
}

export function todayKey(timeZone: string, now = Date.now()) {
  return localDateKey(now, timeZone);
}

/** First clinic opening day on or after today (clinic time). */
export function nextOpenDateKey(timeZone: string, now = Date.now()) {
  let date = todayKey(timeZone, now);
  const parts = localParts(now, timeZone);
  const isOpenDay = (key: string) => (clinicHours.openWeekdays as readonly number[]).includes(weekdayOfDateKey(key));
  if (!isOpenDay(date) || parts.hour * 60 + parts.minute >= clinicHours.closeMinute - 30) date = addDaysToDateKey(date, 1);
  while (!isOpenDay(date)) date = addDaysToDateKey(date, 1);
  return date;
}

export function isClinicOpen(timeZone: string, now = Date.now()) {
  const parts = localParts(now, timeZone);
  const minute = parts.hour * 60 + parts.minute;
  return (clinicHours.openWeekdays as readonly number[]).includes(parts.weekday) && minute >= clinicHours.openMinute && minute < clinicHours.closeMinute;
}
