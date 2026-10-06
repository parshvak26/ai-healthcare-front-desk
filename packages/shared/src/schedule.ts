// Slot, reminder, and identifier rules shared by the browser, the Worker, and the voice tools.
import { clinicHours, defaultClinicTimezone, providers, quietHours, serviceDurations } from "./catalog.ts";
import {
  addDaysToDateKey, formatLocalLong, isDateKey, isTimezone, localDateKey, localParts, timezoneLabel, weekdayOfDateKey, zonedTimeToUtc,
} from "./time.ts";
import type { Appointment, AvailabilitySlot, DemoState } from "./types.ts";

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
/** How far ahead the demo scheduler accepts bookings. */
export const bookingHorizonDays = 365;

export class DomainError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "DomainError";
    this.status = status;
    this.code = code;
  }
}

function hash32Pair(input: string, seed: number) {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
}

/** Deterministic, non-secret record ID. The same idempotency key and part always give the same ID. */
export function stableId(prefix: string, ...parts: string[]) {
  const input = parts.join("|");
  return `${prefix}-${hash32Pair(input, 1)}${hash32Pair(input, 2)}`;
}

export function iso(ms: number) {
  return new Date(ms).toISOString();
}

export function appointmentTimezone(appointment: Pick<Appointment, "timezone">) {
  return appointment.timezone && isTimezone(appointment.timezone) ? appointment.timezone : defaultClinicTimezone;
}

export function appointmentEnd(appointment: Pick<Appointment, "startAt" | "type">) {
  return Date.parse(appointment.startAt) + (serviceDurations[appointment.type] || 30) * MINUTE;
}

export function providerIsBusy(state: Pick<DemoState, "appointments">, provider: string, startMs: number, type: string, ignoreAppointmentId?: string) {
  const endMs = startMs + (serviceDurations[type] || 30) * MINUTE;
  return state.appointments.some((item) => {
    if (item.status === "Cancelled" || item.provider !== provider || item.id === ignoreAppointmentId) return false;
    const itemStart = Date.parse(item.startAt);
    return startMs < appointmentEnd(item) && itemStart < endMs;
  });
}

export interface AvailabilityQuery {
  date: string;
  appointmentType: string;
  timezone: string;
  now: number;
  ignoreAppointmentId?: string;
}

export function buildAvailability(state: Pick<DemoState, "appointments">, query: AvailabilityQuery): AvailabilitySlot[] {
  const { date, appointmentType, timezone, now } = query;
  if (!Object.hasOwn(serviceDurations, appointmentType)) throw new DomainError(400, "invalid_appointment_type", "Choose one of the sample appointment types.");
  if (!isDateKey(date)) throw new DomainError(400, "invalid_date", "Use a valid date like 2026-10-15.");
  if (!isTimezone(timezone)) throw new DomainError(400, "invalid_timezone", "Choose a valid timezone for the sample schedule.");
  const today = localDateKey(now, timezone);
  if (date < today) return [];
  if (date > addDaysToDateKey(today, bookingHorizonDays)) throw new DomainError(400, "date_out_of_range", "Choose a date within the next year.");
  if (!(clinicHours.openWeekdays as readonly number[]).includes(weekdayOfDateKey(date))) return [];
  const duration = serviceDurations[appointmentType];
  const slots: AvailabilitySlot[] = [];
  for (let minutes = clinicHours.openMinute; minutes + duration <= clinicHours.closeMinute; minutes += clinicHours.slotStepMinutes) {
    const time = `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
    const startAt = zonedTimeToUtc(date, time, timezone);
    if (!startAt) continue;
    const startMs = Date.parse(startAt);
    if (startMs <= now) continue;
    const provider = providers.find((item) => !providerIsBusy(state, item.name, startMs, appointmentType, query.ignoreAppointmentId));
    if (provider) slots.push({ startAt, timezone, provider: provider.name, location: provider.location, localTime: formatLocalLong(startAt, timezone) });
  }
  return slots;
}

/** Moves a simulated text out of quiet hours (clinic local time) to the next allowed minute. */
export function outsideQuietHours(instant: number, timezone: string) {
  const parts = localParts(instant, timezone);
  const minute = parts.hour * 60 + parts.minute;
  if (minute >= quietHours.startMinute && minute < quietHours.endMinute) return instant;
  const date = localDateKey(instant, timezone);
  const targetDate = minute < quietHours.startMinute ? date : addDaysToDateKey(date, 1);
  const hh = String(Math.floor(quietHours.startMinute / 60)).padStart(2, "0");
  const mm = String(quietHours.startMinute % 60).padStart(2, "0");
  const next = zonedTimeToUtc(targetDate, `${hh}:${mm}`, timezone);
  return next ? Date.parse(next) : instant;
}

/** 24-hour reminder time, or null when the visit is too soon for a separate reminder to be useful. */
export function reminderTime(startAt: string, timezone: string, now: number) {
  const start = Date.parse(startAt);
  if (start - now < DAY) return null;
  const at = outsideQuietHours(start - DAY, timezone);
  return at < start - HOUR ? at : null;
}

/** One missing-document follow-up 48 hours after booking, unless the visit happens first. */
export function documentFollowUpTime(startAt: string, timezone: string, now: number) {
  const at = outsideQuietHours(now + 2 * DAY, timezone);
  return at < Date.parse(startAt) - HOUR ? at : null;
}

export function documentTaskDue(startAt: string, now: number) {
  return Math.max(now + HOUR, Math.min(now + 2 * DAY, Date.parse(startAt) - 2 * HOUR));
}

export const messageText = {
  bookingConfirmation: (startAt: string, timezone: string) => `Demo appointment confirmed for ${formatLocalLong(startAt, timezone)} (${timezoneLabel(timezone)}). No text was sent.`,
  reminder: (startAt: string, timezone: string) => `Reminder for your sample appointment at ${formatLocalLong(startAt, timezone)} (${timezoneLabel(timezone)}). This text is not sent.`,
};
