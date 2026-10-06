// Strict allowlist validation for the shared demo snapshot. Anything outside the fictional catalog is rejected,
// which keeps free text (and therefore real personal or health information) out of the public demo store.
import {
  allowedDemoPatients, legacyTaskDetails, legacyTaskTitles, providers, requestTemplates, serviceDurations, systemTaskTemplates,
} from "./catalog.ts";
import { isDateKey, isTimezone, isUtcTimestamp } from "./time.ts";
import type { ActivityAction, Channel, DemoState } from "./types.ts";

export const limits = { appointments: 100, tasks: 100, referrals: 100, messages: 400, waitlist: 100, events: 100 } as const;

const patientNames = new Set<string>(allowedDemoPatients);
const referencePattern = /^DEMO-\d{4}$/;
const idPattern = /^[A-Za-z0-9-]{1,100}$/;

export const appointmentStatuses = ["Confirmed", "Needs confirmation", "Cancelled", "Completed", "Missed"] as const;
export const taskStatuses = ["Open", "In progress", "Done"] as const;
export const documentStatuses = ["Needed", "Received", "In review"] as const;
export const messageStatuses = ["Delivered (demo)", "Queued (demo)", "Scheduled (demo)", "Cancelled (demo)", "Suppressed (opt-out)", "Opt-out"] as const;
export const waitlistStatuses = ["Waiting", "Opening found", "Contacted", "Booked", "Cancelled"] as const;
export const channels: readonly Channel[] = ["Staff console", "Voice assistant", "Automation"];
export const activityActions: readonly ActivityAction[] = [
  "Appointment booked", "Appointment rescheduled", "Appointment cancelled", "Appointment confirmed",
  "Visit marked attended", "Visit marked missed", "Waitlist request added", "Waitlist request cancelled",
  "Waitlist opening found", "Document received", "Staff task created", "Staff task updated",
  "Text reminders turned off", "Text reminders turned on", "Sample data reset",
];
export const messagePurposes = [
  "Booking confirmation", "Document reminder", "24-hour appointment reminder", "48-hour missing-document follow-up",
  "Reschedule confirmation", "Cancellation confirmation", "Opt-out", "Opt-in",
] as const;

const taskTitles = new Set<string>([
  ...Object.values(requestTemplates).map((item) => item.title),
  ...Object.values(systemTaskTemplates).map((item) => item.title),
  ...legacyTaskTitles,
]);
const taskDetails = new Set<string>([
  ...Object.values(requestTemplates).map((item) => item.detail),
  ...Object.values(systemTaskTemplates).map((item) => item.detail),
  ...legacyTaskDetails,
]);

export const messageBodies = {
  seededConfirmation: "Your demo appointment is confirmed. Reply STOP to opt out.",
  documentReminder: "A referral document is still needed for your demo visit.",
  optOut: "Text reminders have been turned off for this demo profile.",
  optIn: "Text reminders have been turned back on for this demo profile.",
  documentFollowUp: "A sample referral is still marked as needed. This follow-up is simulated and will be cancelled if the sample is received.",
  rescheduled: "Your sample appointment has been rescheduled. This is a demo message; nothing was sent.",
  cancelled: "Your sample appointment has been cancelled. This is a demo message; nothing was sent.",
} as const;

const fixedBodies = new Set<string>(Object.values(messageBodies));
const timedBodies = [
  /^Demo appointment confirmed for [A-Za-z0-9 ,:/.-]+ \([A-Za-z0-9 _/-]+\)\. No text was sent\.$/,
  /^Reminder for your sample appointment at [A-Za-z0-9 ,:/.-]+ \([A-Za-z0-9 _/-]+\)\. This text is not sent\.$/,
];

function hasOnlyKeys(value: unknown, allowed: readonly string[]): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).every((key) => allowed.includes(key)));
}

function oneOf<T extends string>(value: unknown, options: readonly T[]): value is T {
  return typeof value === "string" && (options as readonly string[]).includes(value);
}

export function isDemoPatient(value: unknown): value is string {
  return typeof value === "string" && patientNames.has(value);
}

export function isDemoReference(value: unknown): value is string {
  return typeof value === "string" && referencePattern.test(value);
}

export function isAppointmentType(value: unknown): value is string {
  return typeof value === "string" && Object.hasOwn(serviceDurations, value);
}

export function recipientPatient(recipient: string) {
  return recipient.split(" · ")[0];
}

function validRecipient(value: unknown) {
  if (typeof value !== "string" || value.length > 120) return false;
  if (value === "Front desk") return true;
  const [name, reference, extra] = value.split(" · ");
  return isDemoPatient(name) && extra === undefined && (reference === undefined || isDemoReference(reference));
}

function validBody(value: unknown) {
  return typeof value === "string" && value.length <= 500 && (fixedBodies.has(value) || timedBodies.some((pattern) => pattern.test(value)));
}

export function overlapping(state: Pick<DemoState, "appointments">) {
  const active = state.appointments.filter((item) => item.status !== "Cancelled");
  for (let i = 0; i < active.length; i += 1) {
    const a = active[i];
    const aStart = Date.parse(a.startAt);
    const aEnd = aStart + (serviceDurations[a.type] || 30) * 60_000;
    for (let j = i + 1; j < active.length; j += 1) {
      const b = active[j];
      if (a.provider !== b.provider) continue;
      const bStart = Date.parse(b.startAt);
      const bEnd = bStart + (serviceDurations[b.type] || 30) * 60_000;
      if (aStart < bEnd && bStart < aEnd) return true;
    }
  }
  return false;
}

/** Returns true only for a complete, allowlisted demo snapshot. */
export function validateDemoState(value: unknown): value is DemoState {
  if (!hasOnlyKeys(value, ["appointments", "tasks", "referrals", "messages", "waitlist", "events", "smsPreferences"])) return false;
  const state = value as Partial<DemoState>;
  const arrays = [state.appointments, state.tasks, state.referrals, state.messages, state.waitlist, state.events, state.smsPreferences];
  if (!arrays.every(Array.isArray)) return false;
  const s = state as DemoState;
  if (s.appointments.length > limits.appointments || s.tasks.length > limits.tasks || s.referrals.length > limits.referrals
    || s.messages.length > limits.messages || s.waitlist.length > limits.waitlist || s.events.length > limits.events
    || s.smsPreferences.length > allowedDemoPatients.length) return false;

  const ids = new Set<string>();
  const unique = (id: string) => { if (ids.has(id)) return false; ids.add(id); return true; };

  for (const item of s.appointments) {
    if (!hasOnlyKeys(item, ["id", "patient", "reference", "type", "provider", "location", "startAt", "timezone", "status", "documents"])) return false;
    if (typeof item.id !== "string" || !idPattern.test(item.id) || !unique(item.id) || !isDemoPatient(item.patient) || !isDemoReference(item.reference) || !isAppointmentType(item.type)) return false;
    if (!providers.some((provider) => provider.name === item.provider && provider.location === item.location)) return false;
    if (!isUtcTimestamp(item.startAt) || (item.timezone !== undefined && !isTimezone(item.timezone))) return false;
    if (!oneOf(item.status, appointmentStatuses) || !oneOf(item.documents, documentStatuses)) return false;
  }
  if (overlapping(s)) return false;

  for (const item of s.tasks) {
    if (!hasOnlyKeys(item, ["id", "title", "patient", "detail", "dueAt", "priority", "status", "appointmentReference"])) return false;
    if (typeof item.id !== "string" || !idPattern.test(item.id) || !unique(item.id) || !(isDemoPatient(item.patient) || item.patient === "Front desk")) return false;
    if (!taskTitles.has(item.title) || !taskDetails.has(item.detail) || !isUtcTimestamp(item.dueAt)) return false;
    if (!oneOf(item.priority, ["Normal", "Today", "Urgent"] as const) || !oneOf(item.status, taskStatuses)) return false;
    if (item.appointmentReference !== undefined && !isDemoReference(item.appointmentReference)) return false;
  }

  for (const item of s.referrals) {
    if (!hasOnlyKeys(item, ["id", "patient", "reference", "appointment", "document", "receivedAt", "status"])) return false;
    if (typeof item.id !== "string" || !idPattern.test(item.id) || !unique(item.id) || !isDemoPatient(item.patient) || !isDemoReference(item.reference)) return false;
    if (typeof item.document !== "string" || !/^(Referral letter|Intake form|Insurance card|Referral document) · sample(?:\.pdf| image| needed)?$/.test(item.document)) return false;
    if (!isAppointmentType(item.appointment) || (item.receivedAt !== undefined && !isUtcTimestamp(item.receivedAt))) return false;
    if (!oneOf(item.status, documentStatuses)) return false;
  }

  for (const item of s.messages) {
    if (!hasOnlyKeys(item, ["id", "recipient", "purpose", "body", "sentAt", "scheduledFor", "appointmentReference", "status"])) return false;
    if (typeof item.id !== "string" || !idPattern.test(item.id) || !unique(item.id) || !validRecipient(item.recipient) || !validBody(item.body)) return false;
    if (!isUtcTimestamp(item.sentAt) || (item.scheduledFor !== undefined && !isUtcTimestamp(item.scheduledFor))) return false;
    if (item.appointmentReference !== undefined && !isDemoReference(item.appointmentReference)) return false;
    if (!oneOf(item.purpose, messagePurposes) || !oneOf(item.status, messageStatuses)) return false;
  }

  for (const item of s.waitlist) {
    if (!hasOnlyKeys(item, ["id", "patient", "appointmentType", "preferredDate", "timezone", "createdAt", "status"])) return false;
    if (typeof item.id !== "string" || !idPattern.test(item.id) || !unique(item.id) || !isDemoPatient(item.patient) || !isAppointmentType(item.appointmentType)) return false;
    if (!isDateKey(item.preferredDate) || !isTimezone(item.timezone) || !isUtcTimestamp(item.createdAt) || !oneOf(item.status, waitlistStatuses)) return false;
  }

  for (const item of s.events) {
    if (!hasOnlyKeys(item, ["id", "at", "action", "channel", "patient", "reference"])) return false;
    if (typeof item.id !== "string" || !idPattern.test(item.id) || !unique(item.id) || !isUtcTimestamp(item.at)) return false;
    if (!oneOf(item.action, activityActions) || !oneOf(item.channel, channels)) return false;
    if (item.patient !== undefined && !(isDemoPatient(item.patient) || item.patient === "Front desk")) return false;
    if (item.reference !== undefined && !isDemoReference(item.reference)) return false;
  }

  const seen = new Set<string>();
  for (const item of s.smsPreferences) {
    if (!hasOnlyKeys(item, ["patient", "optedOut", "updatedAt"])) return false;
    if (!isDemoPatient(item.patient) || seen.has(item.patient) || typeof item.optedOut !== "boolean" || !isUtcTimestamp(item.updatedAt)) return false;
    seen.add(item.patient);
  }
  return true;
}
