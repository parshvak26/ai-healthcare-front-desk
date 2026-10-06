// Per-call context for the voice agent: Retell dynamic variables (all strings) and the greeting. They never contain
// a patient name: names are caller input, so they stay out of Retell's stored call attributes and out of text that
// text-to-speech would read to whoever answers the phone. Returning callers are recognised by count only.
import {
  callerNames, clinicCalendar, isSamplePatient, isTimezone, localParts, spokenTime, spokenToday,
} from "../../../packages/shared/src/index.ts";
import type { Appointment, DemoState } from "../../../packages/shared/src/index.ts";

export type CallChannel = "phone" | "web";
export type CallCountry = "US" | "IN";

const zoneLabels: Record<string, string> = {
  "America/New_York": "Eastern time",
  "America/Chicago": "Central time",
  "America/Denver": "Mountain time",
  "America/Phoenix": "Mountain time",
  "America/Los_Angeles": "Pacific time",
  "America/Anchorage": "Alaska time",
  "Pacific/Honolulu": "Hawaii time",
  "Asia/Kolkata": "India time",
};
const weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function zoneLabel(timeZone: string) {
  return zoneLabels[timeZone] ?? `${timeZone.split("/").pop()?.replaceAll("_", " ") ?? timeZone} time`;
}

/** Minutes ahead of UTC at this instant. */
function utcOffsetMinutes(timeZone: string, at: number) {
  const parts = localParts(at, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  return Math.round((asUtc - Math.floor(at / 60_000) * 60_000) / 60_000);
}

export function sameClock(a: string, b: string, at: number) {
  return a === b || utcOffsetMinutes(a, at) === utcOffsetMinutes(b, at);
}

/**
 * The caller's zone: +91 numbers are in India; for +1 numbers the browser's zone is used when it is a US zone; a
 * browser call uses the browser's zone. Anything else falls back to the clinic zone.
 */
export function callerTimezone(channel: CallChannel, country: CallCountry | undefined, requested: unknown, fallback: string) {
  const valid = typeof requested === "string" && isTimezone(requested) ? requested : undefined;
  if (channel === "phone") {
    if (country === "IN") return "Asia/Kolkata";
    return valid && (valid.startsWith("America/") || valid === "Pacific/Honolulu") ? valid : fallback;
  }
  return valid ?? fallback;
}

/** Emergency and crisis lines by country; generic wording when the country is unknown. */
export function safetyNumbers(country: CallCountry | undefined) {
  if (country === "US") return { emergency: "911", crisis: "988" };
  if (country === "IN") return { emergency: "112", crisis: "Tele-MANAS on 14416" };
  return { emergency: "your local emergency number", crisis: "a local crisis line" };
}

const activeStatuses = new Set(["Confirmed", "Needs confirmation"]);

/** Upcoming active bookings made under names callers gave (not the five sample patients). */
export function callerBookings(state: DemoState, now: number): Appointment[] {
  return state.appointments.filter((item) => activeStatuses.has(item.status) && Date.parse(item.startAt) > now && !isSamplePatient(item.patient));
}

export const beginMessages = {
  phoneNew: "Hi, this is Ava, the AI receptionist at Harbor Health, calling for the demo you requested. It's a demo clinic, so made-up details are fine. How can I help?",
  browserNew: "Hi, this is Ava, the AI receptionist at Harbor Health. It's a demo clinic, so made-up details are fine. How can I help?",
  phoneReturning: "Hi, this is Ava, the AI receptionist at Harbor Health, calling for the demo you requested. Welcome back! Who am I speaking with?",
  browserReturning: "Hi, this is Ava, the AI receptionist at Harbor Health. Welcome back to the demo. Who am I speaking with?",
} as const;

export interface CallContextInput {
  channel: CallChannel;
  /** Phone: the dialled number's country. Web: the visitor's country from Cloudflare, when it is US or IN. */
  country?: CallCountry;
  requestedTimezone?: unknown;
  state: DemoState;
  now: number;
  clinicTimezone: string;
  maxSeconds: number;
}

export function buildCallContext(input: CallContextInput) {
  const { now, clinicTimezone } = input;
  const returning = callerNames(input.state).length > 0;
  const timezone = callerTimezone(input.channel, input.country, input.requestedTimezone, clinicTimezone);
  const safety = safetyNumbers(input.country);
  const dynamicVariables: Record<string, string> = {
    clinic_today: spokenToday(now, clinicTimezone),
    clinic_calendar: clinicCalendar(now, clinicTimezone),
    clinic_timezone_label: zoneLabel(clinicTimezone),
    caller_status: returning ? "returning" : "new",
    caller_booking_count: String(callerBookings(input.state, now).length),
    call_channel: input.channel === "phone" ? "phone" : "browser",
    caller_timezone: timezone,
    caller_time_differs: sameClock(timezone, clinicTimezone, now) ? "no" : "yes",
    emergency_number: safety.emergency,
    crisis_line: safety.crisis,
    max_minutes: String(Math.round(input.maxSeconds / 60)),
  };
  const beginMessage = input.channel === "phone"
    ? (returning ? beginMessages.phoneReturning : beginMessages.phoneNew)
    : (returning ? beginMessages.browserReturning : beginMessages.browserNew);
  return { dynamicVariables, beginMessage, callerTimezone: timezone };
}

/**
 * "8 p.m. your time", or "Friday at 8 p.m. your time" when the caller's date differs from the clinic's. Undefined
 * when both clocks agree.
 */
export function callerTime(instant: string, callerZone: string, clinicZone: string) {
  const at = Date.parse(instant);
  if (!Number.isFinite(at) || sameClock(callerZone, clinicZone, at)) return undefined;
  const caller = localParts(at, callerZone);
  const clinic = localParts(at, clinicZone);
  const sameDay = caller.year === clinic.year && caller.month === clinic.month && caller.day === clinic.day;
  const time = spokenTime(at, callerZone);
  return sameDay ? `${time} your time` : `${weekdays[caller.weekday]} at ${time} your time`;
}
