// What a call changed, worked out in the browser from the visitor's own private demo: voice-assistant events since the
// call was placed, enriched with the appointment, waitlist request or staff task they refer to. Nothing here is
// stored; the summary is rebuilt from the clinic state each time.
// Direct module imports (not the package index) keep the scheduling rules out of the call page bundle.
import { allowedDemoPatients, clinicHours, defaultClinicTimezone } from "../../../../packages/shared/src/catalog.ts";
import { callerNames } from "../../../../packages/shared/src/names.ts";
import { addDaysToDateKey, localDateKey, weekdayOfDateKey } from "../../../../packages/shared/src/time.ts";
import type { ActivityEvent, Appointment, DemoState } from "../types";

export type ChangeTone = "green" | "blue" | "orange" | "neutral";

export interface CallChange {
  id: string;
  at: string;
  icon: string;
  tone: ChangeTone;
  verb: string;
  patient?: string;
  /** "Thu Oct 8, 9:30 AM CT" */
  when?: string;
  /** "8:00 PM your time" when the viewer's clock differs from the clinic's. */
  whenLocal?: string;
  reference?: string;
  detail?: string;
}

const activeStatuses = new Set(["Confirmed", "Needs confirmation"]);

function zoneAbbreviation(instant: Date, timeZone: string) {
  const generic = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "shortGeneric" }).formatToParts(instant).find((part) => part.type === "timeZoneName")?.value;
  if (generic && generic.length <= 4) return generic;
  return new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" }).formatToParts(instant).find((part) => part.type === "timeZoneName")?.value ?? "";
}

/** "Thu Oct 8, 9:30 AM CT" plus "8:00 PM your time" (or "Fri 1:00 AM your time") when the viewer is elsewhere. */
export function clinicAndLocalTime(startAt: string, clinicZone: string, viewerZone: string) {
  const instant = new Date(startAt);
  const day = (zone: string) => new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: zone }).format(instant);
  const time = (zone: string) => new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: zone }).format(instant);
  const when = `${day(clinicZone)}, ${time(clinicZone)} ${zoneAbbreviation(instant, clinicZone)}`.trim();
  const sameClock = time(clinicZone) === time(viewerZone) && day(clinicZone) === day(viewerZone);
  if (sameClock) return { when };
  const sameDay = localDateKey(instant, clinicZone) === localDateKey(instant, viewerZone);
  const weekday = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: viewerZone }).format(instant);
  return { when, whenLocal: `${sameDay ? "" : `${weekday} `}${time(viewerZone)} your time` };
}

function appointmentTimes(appointment: Appointment, viewerZone: string) {
  return clinicAndLocalTime(appointment.startAt, appointment.timezone || defaultClinicTimezone, viewerZone);
}

function describe(event: ActivityEvent, state: DemoState, viewerZone: string): CallChange {
  const base = { id: event.id, at: event.at, patient: event.patient, reference: event.reference };
  const appointment = event.reference ? state.appointments.find((item) => item.reference === event.reference) : undefined;
  const times = appointment ? appointmentTimes(appointment, viewerZone) : {};
  switch (event.action) {
    case "Appointment booked":
      return { ...base, ...times, icon: "✓", tone: "green", verb: "Booked", patient: appointment?.patient ?? event.patient, detail: appointment?.type };
    case "Appointment rescheduled":
      return { ...base, ...times, icon: "↻", tone: "blue", verb: "Moved", detail: appointment ? `${appointment.type}, now` : undefined };
    case "Appointment cancelled":
      return { ...base, ...times, icon: "×", tone: "orange", verb: "Cancelled", detail: appointment?.type };
    case "Appointment confirmed":
      return { ...base, ...times, icon: "✓", tone: "green", verb: "Confirmed", detail: appointment?.type };
    case "Waitlist request added": {
      const request = state.waitlist.find((item) => item.patient === event.patient && Math.abs(Date.parse(item.createdAt) - Date.parse(event.at)) < 60_000)
        ?? state.waitlist.find((item) => item.patient === event.patient);
      const preferred = request ? new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${request.preferredDate}T12:00:00Z`)) : undefined;
      return { ...base, icon: "↗", tone: "blue", verb: "Added to waitlist", detail: request ? `${request.appointmentType} · around ${preferred}` : undefined };
    }
    case "Staff task created": {
      const task = event.taskId ? state.tasks.find((item) => item.id === event.taskId) : undefined;
      return { ...base, icon: "◷", tone: "neutral", verb: "Staff follow-up", detail: task?.title ?? "Request logged for the front desk", reference: event.reference ?? task?.appointmentReference };
    }
    case "Text reminders turned off":
      return { ...base, icon: "⊘", tone: "orange", verb: "Texts turned off" };
    case "Text reminders turned on":
      return { ...base, icon: "◌", tone: "green", verb: "Texts turned on" };
    default:
      return { ...base, icon: "•", tone: "neutral", verb: event.action };
  }
}

/** Changes the voice assistant made since `sinceMs` (server clock), oldest first. */
export function callChanges(state: DemoState, sinceMs: number, viewerZone: string): CallChange[] {
  return state.events
    .filter((event) => event.channel === "Voice assistant" && Date.parse(event.at) >= sinceMs)
    .sort((a, b) => a.at.localeCompare(b.at))
    .map((event) => describe(event, state, viewerZone));
}

/** One line, e.g. "Booked · Parshva · Thu Oct 8, 9:30 AM CT (8:00 PM your time) · DEMO-4812". */
export function changeLine(change: CallChange) {
  const when = change.when ? `${change.when}${change.whenLocal ? ` (${change.whenLocal})` : ""}` : undefined;
  return [change.verb, change.patient, change.detail, when, change.reference].filter(Boolean).join(" · ");
}

// ---------- the visitor's own bookings ----------

export interface OwnBooking { appointment: Appointment; when: string; whenLocal?: string }

/** Upcoming active bookings under names the visitor gave on their own calls. */
export function ownUpcomingBookings(state: DemoState, now: number, viewerZone: string): OwnBooking[] {
  const names = new Set(callerNames(state));
  return state.appointments
    .filter((item) => names.has(item.patient) && activeStatuses.has(item.status) && Date.parse(item.startAt) > now)
    .sort((a, b) => a.startAt.localeCompare(b.startAt))
    .slice(0, 3)
    .map((appointment) => ({ appointment, ...appointmentTimes(appointment, viewerZone) }));
}

// ---------- "Try saying" ----------

export interface TryGroup { title: string; lines: string[] }

const weekdayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function nextOpenDay(after: string) {
  let date = addDaysToDateKey(after, 1);
  while (!(clinicHours.openWeekdays as readonly number[]).includes(weekdayOfDateKey(date))) date = addDaysToDateKey(date, 1);
  return weekdayNames[weekdayOfDateKey(date)];
}

function visitDay(appointment: Appointment) {
  return weekdayNames[weekdayOfDateKey(localDateKey(new Date(appointment.startAt), appointment.timezone || defaultClinicTimezone))];
}

function moveTo(appointment: Appointment) {
  return nextOpenDay(localDateKey(new Date(appointment.startAt), appointment.timezone || defaultClinicTimezone));
}

/**
 * Ideas generated from the visitor's current clinic, so they never point at a past or cancelled visit: their own
 * upcoming booking when they have one, otherwise a future sample booking (Maya Patel's, Samira Khan's "Needs
 * confirmation" visit).
 */
export function trySaying(state: DemoState | null, now: number, viewerZone: string): TryGroup[] {
  const existing: string[] = [];
  const own = state ? ownUpcomingBookings(state, now, viewerZone)[0] : undefined;
  if (own) {
    const first = own.appointment.patient.split(" ")[0];
    existing.push(`“It's ${first}. Can you move my ${visitDay(own.appointment)} appointment to ${moveTo(own.appointment)}?”`);
    existing.push(`“What time is my visit, ${own.appointment.reference}?”`);
  } else if (state) {
    const samples = new Set<string>(allowedDemoPatients);
    const future = state.appointments
      .filter((item) => samples.has(item.patient) && activeStatuses.has(item.status) && Date.parse(item.startAt) > now + 60 * 60_000)
      .sort((a, b) => a.startAt.localeCompare(b.startAt));
    const confirmed = future.find((item) => item.patient === "Maya Patel" && item.status === "Confirmed") ?? future.find((item) => item.status === "Confirmed");
    const unconfirmed = future.find((item) => item.status === "Needs confirmation" && item !== confirmed);
    if (confirmed) existing.push(`“I'm ${confirmed.patient}, visit ${confirmed.reference}. Can I move it to ${moveTo(confirmed)}?”`);
    if (unconfirmed) existing.push(`“I'm ${unconfirmed.patient}. Can you confirm my visit, ${unconfirmed.reference}?”`);
  }
  if (existing.length === 0) existing.push("“I booked earlier this week — can you check my appointment?”");
  return [
    { title: "New patient", lines: ["“I'd like to book a new-patient visit next week, mornings if possible.”", "“What's the earliest consultation you have?”"] },
    { title: "Existing patient", lines: existing },
    { title: "Questions", lines: ["“What are your hours?”", "“Is there parking?”", "“Do you take my insurance?”"] },
    { title: "Requests", lines: ["“Can someone call me back about a bill?”", "“I need an interpreter for my visit.”"] },
  ];
}
