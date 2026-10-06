// Slot, reminder, and identifier rules shared by the browser, the Worker, and the voice tools.
import { clinicHours, defaultClinicTimezone, providers, quietHours, serviceDurations } from "./catalog.ts";
import { sameName } from "./names.ts";
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

/** Future start times on the clinic grid for one local date, ignoring who is free. */
function slotGrid(date: string, appointmentType: string, timezone: string, now: number) {
  if (!Object.hasOwn(serviceDurations, appointmentType)) throw new DomainError(400, "invalid_appointment_type", "Choose one of the sample appointment types.");
  if (!isDateKey(date)) throw new DomainError(400, "invalid_date", "Use a valid date like 2026-10-15.");
  if (!isTimezone(timezone)) throw new DomainError(400, "invalid_timezone", "Choose a valid timezone for the sample schedule.");
  const today = localDateKey(now, timezone);
  if (date < today) return [];
  if (date > addDaysToDateKey(today, bookingHorizonDays)) throw new DomainError(400, "date_out_of_range", "Choose a date within the next year.");
  if (!(clinicHours.openWeekdays as readonly number[]).includes(weekdayOfDateKey(date))) return [];
  const duration = serviceDurations[appointmentType];
  const starts: string[] = [];
  for (let minutes = clinicHours.openMinute; minutes + duration <= clinicHours.closeMinute; minutes += clinicHours.slotStepMinutes) {
    const time = `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
    const startAt = zonedTimeToUtc(date, time, timezone);
    if (startAt && Date.parse(startAt) > now) starts.push(startAt);
  }
  return starts;
}

function toSlot(startAt: string, timezone: string, provider: (typeof providers)[number]): AvailabilitySlot {
  return { startAt, timezone, provider: provider.name, location: provider.location, localTime: formatLocalLong(startAt, timezone) };
}

export function buildAvailability(state: Pick<DemoState, "appointments">, query: AvailabilityQuery): AvailabilitySlot[] {
  const slots: AvailabilitySlot[] = [];
  for (const startAt of slotGrid(query.date, query.appointmentType, query.timezone, query.now)) {
    const provider = providers.find((item) => !providerIsBusy(state, item.name, Date.parse(startAt), query.appointmentType, query.ignoreAppointmentId));
    if (provider) slots.push(toSlot(startAt, query.timezone, provider));
  }
  return slots;
}

export interface SlotRequest {
  startMs: number;
  appointmentType: string;
  timezone: string;
  now: number;
  /** When given, only this provider may take the slot (the one the caller or staff member was shown). */
  provider?: string;
  ignoreAppointmentId?: string;
}

/** The exact slot being confirmed, or null if that time (with that provider, if named) is no longer free. */
export function resolveSlot(state: Pick<DemoState, "appointments">, request: SlotRequest): AvailabilitySlot | null {
  if (request.provider !== undefined && !providers.some((item) => item.name === request.provider)) {
    throw new DomainError(400, "invalid_provider", "Choose one of the sample providers.");
  }
  const date = localDateKey(request.startMs, request.timezone);
  const startAt = slotGrid(date, request.appointmentType, request.timezone, request.now)
    .find((item) => Math.abs(Date.parse(item) - request.startMs) < MINUTE);
  if (!startAt) return null;
  const provider = providers.find((item) => (request.provider === undefined || item.name === request.provider)
    && !providerIsBusy(state, item.name, Date.parse(startAt), request.appointmentType, request.ignoreAppointmentId));
  return provider ? toSlot(startAt, request.timezone, provider) : null;
}

export type PartOfDay = "any" | "morning" | "afternoon";

export interface AvailabilitySearch {
  /** First local clinic date to search (YYYY-MM-DD). */
  startDate: string;
  /** Calendar days to search from startDate, 1–14. Closed days count but have no slots. */
  days: number;
  appointmentType: string;
  timezone: string;
  now: number;
  partOfDay?: PartOfDay;
  /** Earliest local start time, "HH:MM". */
  earliestTime?: string;
  provider?: string;
  /** How many offers to return (1–5, default 3). */
  limit?: number;
  ignoreAppointmentId?: string;
}

export interface SearchResult {
  slots: AvailabilitySlot[];
  /** True when more open times exist in the searched range than were offered. */
  moreAvailable: boolean;
  searchedFrom: string;
  searchedTo: string;
}

/**
 * Finds open times across several days and picks a few that are genuinely different choices: the earliest,
 * then a later part of the same day, then another day, rather than 8:00, 8:30 and 9:00.
 */
export function searchAvailability(state: Pick<DemoState, "appointments">, query: AvailabilitySearch): SearchResult {
  if (!isDateKey(query.startDate)) throw new DomainError(400, "invalid_date", "Use a valid date like 2026-10-15.");
  if (!Number.isInteger(query.days) || query.days < 1 || query.days > 14) throw new DomainError(400, "invalid_range", "Search between 1 and 14 days.");
  if (query.provider !== undefined && !providers.some((item) => item.name === query.provider)) throw new DomainError(400, "invalid_provider", "Choose one of the sample providers.");
  const earliest = query.earliestTime === undefined ? null : /^([01]\d|2[0-3]):([0-5]\d)$/.exec(query.earliestTime);
  if (query.earliestTime !== undefined && !earliest) throw new DomainError(400, "invalid_time", "Use a time like 13:30.");
  const earliestMinute = earliest ? Number(earliest[1]) * 60 + Number(earliest[2]) : 0;
  const limit = Math.min(5, Math.max(1, query.limit ?? 3));
  const today = localDateKey(query.now, query.timezone);
  const from = query.startDate < today ? today : query.startDate;
  const to = addDaysToDateKey(from, query.days - 1);

  const all: AvailabilitySlot[] = [];
  for (let date = from; date <= to; date = addDaysToDateKey(date, 1)) {
    for (const startAt of slotGrid(date, query.appointmentType, query.timezone, query.now)) {
      const local = localParts(Date.parse(startAt), query.timezone);
      const minute = local.hour * 60 + local.minute;
      if (minute < earliestMinute) continue;
      if (query.partOfDay === "morning" && minute >= 12 * 60) continue;
      if (query.partOfDay === "afternoon" && minute < 12 * 60) continue;
      const provider = providers.find((item) => (query.provider === undefined || item.name === query.provider)
        && !providerIsBusy(state, item.name, Date.parse(startAt), query.appointmentType, query.ignoreAppointmentId));
      if (provider) all.push(toSlot(startAt, query.timezone, provider));
    }
  }

  const chosen: AvailabilitySlot[] = [];
  const day = (slot: AvailabilitySlot) => localDateKey(Date.parse(slot.startAt), query.timezone);
  const gap = (a: AvailabilitySlot, b: AvailabilitySlot) => Math.abs(Date.parse(a.startAt) - Date.parse(b.startAt));
  const take = (predicate: (slot: AvailabilitySlot) => boolean) => {
    if (chosen.length >= limit) return;
    const found = all.find((slot) => !chosen.includes(slot) && predicate(slot));
    if (found) chosen.push(found);
  };
  if (all.length) {
    chosen.push(all[0]);
    take((slot) => day(slot) === day(all[0]) && gap(slot, all[0]) >= 150 * MINUTE);
    while (chosen.length < limit) {
      const before = chosen.length;
      take((slot) => !chosen.some((item) => day(item) === day(slot)));
      if (chosen.length === before) take((slot) => chosen.every((item) => gap(item, slot) >= 60 * MINUTE));
      if (chosen.length === before) take(() => true);
      if (chosen.length === before) break;
    }
  }
  chosen.sort((a, b) => a.startAt.localeCompare(b.startAt));
  return { slots: chosen, moreAvailable: all.length > chosen.length, searchedFrom: from, searchedTo: to };
}

/** True when the same patient already has an active visit overlapping this time. Names compare without case or accents. */
export function patientIsBusy(state: Pick<DemoState, "appointments">, patient: string, startMs: number, type: string, ignoreAppointmentId?: string) {
  const endMs = startMs + (serviceDurations[type] || 30) * MINUTE;
  return state.appointments.some((item) => sameName(item.patient, patient) && item.id !== ignoreAppointmentId
    && (item.status === "Confirmed" || item.status === "Needs confirmation")
    && startMs < appointmentEnd(item) && Date.parse(item.startAt) < endMs);
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
