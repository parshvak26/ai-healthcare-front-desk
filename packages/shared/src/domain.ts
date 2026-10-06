// Front-desk business rules. Every write to the demo — from the staff console, the Worker API, or a Retell
// tool call — goes through applyDemoAction, so all channels share one set of rules and confirmations.
import {
  allowedDemoPatients, defaultClinicTimezone, requestTemplates, requestTypes, systemTaskTemplates, typesNeedingDocuments,
} from "./catalog.ts";
import {
  DAY, DomainError, HOUR, MINUTE, appointmentTimezone, documentFollowUpTime, documentTaskDue, iso, messageText,
  outsideQuietHours, patientIsBusy, reminderTime, resolveSlot, stableId,
} from "./schedule.ts";
import { callerNames, likelySameSpelling, matchNames, maxCallerNames, namesMatch, normalizePersonName, patientNames, sameName } from "./names.ts";
import { createSeedState } from "./seed.ts";
import { formatLocalLong, isDateKey, isTimezone, localDateKey } from "./time.ts";
import {
  isAppointmentType, isDemoReference, limits, messageBodies, recipientPatient, taskStatuses, validateDemoState,
} from "./validation.ts";
import type {
  ActionContext, ActionOutcome, ActivityAction, Appointment, DemoAction, DemoState, FollowUpTask, MessageItem, MessageStatus,
  RequestType, TaskStatus, WaitlistItem,
} from "./types.ts";

export { DomainError } from "./schedule.ts";

const activeStatuses = new Set<string>(["Confirmed", "Needs confirmation"]);
const pendingMessage = (status: MessageStatus) => status === "Scheduled (demo)" || status === "Queued (demo)";
const patientOrder = (name: string) => { const index = (allowedDemoPatients as readonly string[]).indexOf(name); return index >= 0 ? index : allowedDemoPatients.length; };
const finishedAppointment = (item: Appointment) => item.status === "Cancelled" || item.status === "Completed" || item.status === "Missed";

// ---------- input checks ----------

/**
 * Resolves the patient name for a change. A name already in this demo is reused in its stored spelling (so
 * "parshva" and "Parshva" stay one person). New names may only come from a voice call: the console offers the
 * sample patients and the caller's own names, which keeps typed free text out of the store. A long name heard
 * slightly differently on a later turn ("Parsva" for "Parshva") is matched to the stored one.
 */
function requirePatient(state: DemoState, value: unknown, ctx: ActionContext) {
  const name = normalizePersonName(value);
  if (!name) throw new DomainError(400, "invalid_name", "Please use a name made of letters, such as Maya or Maya Patel.");
  const known = patientNames(state);
  const existing = known.find((item) => sameName(item, name));
  if (existing) return existing;
  if (ctx.channel !== "Voice assistant") throw new DomainError(400, "unknown_patient", "Choose a sample patient or a name from your own calls.");
  const close = known.filter((item) => likelySameSpelling(name, item));
  if (close.length === 1) return close[0];
  if (callerNames(state).length >= maxCallerNames) throw new DomainError(409, "too_many_names", "This demo already holds the most names it can. Use a name from an earlier booking, or reset the demo.");
  return name;
}

function requireType(value: unknown) {
  if (!isAppointmentType(value)) throw new DomainError(400, "invalid_appointment_type", "Choose one of the sample appointment types.");
  return value;
}

function requireTimezone(value: unknown) {
  if (!isTimezone(value)) throw new DomainError(400, "invalid_timezone", "Choose a valid timezone for the sample schedule.");
  return value;
}

function requireInstant(value: unknown) {
  const ms = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(ms)) throw new DomainError(400, "invalid_slot", "Choose a valid appointment time.");
  return ms;
}

const notFound = () => new DomainError(404, "sample_booking_not_found", "I could not match that sample booking. Please ask the front desk to follow up.");

/** The booking with this reference. When a name is given it must plausibly match (spelling-tolerant). */
export function findAppointment(state: DemoState, reference: unknown, patient?: unknown) {
  if (!isDemoReference(reference)) throw notFound();
  const appointment = state.appointments.find((item) => item.reference === reference);
  if (!appointment) throw notFound();
  if (patient !== undefined && (typeof patient !== "string" || !namesMatch(patient, appointment.patient))) throw notFound();
  return appointment;
}

/** Upcoming active bookings for the best-matching name tier (see matchNames), earliest first. */
export function findAppointmentsByName(state: DemoState, name: string, now: number) {
  const upcoming = state.appointments.filter((item) => activeStatuses.has(item.status) && Date.parse(item.startAt) > now);
  const match = matchNames(name, upcoming.map((item) => item.patient));
  return {
    tier: match.tier,
    appointments: upcoming.filter((item) => match.names.includes(item.patient)).sort((a, b) => a.startAt.localeCompare(b.startAt)),
  };
}

// ---------- small state helpers ----------

export function isOptedOut(state: Pick<DemoState, "smsPreferences">, patient: string) {
  return state.smsPreferences.some((item) => item.patient === patient && item.optedOut);
}

/** Drops the oldest finished records until the list fits. Open or pending records are never removed. */
function trim<T>(list: T[], max: number, removable: (item: T) => boolean) {
  if (list.length <= max) return list;
  const result = [...list];
  let excess = result.length - max;
  // Lists are newest-first, so walk from the end to drop the oldest finished records first.
  for (let i = result.length - 1; i >= 0 && excess > 0; i -= 1) {
    if (removable(result[i])) { result.splice(i, 1); excess -= 1; }
  }
  return result;
}

const demoFull = () => new DomainError(409, "demo_full", "This demo is full. Reset your demo in Settings and try again.");

function prune(state: DemoState): DemoState {
  const next: DemoState = {
    ...state,
    tasks: trim(state.tasks, limits.tasks, (item) => item.status === "Done"),
    referrals: trim(state.referrals, limits.referrals, (item) => item.status === "Received"),
    messages: trim(state.messages, limits.messages, (item) => !pendingMessage(item.status)),
    waitlist: trim(state.waitlist, limits.waitlist, (item) => item.status === "Cancelled" || item.status === "Booked"),
    events: state.events.slice(0, limits.events),
  };
  // Refuse the change rather than silently deleting someone's open work.
  if (next.tasks.length > limits.tasks || next.referrals.length > limits.referrals || next.messages.length > limits.messages || next.waitlist.length > limits.waitlist) throw demoFull();
  return next;
}

function addEvent(state: DemoState, ctx: ActionContext, action: ActivityAction, details: { patient?: string; reference?: string; taskId?: string } = {}, part: string = action): DemoState {
  const id = stableId("evt", ctx.key, part);
  if (state.events.some((item) => item.id === id)) return state;
  return { ...state, events: [{ id, at: iso(ctx.now), action, channel: ctx.channel, ...details }, ...state.events] };
}

interface MessageDraft {
  part: string;
  patient: string;
  reference?: string;
  purpose: string;
  body: string;
  timezone: string;
  /** Omit for an immediate message; quiet hours still apply. */
  scheduledFor?: number;
  status?: MessageStatus;
}

function addMessage(state: DemoState, ctx: ActionContext, draft: MessageDraft): DemoState {
  const id = stableId("msg", ctx.key, draft.part);
  if (state.messages.some((item) => item.id === id)) return state;
  // Records with an explicit status (opt-out/opt-in acknowledgements) are immediate; texts respect quiet hours.
  const due = draft.status ? ctx.now : outsideQuietHours(draft.scheduledFor ?? ctx.now, draft.timezone);
  const status: MessageStatus = draft.status
    ?? (isOptedOut(state, draft.patient) ? "Suppressed (opt-out)" : draft.scheduledFor !== undefined ? "Scheduled (demo)" : "Queued (demo)");
  const message: MessageItem = {
    id,
    recipient: draft.reference ? `${draft.patient} · ${draft.reference}` : draft.patient,
    purpose: draft.purpose,
    body: draft.body,
    sentAt: iso(ctx.now),
    ...(due > ctx.now ? { scheduledFor: iso(due) } : {}),
    ...(draft.reference ? { appointmentReference: draft.reference } : {}),
    status,
  };
  return { ...state, messages: [message, ...state.messages] };
}

function addTask(state: DemoState, ctx: ActionContext, part: string, task: Omit<FollowUpTask, "id">) {
  const id = stableId("task", ctx.key, part);
  const existing = state.tasks.find((item) => item.id === id);
  if (existing) return { state, task: existing, created: false };
  const created: FollowUpTask = { id, ...task };
  return { state: { ...state, tasks: [created, ...state.tasks] }, task: created, created: true };
}

function freshReference(state: DemoState, random: () => number) {
  const used = new Set(state.appointments.map((item) => item.reference));
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const candidate = `DEMO-${1000 + Math.floor(random() * 9000)}`;
    if (!used.has(candidate)) return candidate;
  }
  for (let number = 1000; number <= 9999; number += 1) if (!used.has(`DEMO-${number}`)) return `DEMO-${number}`;
  throw new DomainError(409, "schedule_full", "The sample schedule is full. Reset the demo data and try again.");
}

function releaseOpeningToWaitlist(state: DemoState, appointment: Appointment, ctx: ActionContext): DemoState {
  if (Date.parse(appointment.startAt) <= ctx.now) return state;
  const opening = state.waitlist.find((item) => item.status === "Waiting"
    && item.appointmentType === appointment.type
    && item.preferredDate === localDateKey(Date.parse(appointment.startAt), item.timezone));
  if (!opening) return state;
  const template = systemTaskTemplates.waitlistOpening;
  let next: DemoState = { ...state, waitlist: state.waitlist.map((item) => item.id === opening.id ? { ...item, status: "Opening found" as const } : item) };
  next = addTask(next, ctx, "waitlist-opening", { title: template.title, patient: opening.patient, detail: template.detail, dueAt: iso(ctx.now + HOUR), priority: template.priority, status: "Open" }).state;
  return addEvent(next, ctx, "Waitlist opening found", { patient: opening.patient });
}

// ---------- actions ----------

function bookAppointment(state: DemoState, action: Extract<DemoAction, { type: "book_appointment" }>, ctx: ActionContext): ActionOutcome {
  const patient = requirePatient(state, action.patient, ctx);
  const type = requireType(action.appointmentType);
  const timezone = requireTimezone(action.timezone);
  const requested = requireInstant(action.startAt);
  // A key identifies one booking request. A replay of the same request returns that booking. If the earlier
  // booking was since cancelled or moved, the same words mean a new request, so it gets a derived key.
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const key = attempt === 0 ? ctx.key : `${ctx.key}|rebook-${attempt}`;
    const existing = state.appointments.find((item) => item.id === stableId("apt", key, "appointment"));
    if (!existing) return createBooking(state, { patient, type, timezone, requested, provider: action.provider }, { ...ctx, key });
    const sameBooking = activeStatuses.has(existing.status) && sameName(existing.patient, patient) && existing.type === type
      && Math.abs(Date.parse(existing.startAt) - requested) < MINUTE && (action.provider === undefined || existing.provider === action.provider);
    if (sameBooking) return { state, changed: false, appointment: existing, message: "Sample appointment confirmed. No text was sent." };
  }
  throw new DomainError(409, "request_reused", "Please start a new booking request.");
}

function createBooking(state: DemoState, input: { patient: string; type: string; timezone: string; requested: number; provider?: string }, ctx: ActionContext): ActionOutcome {
  const { patient, type, timezone } = input;
  const id = stableId("apt", ctx.key, "appointment");
  const slot = resolveSlot(state, { startMs: input.requested, appointmentType: type, timezone, now: ctx.now, provider: input.provider });
  if (!slot) throw new DomainError(409, "slot_unavailable", "That time is no longer available. Offer another sample time.");
  if (patientIsBusy(state, patient, Date.parse(slot.startAt), type)) throw new DomainError(409, "patient_busy", "That sample patient already has an appointment at that time. Offer another time.");

  const appointments = trim(state.appointments, limits.appointments - 1, (item) => finishedAppointment(item) || Date.parse(item.startAt) < ctx.now - DAY);
  if (appointments.length >= limits.appointments) throw new DomainError(409, "schedule_full", "This demo's schedule is full. Reset your demo in Settings and try again.");
  const reference = freshReference(state, ctx.random);
  const needsDocuments = typesNeedingDocuments.has(type);
  const appointment: Appointment = {
    id, patient, reference, type, provider: slot.provider, location: slot.location, startAt: slot.startAt, timezone,
    status: "Confirmed", documents: needsDocuments ? "Needed" : "Received",
  };
  let next: DemoState = { ...state, appointments: [appointment, ...appointments] };
  next = addMessage(next, ctx, { part: "confirmation", patient, reference, purpose: "Booking confirmation", body: messageText.bookingConfirmation(slot.startAt, timezone), timezone });
  const reminder = reminderTime(slot.startAt, timezone, ctx.now);
  if (reminder) next = addMessage(next, ctx, { part: "reminder", patient, reference, purpose: "24-hour appointment reminder", body: messageText.reminder(slot.startAt, timezone), timezone, scheduledFor: reminder });
  if (needsDocuments) {
    next = { ...next, referrals: [{ id: stableId("doc", ctx.key, "referral"), patient, reference, appointment: type, document: "Referral document · sample needed", status: "Needed" }, ...next.referrals] };
    const template = systemTaskTemplates.missingDocument;
    next = addTask(next, ctx, "missing-document", { title: template.title, patient, detail: template.detail, dueAt: iso(documentTaskDue(slot.startAt, ctx.now)), priority: template.priority, status: "Open", appointmentReference: reference }).state;
    const followUp = documentFollowUpTime(slot.startAt, timezone, ctx.now);
    if (followUp) next = addMessage(next, ctx, { part: "document-follow-up", patient, reference, purpose: "48-hour missing-document follow-up", body: messageBodies.documentFollowUp, timezone, scheduledFor: followUp });
  }
  // A booking for someone already waiting for this visit type closes their waitlist request.
  next = { ...next, waitlist: next.waitlist.map((item) => item.patient === patient && item.appointmentType === type && (item.status === "Waiting" || item.status === "Opening found") ? { ...item, status: "Booked" as const } : item) };
  next = addEvent(next, ctx, "Appointment booked", { patient, reference });
  return { state: prune(next), changed: true, appointment, message: "Sample appointment confirmed. No text was sent." };
}

function rescheduleAppointment(state: DemoState, action: Extract<DemoAction, { type: "reschedule_appointment" }>, ctx: ActionContext): ActionOutcome {
  const appointment = findAppointment(state, action.reference, action.patient);
  const timezone = requireTimezone(action.timezone);
  const requested = requireInstant(action.newStartAt);
  if (finishedAppointment(appointment)) throw new DomainError(409, "appointment_closed", "That sample booking can no longer be changed. Offer a new booking or a staff follow-up.");
  if (Math.abs(Date.parse(appointment.startAt) - requested) < MINUTE) {
    return { state, changed: false, appointment, message: "The sample appointment is already at that time. No text was sent." };
  }
  const slot = resolveSlot(state, { startMs: requested, appointmentType: appointment.type, timezone, now: ctx.now, provider: action.provider, ignoreAppointmentId: appointment.id });
  if (!slot) throw new DomainError(409, "slot_unavailable", "That time is no longer available. Offer another sample time.");
  if (patientIsBusy(state, appointment.patient, Date.parse(slot.startAt), appointment.type, appointment.id)) throw new DomainError(409, "patient_busy", "That sample patient already has another appointment at that time. Offer another time.");
  const updated: Appointment = { ...appointment, startAt: slot.startAt, timezone, provider: slot.provider, location: slot.location };
  const reminder = reminderTime(slot.startAt, timezone, ctx.now);
  let hasReminder = false;
  const messages = state.messages.map((message) => {
    if (message.appointmentReference !== appointment.reference || message.status !== "Scheduled (demo)") return message;
    if (message.purpose === "24-hour appointment reminder") {
      if (!reminder) return { ...message, status: "Cancelled (demo)" as const };
      hasReminder = true;
      return { ...message, body: messageText.reminder(slot.startAt, timezone), scheduledFor: iso(reminder) };
    }
    if (message.purpose === "48-hour missing-document follow-up" && message.scheduledFor && Date.parse(message.scheduledFor) >= Date.parse(slot.startAt) - HOUR) {
      return { ...message, status: "Cancelled (demo)" as const };
    }
    return message;
  });
  let next: DemoState = { ...state, appointments: state.appointments.map((item) => item.id === appointment.id ? updated : item), messages };
  if (reminder && !hasReminder) next = addMessage(next, ctx, { part: "reminder", patient: appointment.patient, reference: appointment.reference, purpose: "24-hour appointment reminder", body: messageText.reminder(slot.startAt, timezone), timezone, scheduledFor: reminder });
  next = addMessage(next, ctx, { part: "rescheduled", patient: appointment.patient, reference: appointment.reference, purpose: "Reschedule confirmation", body: messageBodies.rescheduled, timezone });
  next = releaseOpeningToWaitlist(next, appointment, ctx);
  next = addEvent(next, ctx, "Appointment rescheduled", { patient: appointment.patient, reference: appointment.reference });
  return { state: prune(next), changed: true, appointment: updated, message: "The sample appointment was rescheduled. No text was sent." };
}

function cancelAppointment(state: DemoState, action: Extract<DemoAction, { type: "cancel_appointment" }>, ctx: ActionContext): ActionOutcome {
  const appointment = findAppointment(state, action.reference, action.patient);
  if (appointment.status === "Cancelled") return { state, changed: false, appointment, message: "The sample appointment is cancelled. No text was sent." };
  if (finishedAppointment(appointment) || Date.parse(appointment.startAt) <= ctx.now) throw new DomainError(409, "appointment_closed", "That sample visit time has already passed, so it cannot be cancelled. Offer a new booking or a staff follow-up.");
  const timezone = appointmentTimezone(appointment);
  const updated: Appointment = { ...appointment, status: "Cancelled" };
  let next: DemoState = {
    ...state,
    appointments: state.appointments.map((item) => item.id === appointment.id ? updated : item),
    messages: state.messages.map((message) => message.appointmentReference === appointment.reference && pendingMessage(message.status) ? { ...message, status: "Cancelled (demo)" as const } : message),
    tasks: state.tasks.map((task) => task.appointmentReference === appointment.reference && task.title === systemTaskTemplates.missingDocument.title && task.status !== "Done" ? { ...task, status: "Done" as const } : task),
  };
  next = addMessage(next, ctx, { part: "cancelled", patient: appointment.patient, reference: appointment.reference, purpose: "Cancellation confirmation", body: messageBodies.cancelled, timezone });
  next = releaseOpeningToWaitlist(next, appointment, ctx);
  next = addEvent(next, ctx, "Appointment cancelled", { patient: appointment.patient, reference: appointment.reference });
  return { state: prune(next), changed: true, appointment: updated, message: "The sample appointment was cancelled. No text was sent." };
}

function confirmAppointment(state: DemoState, action: Extract<DemoAction, { type: "confirm_appointment" }>, ctx: ActionContext): ActionOutcome {
  const appointment = findAppointment(state, action.reference, action.patient);
  if (appointment.status === "Confirmed") return { state, changed: false, appointment, message: "The sample appointment is already confirmed." };
  if (appointment.status !== "Needs confirmation") throw new DomainError(409, "appointment_closed", "That sample booking cannot be confirmed. Offer a new booking or a staff follow-up.");
  if (Date.parse(appointment.startAt) <= ctx.now) throw new DomainError(409, "appointment_closed", "That sample visit time has already passed.");
  const updated: Appointment = { ...appointment, status: "Confirmed" };
  let next: DemoState = { ...state, appointments: state.appointments.map((item) => item.id === appointment.id ? updated : item) };
  next = addEvent(next, ctx, "Appointment confirmed", { patient: appointment.patient, reference: appointment.reference });
  return { state: prune(next), changed: true, appointment: updated, message: "The sample appointment is confirmed. No text was sent." };
}

function recordAttendance(state: DemoState, action: Extract<DemoAction, { type: "record_attendance" }>, ctx: ActionContext): ActionOutcome {
  const appointment = findAppointment(state, action.reference);
  const target = action.outcome === "missed" ? "Missed" : "Completed";
  if (appointment.status === target) return { state, changed: false, appointment, message: "The visit outcome is already recorded." };
  if (appointment.status !== "Confirmed" && appointment.status !== "Needs confirmation") throw new DomainError(409, "appointment_closed", "That sample booking does not need a visit outcome.");
  if (Date.parse(appointment.startAt) > ctx.now) throw new DomainError(409, "visit_not_started", "Record attendance after the visit start time.");
  const updated: Appointment = { ...appointment, status: target };
  let next: DemoState = {
    ...state,
    appointments: state.appointments.map((item) => item.id === appointment.id ? updated : item),
    messages: state.messages.map((message) => message.appointmentReference === appointment.reference && pendingMessage(message.status) ? { ...message, status: "Cancelled (demo)" as const } : message),
  };
  if (target === "Missed") {
    const template = systemTaskTemplates.missedVisit;
    next = addTask(next, ctx, "missed-visit", { title: template.title, patient: appointment.patient, detail: template.detail, dueAt: iso(ctx.now + 2 * HOUR), priority: template.priority, status: "Open", appointmentReference: appointment.reference }).state;
  }
  next = addEvent(next, ctx, target === "Missed" ? "Visit marked missed" : "Visit marked attended", { patient: appointment.patient, reference: appointment.reference });
  return { state: prune(next), changed: true, appointment: updated, message: target === "Missed" ? "Marked as missed. A staff follow-up was added." : "Marked as attended." };
}

function joinWaitlist(state: DemoState, action: Extract<DemoAction, { type: "join_waitlist" }>, ctx: ActionContext): ActionOutcome {
  const patient = requirePatient(state, action.patient, ctx);
  const appointmentType = requireType(action.appointmentType);
  const timezone = requireTimezone(action.timezone);
  if (!isDateKey(action.preferredDate)) throw new DomainError(400, "invalid_date", "Use a valid date like 2026-10-15.");
  if (action.preferredDate < localDateKey(ctx.now, timezone)) throw new DomainError(400, "invalid_date", "Choose today or a later date for the waitlist.");
  const id = stableId("wait", ctx.key, "request");
  const existing = state.waitlist.find((item) => item.id === id || (sameName(item.patient, patient) && item.appointmentType === appointmentType
    && item.preferredDate === action.preferredDate && item.timezone === timezone && (item.status === "Waiting" || item.status === "Opening found")));
  if (existing) return { state, changed: false, waitlistItem: existing, message: "That sample request is already on the waitlist. No text was sent." };
  const waitlistItem: WaitlistItem = { id, patient, appointmentType, preferredDate: action.preferredDate, timezone, createdAt: iso(ctx.now), status: "Waiting" };
  let next: DemoState = { ...state, waitlist: [waitlistItem, ...state.waitlist] };
  next = addEvent(next, ctx, "Waitlist request added", { patient });
  return { state: prune(next), changed: true, waitlistItem, message: "The sample waitlist request was recorded. No text was sent." };
}

function cancelWaitlist(state: DemoState, action: Extract<DemoAction, { type: "cancel_waitlist" }>, ctx: ActionContext): ActionOutcome {
  const item = state.waitlist.find((entry) => entry.id === action.waitlistId);
  if (!item) throw new DomainError(404, "not_found", "That sample waitlist request was not found.");
  if (item.status === "Cancelled") return { state, changed: false, waitlistItem: item, message: "The sample waitlist request is cancelled." };
  if (item.status === "Booked") throw new DomainError(409, "waitlist_closed", "That sample request was already booked.");
  const updated: WaitlistItem = { ...item, status: "Cancelled" };
  let next: DemoState = { ...state, waitlist: state.waitlist.map((entry) => entry.id === item.id ? updated : entry) };
  next = addEvent(next, ctx, "Waitlist request cancelled", { patient: item.patient });
  return { state: prune(next), changed: true, waitlistItem: updated, message: "Sample waitlist request cancelled." };
}

function markDocumentReceived(state: DemoState, action: Extract<DemoAction, { type: "mark_document_received" }>, ctx: ActionContext): ActionOutcome {
  const referral = state.referrals.find((item) => item.id === action.documentId);
  if (!referral) throw new DomainError(404, "not_found", "That sample document was not found.");
  if (referral.status === "Received") return { state, changed: false, message: "The sample document is already received." };
  const referrals = state.referrals.map((item) => item.id === referral.id ? { ...item, status: "Received" as const, receivedAt: iso(ctx.now) } : item);
  const allReceived = referrals.filter((item) => item.reference === referral.reference).every((item) => item.status === "Received");
  let next: DemoState = {
    ...state,
    referrals,
    appointments: state.appointments.map((item) => item.reference === referral.reference && allReceived ? { ...item, documents: "Received" as const } : item),
    tasks: state.tasks.map((task) => {
      if (task.status === "Done") return task;
      const linked = task.appointmentReference === referral.reference && task.title === systemTaskTemplates.missingDocument.title;
      const legacy = task.appointmentReference === undefined && task.patient === referral.patient && task.title.toLowerCase().includes("document");
      return linked || legacy ? { ...task, status: "Done" as const } : task;
    }),
    messages: allReceived ? state.messages.map((message) => message.appointmentReference === referral.reference && message.purpose === "48-hour missing-document follow-up" && pendingMessage(message.status) ? { ...message, status: "Cancelled (demo)" as const } : message) : state.messages,
  };
  next = addEvent(next, ctx, "Document received", { patient: referral.patient, reference: referral.reference });
  return { state: prune(next), changed: true, message: "Sample document marked as received." };
}

function createTask(state: DemoState, action: Extract<DemoAction, { type: "create_task" }>, ctx: ActionContext): ActionOutcome {
  const template = requestTemplates[action.requestType];
  if (!template) throw new DomainError(400, "invalid_request_type", "Choose a supported front-desk request.");
  const patient = action.patient === undefined ? "Front desk" : requirePatient(state, action.patient, ctx);
  const { state: withTask, task, created } = addTask(state, ctx, `request-${action.requestType}`, {
    title: template.title, patient, detail: template.detail, dueAt: iso(ctx.now + 2 * HOUR), priority: template.priority, status: "Open",
  });
  if (!created) return { state, changed: false, task, message: "The sample follow-up is already in the staff queue. No personal details were stored." };
  const next = addEvent(withTask, ctx, "Staff task created", { patient, taskId: task.id });
  return { state: prune(next), changed: true, task, message: "A sample follow-up was added for the front desk. No personal details were stored." };
}

function updateTask(state: DemoState, action: Extract<DemoAction, { type: "update_task" }>, ctx: ActionContext): ActionOutcome {
  const task = state.tasks.find((item) => item.id === action.taskId);
  if (!task) throw new DomainError(404, "not_found", "That staff task was not found.");
  if (task.status === action.status) return { state, changed: false, task, message: "Follow-up unchanged." };
  const updated: FollowUpTask = { ...task, status: action.status };
  let next: DemoState = { ...state, tasks: state.tasks.map((item) => item.id === task.id ? updated : item) };
  next = addEvent(next, ctx, "Staff task updated", { patient: task.patient, ...(task.appointmentReference ? { reference: task.appointmentReference } : {}) });
  return { state: prune(next), changed: true, task: updated, message: action.status === "Done" ? "Follow-up completed." : "Follow-up updated." };
}

function setSmsPreference(state: DemoState, action: Extract<DemoAction, { type: "set_sms_preference" }>, ctx: ActionContext): ActionOutcome {
  const patient = requirePatient(state, action.patient, ctx);
  if (isOptedOut(state, patient) === action.optedOut) return { state, changed: false, message: action.optedOut ? "Text reminders are already off." : "Text reminders are already on." };
  const preference = { patient, optedOut: action.optedOut, updatedAt: iso(ctx.now) };
  let next: DemoState = {
    ...state,
    smsPreferences: [...state.smsPreferences.filter((item) => item.patient !== patient), preference]
      .sort((a, b) => patientOrder(a.patient) - patientOrder(b.patient) || a.patient.localeCompare(b.patient)),
  };
  if (action.optedOut) {
    next = { ...next, messages: next.messages.map((message) => recipientPatient(message.recipient) === patient && pendingMessage(message.status) ? { ...message, status: "Suppressed (opt-out)" as const } : message) };
    next = addMessage(next, ctx, { part: "opt-out", patient, purpose: "Opt-out", body: messageBodies.optOut, timezone: defaultClinicTimezone, status: "Opt-out" });
  } else {
    next = addMessage(next, ctx, { part: "opt-in", patient, purpose: "Opt-in", body: messageBodies.optIn, timezone: defaultClinicTimezone, status: "Delivered (demo)" });
  }
  next = addEvent(next, ctx, action.optedOut ? "Text reminders turned off" : "Text reminders turned on", { patient });
  return { state: prune(next), changed: true, message: action.optedOut ? "Simulated STOP recorded. Pending texts are suppressed." : "Simulated START recorded. Future texts are allowed." };
}

/** Applies one front-desk action. Throws DomainError for anything the rules do not allow. */
export function applyDemoAction(state: DemoState, action: DemoAction, ctx: ActionContext): ActionOutcome {
  let outcome: ActionOutcome;
  switch (action.type) {
    case "book_appointment": outcome = bookAppointment(state, action, ctx); break;
    case "reschedule_appointment": outcome = rescheduleAppointment(state, action, ctx); break;
    case "cancel_appointment": outcome = cancelAppointment(state, action, ctx); break;
    case "confirm_appointment": outcome = confirmAppointment(state, action, ctx); break;
    case "record_attendance": outcome = recordAttendance(state, action, ctx); break;
    case "join_waitlist": outcome = joinWaitlist(state, action, ctx); break;
    case "cancel_waitlist": outcome = cancelWaitlist(state, action, ctx); break;
    case "mark_document_received": outcome = markDocumentReceived(state, action, ctx); break;
    case "create_task": outcome = createTask(state, action, ctx); break;
    case "update_task": outcome = updateTask(state, action, ctx); break;
    case "set_sms_preference": outcome = setSmsPreference(state, action, ctx); break;
    case "reset_demo": {
      const seeded = createSeedState(ctx.now, ctx.seedTimezone && isTimezone(ctx.seedTimezone) ? ctx.seedTimezone : undefined);
      outcome = { state: addEvent(seeded, ctx, "Sample data reset", {}, "reset"), changed: true, message: "Sample data restored." };
      break;
    }
    default: throw new DomainError(400, "unknown_action", "That front-desk action is not available in this demo.");
  }
  // Defence in depth: never hand back a snapshot that the store would reject.
  if (outcome.changed && !validateDemoState(outcome.state)) throw new DomainError(422, "demo_data_only", "Use the built-in fictional sample data only.");
  return outcome;
}

// ---------- the simulated reminder job ----------

/** Marks due simulated texts as delivered, suppressed, or cancelled. Returns changed=false when nothing was due. */
export function processDueMessages(state: DemoState, now: number) {
  let changed = false;
  const messages = state.messages.map((message) => {
    if (!pendingMessage(message.status)) return message;
    if (Date.parse(message.scheduledFor ?? message.sentAt) > now) return message;
    changed = true;
    if (isOptedOut(state, recipientPatient(message.recipient))) return { ...message, status: "Suppressed (opt-out)" as const };
    const appointment = message.appointmentReference ? state.appointments.find((item) => item.reference === message.appointmentReference) : undefined;
    if (appointment && (appointment.status === "Cancelled" || appointment.status === "Missed") && message.purpose !== "Cancellation confirmation") return { ...message, status: "Cancelled (demo)" as const };
    if (message.purpose === "48-hour missing-document follow-up" && appointment
      && !state.referrals.some((item) => item.reference === appointment.reference && item.status === "Needed")) return { ...message, status: "Cancelled (demo)" as const };
    if (message.purpose === "24-hour appointment reminder" && appointment && Date.parse(appointment.startAt) <= now) return { ...message, status: "Cancelled (demo)" as const };
    return { ...message, status: "Delivered (demo)" as const };
  });
  return { state: changed ? { ...state, messages } : state, changed };
}

// ---------- reading and migrating stored data ----------

/** Upgrades snapshots written by earlier versions and repairs duplicate IDs. Returns null if the data is unusable. */
export function normalizeDemoState(raw: unknown): { state: DemoState; migrated: boolean } | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const stored = raw as Partial<DemoState>;
  if (![stored.appointments, stored.tasks, stored.referrals, stored.messages].every(Array.isArray)) return null;
  let migrated = false;
  const messages = stored.messages as MessageItem[];
  const smsPreferences = Array.isArray(stored.smsPreferences) ? stored.smsPreferences : allowedDemoPatients.map((patient) => {
    const optOut = messages.find((message) => message.purpose === "Opt-out" && recipientPatient(message.recipient) === patient);
    return { patient, optedOut: Boolean(optOut), updatedAt: optOut?.sentAt ?? new Date(0).toISOString() };
  });
  const state: DemoState = {
    appointments: stored.appointments as Appointment[],
    tasks: stored.tasks as FollowUpTask[],
    referrals: stored.referrals as DemoState["referrals"],
    messages,
    waitlist: Array.isArray(stored.waitlist) ? stored.waitlist : [],
    events: Array.isArray(stored.events) ? stored.events : [],
    smsPreferences,
  };
  if (!Array.isArray(stored.waitlist) || !Array.isArray(stored.events) || !Array.isArray(stored.smsPreferences)) migrated = true;
  const seen = new Set<string>();
  const dedupe = <T extends { id: string }>(items: T[]) => items.map((item) => {
    if (typeof item?.id !== "string" || !seen.has(item.id)) { if (typeof item?.id === "string") seen.add(item.id); return item; }
    let suffix = 2;
    while (seen.has(`${item.id}-${suffix}`)) suffix += 1;
    migrated = true;
    seen.add(`${item.id}-${suffix}`);
    return { ...item, id: `${item.id}-${suffix}` };
  });
  const deduped: DemoState = {
    ...state,
    appointments: dedupe(state.appointments), tasks: dedupe(state.tasks), referrals: dedupe(state.referrals),
    messages: dedupe(state.messages), waitlist: dedupe(state.waitlist), events: dedupe(state.events),
  };
  // Older versions allowed longer lists. Drop the oldest finished records (never open work) to fit today's limits.
  const repaired: DemoState = {
    ...deduped,
    appointments: trim(deduped.appointments, limits.appointments, (item) => finishedAppointment(item)),
    tasks: trim(deduped.tasks, limits.tasks, (item) => item.status === "Done"),
    referrals: trim(deduped.referrals, limits.referrals, (item) => item.status === "Received"),
    messages: trim(deduped.messages, limits.messages, (item) => !pendingMessage(item.status)),
    waitlist: trim(deduped.waitlist, limits.waitlist, (item) => item.status === "Cancelled" || item.status === "Booked"),
    events: deduped.events.slice(0, limits.events),
  };
  const trimmed = (Object.keys(deduped) as (keyof DemoState)[]).some((key) => deduped[key].length !== repaired[key].length);
  if (trimmed) migrated = true;
  return validateDemoState(repaired) ? { state: repaired, migrated } : null;
}

// ---------- request parsing ----------

const actionShapes: Record<DemoAction["type"], Record<string, "string" | "boolean" | "string?">> = {
  book_appointment: { patient: "string", appointmentType: "string", startAt: "string", timezone: "string", provider: "string?" },
  reschedule_appointment: { reference: "string", patient: "string", newStartAt: "string", timezone: "string", provider: "string?" },
  cancel_appointment: { reference: "string", patient: "string" },
  confirm_appointment: { reference: "string", patient: "string" },
  record_attendance: { reference: "string", outcome: "string" },
  join_waitlist: { patient: "string", appointmentType: "string", preferredDate: "string", timezone: "string" },
  cancel_waitlist: { waitlistId: "string" },
  mark_document_received: { documentId: "string" },
  create_task: { requestType: "string", patient: "string?" },
  update_task: { taskId: "string", status: "string" },
  set_sms_preference: { patient: "string", optedOut: "boolean" },
  reset_demo: {},
};

/** Validates the structure of an untrusted action. Business rules are enforced by applyDemoAction. */
export function parseDemoAction(input: unknown): DemoAction {
  const invalid = () => new DomainError(400, "invalid_action", "That front-desk request is not valid for this demo.");
  if (!input || typeof input !== "object" || Array.isArray(input)) throw invalid();
  const record = input as Record<string, unknown>;
  const type = record.type;
  if (typeof type !== "string" || !Object.hasOwn(actionShapes, type)) throw invalid();
  const shape = actionShapes[type as DemoAction["type"]];
  for (const key of Object.keys(record)) if (key !== "type" && !Object.hasOwn(shape, key)) throw invalid();
  for (const [key, kind] of Object.entries(shape)) {
    const value = record[key];
    if (kind === "string?" && value === undefined) continue;
    if (kind === "boolean" ? typeof value !== "boolean" : typeof value !== "string" || value.length < 1 || value.length > 100) throw invalid();
  }
  if (type === "record_attendance" && record.outcome !== "attended" && record.outcome !== "missed") throw invalid();
  if (type === "update_task" && !(taskStatuses as readonly string[]).includes(record.status as string)) throw invalid();
  if (type === "create_task" && !(requestTypes as string[]).includes(record.requestType as string)) throw new DomainError(400, "invalid_request_type", "Choose a supported front-desk request.");
  return record as unknown as DemoAction;
}

export function isRequestType(value: unknown): value is RequestType {
  return typeof value === "string" && (requestTypes as string[]).includes(value);
}

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === "string" && (taskStatuses as readonly string[]).includes(value);
}

export function appointmentSummary(appointment: Appointment) {
  const timezone = appointmentTimezone(appointment);
  return {
    reference: appointment.reference,
    patient: appointment.patient,
    appointment_type: appointment.type,
    status: appointment.status,
    start_at: appointment.startAt,
    local_time: formatLocalLong(appointment.startAt, timezone),
    timezone,
    provider: appointment.provider,
    location: appointment.location,
    documents: appointment.documents,
  };
}
