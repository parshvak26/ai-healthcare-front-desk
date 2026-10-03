import { createSeedState, faqEntries, allowedDemoPatients } from "../../web/src/lib/demoData.ts";
import type { Appointment, DemoState, FollowUpTask } from "../../../packages/shared/src/types.ts";

interface Env {
  SUPABASE_URL?: string;
  SUPABASE_SECRET_KEY?: string;
  CLINIC_ID?: string;
  PUBLIC_ORIGINS?: string;
  RETELL_API_KEY?: string;
  RETELL_TEST_NUMBERS?: string;
  SMS_MODE?: string;
}

interface StateSnapshot {
  state: DemoState;
  revision: number;
}

interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

interface ScheduledControllerLike {
  cron: string;
}

type ToolCall = { call_id?: string; from_number?: string };
type JsonRecord = Record<string, unknown>;

const defaultClinicId = "harbor-health-demo";
const encoder = new TextEncoder();
const allowedNames = new Set<string>(allowedDemoPatients);
const serviceDurations: Record<string, number> = {
  "New patient visit": 60,
  "Follow-up visit": 30,
  Consultation: 45,
  "Administrative call": 15,
};
const providers = [
  { name: "Dr. Avery Chen", location: "Main clinic" },
  { name: "Dr. Noah Rivera", location: "North clinic" },
];
const safeTaskDetails = new Set([
  "Asked for help confirming the appointment location.",
  "Follow up on the referral form before the visit.",
  "Asked the front desk to explain the demo billing FAQ.",
  "Request received; staff follow-up required.",
  "Caller asked to speak with a member of the front desk.",
  "Request passed to staff. The demo does not approve or advise about medication.",
  "Request captured for the records team. No records are accessed or released in the demo.",
  "Question routed to the billing team. The demo does not confirm coverage or charges.",
  "Caller needs help with the sample referral checklist.",
  "An unlisted FAQ needs staff review. The question text is not stored.",
  "A published demo FAQ was flagged for staff review. No caller text was stored.",
  "Check whether the sample referral has arrived; the 48-hour text remains simulated.",
]);
const safeTaskTitles = new Set([
  "Call back requested", "Referral document missing", "Billing question", "Records request",
  "Medical records request", "FAQ question", "FAQ needs review", "Prescription request", "Referral document follow-up",
]);

function hasOnlyKeys(value: unknown, allowed: readonly string[]) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).every((key) => allowed.includes(key)));
}

function validTimestamp(value: unknown) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) && Number.isFinite(Date.parse(value));
}

function validDemoId(value: unknown) {
  return typeof value === "string" && /^[A-Za-z0-9-]{1,100}$/.test(value);
}

function clinicId(env: Env) {
  return env.CLINIC_ID || defaultClinicId;
}

function originAllowed(request: Request, env: Env) {
  const origin = request.headers.get("Origin");
  if (!origin) return true;
  const configured = (env.PUBLIC_ORIGINS || "http://localhost:5173")
    .split(",").map((item) => item.trim()).filter(Boolean);
  return configured.includes(origin);
}

function headersFor(request: Request, env: Env, requestId: string) {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Request-Id": requestId,
    "Vary": "Origin",
  });
  const origin = request.headers.get("Origin");
  if (origin && originAllowed(request, env)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Content-Type, X-Request-Id");
    headers.set("Access-Control-Max-Age", "600");
  }
  return headers;
}

function reply(request: Request, env: Env, requestId: string, status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: headersFor(request, env, requestId) });
}

function problem(code: string, message: string) {
  return { error: { code, message } };
}

function configured(env: Env): env is Env & { SUPABASE_URL: string; SUPABASE_SECRET_KEY: string } {
  return Boolean(env.SUPABASE_URL && env.SUPABASE_SECRET_KEY);
}

class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

async function supabaseRequest(env: Env, endpoint: string, init: RequestInit = {}) {
  if (!configured(env)) throw new ApiError(503, "backend_not_configured", "The cloud demo has not been connected yet.");
  const url = new URL(`/rest/v1/${endpoint}`, env.SUPABASE_URL);
  const headers = new Headers(init.headers);
  headers.set("apikey", env.SUPABASE_SECRET_KEY);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  // Legacy JWT service-role keys need Authorization; new sb_secret keys must only use apikey.
  if (env.SUPABASE_SECRET_KEY.split(".").length === 3) headers.set("Authorization", `Bearer ${env.SUPABASE_SECRET_KEY}`);
  const response = await fetch(url, { ...init, headers });
  if (!response.ok) {
    console.error(JSON.stringify({ event: "database_request_failed", endpoint: endpoint.split("?")[0], status: response.status }));
    throw new ApiError(502, "database_error", "The demo database could not complete that request.");
  }
  return response;
}

async function consumeLimit(request: Request, env: Env, kind: "read" | "write") {
  if (!configured(env)) throw new ApiError(503, "backend_not_configured", "The cloud demo has not been connected yet.");
  const ip = request.headers.get("CF-Connecting-IP") || "local";
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(ip));
  const key = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
  const windowSeconds = 60;
  const response = await supabaseRequest(env, "rpc/healthcare_consume_demo_rate_limit", {
    method: "POST",
    body: JSON.stringify({ p_client_hash: key, p_window_seconds: windowSeconds }),
  });
  const result: unknown = await response.json();
  const requestCount = typeof result === "number" ? result : NaN;
  const limit = kind === "read" ? 120 : 30;
  if (!Number.isInteger(requestCount)) throw new ApiError(502, "database_error", "The demo database could not complete that request.");
  if (requestCount > limit) throw new ApiError(429, "rate_limited", "Please wait a minute before trying again.");
}

async function loadSnapshot(env: Env): Promise<StateSnapshot> {
  if (!configured(env)) throw new ApiError(503, "backend_not_configured", "The cloud demo has not been connected yet.");
  const id = clinicId(env);
  const read = async () => {
    const response = await supabaseRequest(env, "rpc/healthcare_read_demo_state", {
      method: "POST",
      body: JSON.stringify({ p_clinic_id: id }),
    });
    return await response.json() as Array<{ state: DemoState; revision: number }>;
  };
  let rows = await read();
  if (!rows.length) {
    await supabaseRequest(env, "rpc/healthcare_initialize_demo_state", {
      method: "POST",
      body: JSON.stringify({ p_clinic_id: id, p_state: createSeedState() }),
    });
    rows = await read();
  }
  const row = rows[0];
  if (!row?.state) throw new ApiError(502, "demo_seed_failed", "The sample schedule could not be loaded.");
  if (!Number.isInteger(Number(row.revision)) || Number(row.revision) < 1) throw new ApiError(502, "demo_seed_failed", "The sample schedule could not be loaded.");
  return { state: row.state, revision: Number(row.revision) };
}

function validateDemoState(value: unknown): value is DemoState {
  if (!hasOnlyKeys(value, ["appointments", "tasks", "referrals", "messages"])) return false;
  const state = value as Partial<DemoState>;
  if (!Array.isArray(state.appointments) || !Array.isArray(state.tasks) || !Array.isArray(state.referrals) || !Array.isArray(state.messages)) return false;
  if (state.appointments.length > 100 || state.tasks.length > 100 || state.referrals.length > 100 || state.messages.length > 200) return false;
  for (const item of state.appointments) {
    if (!hasOnlyKeys(item, ["id", "patient", "reference", "type", "provider", "location", "startAt", "timezone", "status", "documents"])) return false;
    if (!validDemoId(item.id) || !allowedNames.has(item.patient) || !/^DEMO-\d{4}$/.test(item.reference) || !Object.hasOwn(serviceDurations, item.type)) return false;
    if (!providers.some((provider) => provider.name === item.provider && provider.location === item.location)) return false;
    if (!validTimestamp(item.startAt) || (item.timezone !== undefined && !isTimezone(item.timezone)) || !["Confirmed", "Needs confirmation", "Cancelled"].includes(item.status)) return false;
    if (!["Needed", "Received", "In review"].includes(item.documents)) return false;
  }
  for (let index = 0; index < state.appointments.length; index += 1) {
    const appointment = state.appointments[index];
    if (appointment.status === "Cancelled") continue;
    if (overlaps({ ...state as DemoState, appointments: state.appointments.slice(index + 1) }, appointment.provider, appointment.startAt, appointment.type)) return false;
  }
  for (const item of state.tasks) {
    if (!hasOnlyKeys(item, ["id", "title", "patient", "detail", "dueAt", "priority", "status"])) return false;
    if (!validDemoId(item.id) || !(allowedNames.has(item.patient) || item.patient === "Front desk") || !safeTaskTitles.has(item.title) || !safeTaskDetails.has(item.detail)) return false;
    if (!validTimestamp(item.dueAt) || !["Normal", "Today", "Urgent"].includes(item.priority) || !["Open", "In progress", "Done"].includes(item.status)) return false;
  }
  for (const item of state.referrals) {
    if (!hasOnlyKeys(item, ["id", "patient", "reference", "appointment", "document", "receivedAt", "status"])) return false;
    if (!validDemoId(item.id) || !allowedNames.has(item.patient) || !/^DEMO-\d{4}$/.test(item.reference)) return false;
    if (!/^(Referral letter|Intake form|Insurance card|Referral document) · sample(?:\.pdf| image| needed)?$/.test(item.document)) return false;
    if (!Object.hasOwn(serviceDurations, item.appointment) || (item.receivedAt !== undefined && !validTimestamp(item.receivedAt))) return false;
    if (!["Needed", "Received", "In review"].includes(item.status)) return false;
  }
  for (const item of state.messages) {
    if (!hasOnlyKeys(item, ["id", "recipient", "purpose", "body", "sentAt", "scheduledFor", "appointmentReference", "status"])) return false;
    if (!validDemoId(item.id) || typeof item.recipient !== "string" || item.recipient.length > 120) return false;
    const safeRecipients = [...allowedNames].some((name) => item?.recipient === name || new RegExp(`^${name} · DEMO-\\d{4}$`).test(item?.recipient || "")) || item?.recipient === "Front desk";
    const safeBody = typeof item?.body === "string" && item.body.length <= 500 && (
      item.body === "Your demo appointment is confirmed. Reply STOP to opt out."
      || item.body === "A referral document is still needed for your demo visit."
      || item.body === "Text reminders have been turned off for this demo profile."
      || item.body === "A sample referral is still marked as needed. This follow-up is simulated and will be cancelled if the sample is received."
      || /^Demo appointment confirmed for [A-Za-z0-9 ,:/.-]+ \([A-Za-z0-9 _/-]+\)\. No text was sent\.$/.test(item.body)
      || /^Reminder for your sample appointment at [A-Za-z0-9 ,:/.-]+ \([A-Za-z0-9 _/-]+\)\. This text is not sent\.$/.test(item.body)
      || /^Your sample appointment has been (rescheduled|cancelled)\. This is a demo message; nothing was sent\.$/.test(item.body)
    );
    if (!safeRecipients || !safeBody || !validTimestamp(item.sentAt) || (item.scheduledFor !== undefined && !validTimestamp(item.scheduledFor))) return false;
    if (item.appointmentReference !== undefined && !/^DEMO-\d{4}$/.test(item.appointmentReference)) return false;
    if (!["Booking confirmation", "Document reminder", "24-hour appointment reminder", "48-hour missing-document follow-up", "Reschedule confirmation", "Cancellation confirmation", "Opt-out"].includes(item.purpose)) return false;
    if (!["Delivered (demo)", "Queued (demo)", "Scheduled (demo)", "Cancelled (demo)", "Opt-out"].includes(item.status)) return false;
  }
  return true;
}

function isTimezone(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 80) return false;
  try { new Intl.DateTimeFormat("en", { timeZone: value }).format(); return true; }
  catch { return false; }
}

async function saveSnapshot(env: Env, snapshot: StateSnapshot, state: DemoState) {
  if (!configured(env)) throw new ApiError(503, "backend_not_configured", "The cloud demo has not been connected yet.");
  if (!validateDemoState(state)) throw new ApiError(422, "demo_data_only", "Use the built-in fictional sample data only.");
  const response = await supabaseRequest(env, "rpc/healthcare_save_demo_state", {
    method: "POST",
    body: JSON.stringify({ p_clinic_id: clinicId(env), p_expected_revision: snapshot.revision, p_state: state }),
  });
  const result: unknown = await response.json();
  const row = Array.isArray(result) ? result[0] as { saved?: boolean; revision?: number } | undefined : undefined;
  if (!row?.saved) throw new ApiError(409, "demo_state_conflict", "Another demo session saved first. Reload the sample schedule and try again.");
  if (!Number.isInteger(Number(row.revision)) || Number(row.revision) !== snapshot.revision + 1) throw new ApiError(502, "database_error", "The demo database could not complete that request.");
  return { state, revision: Number(row.revision) };
}

async function mutateSnapshot(env: Env, change: (state: DemoState) => DemoState | Promise<DemoState>) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current = await loadSnapshot(env);
    try { return await saveSnapshot(env, current, await change(current.state)); }
    catch (error) { if (!(error instanceof ApiError) || error.status !== 409 || attempt === 3) throw error; }
  }
  throw new ApiError(409, "demo_state_conflict", "Please try the sample request again.");
}

async function readJson(request: Request): Promise<JsonRecord> {
  const contentLength = Number(request.headers.get("Content-Length") || "0");
  if (contentLength > 16_384) throw new ApiError(413, "request_too_large", "That request is too large for the demo.");
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > 16_384) throw new ApiError(413, "request_too_large", "That request is too large for the demo.");
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not object");
    return value as JsonRecord;
  } catch { throw new ApiError(400, "invalid_json", "Please send valid JSON for the demo request."); }
}

function stringField(value: unknown, name: string, max = 100) {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new ApiError(400, "invalid_field", `Please provide a valid ${name}.`);
  return value.trim();
}

function validateTimezone(value: unknown): string {
  const timezone = stringField(value, "timezone", 80);
  if (!isTimezone(timezone)) throw new ApiError(400, "invalid_timezone", "Choose a valid timezone for the sample schedule.");
  return timezone;
}

function localParts(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function localDate(date: Date, timezone: string) {
  const parts = localParts(date, timezone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function localDateTimeToUtc(date: string, time: string, timezone: string) {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  if (![year, month, day, hour, minute].every(Number.isFinite)) throw new ApiError(400, "invalid_slot", "Choose a valid appointment date and time.");
  const target = Date.UTC(year, month - 1, day, hour, minute);
  let guess = target;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const local = localParts(new Date(guess), timezone);
    const asUtc = Date.UTC(Number(local.year), Number(local.month) - 1, Number(local.day), Number(local.hour), Number(local.minute));
    guess += target - asUtc;
  }
  const result = new Date(guess);
  const check = localParts(result, timezone);
  if (Number(check.year) !== year || Number(check.month) !== month || Number(check.day) !== day || Number(check.hour) !== hour || Number(check.minute) !== minute) {
    throw new ApiError(400, "invalid_slot", "That local time does not exist because of a clock change. Choose another time.");
  }
  return result.toISOString();
}

function overlaps(state: DemoState, provider: string, startAt: string, type: string, ignoreReference?: string) {
  const start = Date.parse(startAt);
  const end = start + (serviceDurations[type] || 30) * 60_000;
  return state.appointments.some((item) => {
    if (item.status === "Cancelled" || item.provider !== provider || item.reference === ignoreReference) return false;
    const itemStart = Date.parse(item.startAt);
    const itemEnd = itemStart + (serviceDurations[item.type] || 30) * 60_000;
    return start < itemEnd && itemStart < end;
  });
}

function buildAvailability(state: DemoState, date: string, timezone: string, type: string) {
  if (!(type in serviceDurations)) throw new ApiError(400, "invalid_appointment_type", "Choose one of the sample appointment types.");
  const [year, month, day] = date.split("-").map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  if (weekday === 0 || weekday === 6) return [];
  const slots: Array<{ startAt: string; timezone: string; provider: string; location: string }> = [];
  for (let minutes = 8 * 60; minutes + serviceDurations[type] <= 17 * 60; minutes += 30) {
    const hh = String(Math.floor(minutes / 60)).padStart(2, "0");
    const mm = String(minutes % 60).padStart(2, "0");
    const startAt = localDateTimeToUtc(date, `${hh}:${mm}`, timezone);
    if (Date.parse(startAt) <= Date.now()) continue;
    const availableProvider = providers.find((provider) => !overlaps(state, provider.name, startAt, type));
    if (availableProvider) slots.push({ startAt, timezone, provider: availableProvider.name, location: availableProvider.location });
  }
  return slots;
}

function demoId(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function timeMessage(startAt: string, timezone: string) {
  return new Intl.DateTimeFormat("en", { weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: timezone }).format(new Date(startAt));
}

function scheduleFor(state: DemoState, patient: string, reference: string, startAt: string, timezone: string, needsDocuments: boolean): DemoState {
  const appointmentType = state.appointments.find((appointment) => appointment.reference === reference)?.type || "New patient visit";
  return {
    ...state,
    messages: [
      { id: demoId("msg"), recipient: `${patient} · ${reference}`, purpose: "Booking confirmation", body: `Demo appointment confirmed for ${timeMessage(startAt, timezone)} (${timezone}). No text was sent.`, sentAt: new Date().toISOString(), appointmentReference: reference, status: "Queued (demo)" as const },
      { id: demoId("msg"), recipient: `${patient} · ${reference}`, purpose: "24-hour appointment reminder", body: `Reminder for your sample appointment at ${timeMessage(startAt, timezone)} (${timezone}). This text is not sent.`, sentAt: new Date().toISOString(), scheduledFor: new Date(Math.max(Date.now(), Date.parse(startAt) - 86_400_000)).toISOString(), appointmentReference: reference, status: "Scheduled (demo)" as const },
      ...(needsDocuments ? [{ id: demoId("msg"), recipient: `${patient} · ${reference}`, purpose: "48-hour missing-document follow-up", body: "A sample referral is still marked as needed. This follow-up is simulated and will be cancelled if the sample is received.", sentAt: new Date().toISOString(), scheduledFor: new Date(Date.now() + 172_800_000).toISOString(), appointmentReference: reference, status: "Scheduled (demo)" as const }] : []),
      ...state.messages,
    ].slice(0, 200),
    tasks: needsDocuments ? [{ id: demoId("task"), title: "Referral document missing", patient, detail: "Check whether the sample referral has arrived; the 48-hour text remains simulated.", dueAt: new Date(Date.now() + 172_800_000).toISOString(), priority: "Normal", status: "Open" as const }, ...state.tasks] : state.tasks,
    referrals: needsDocuments ? [{ id: demoId("doc"), patient, reference, appointment: appointmentType, document: "Referral document · sample needed", status: "Needed" }, ...state.referrals] : state.referrals,
  };
}

function freshReference(state: DemoState) {
  let reference = "";
  do { reference = `DEMO-${Math.floor(1000 + Math.random() * 9000)}`; }
  while (state.appointments.some((item) => item.reference === reference));
  return reference;
}

function taskForIntent(intent: unknown): Omit<FollowUpTask, "id" | "dueAt" | "status"> {
  const tasks: Record<string, Omit<FollowUpTask, "id" | "dueAt" | "status">> = {
    callback: { title: "Call back requested", patient: "Front desk", detail: "Caller asked to speak with a member of the front desk.", priority: "Today" },
    refill: { title: "Prescription request", patient: "Front desk", detail: "Request passed to staff. The demo does not approve or advise about medication.", priority: "Normal" },
    records: { title: "Records request", patient: "Front desk", detail: "Request captured for the records team. No records are accessed or released in the demo.", priority: "Normal" },
    billing: { title: "Billing question", patient: "Front desk", detail: "Question routed to the billing team. The demo does not confirm coverage or charges.", priority: "Normal" },
    documents: { title: "Referral document follow-up", patient: "Front desk", detail: "Caller needs help with the sample referral checklist.", priority: "Normal" },
    faq: { title: "FAQ needs review", patient: "Front desk", detail: "An unlisted FAQ needs staff review. The question text is not stored.", priority: "Normal" },
  };
  const task = typeof intent === "string" ? tasks[intent] : undefined;
  if (!task) throw new ApiError(400, "invalid_request_type", "Choose a supported front-desk request.");
  return task;
}

async function stableId(seed: string) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(seed));
  return [...new Uint8Array(digest)].slice(0, 12).map((value) => value.toString(16).padStart(2, "0")).join("");
}

function normalizeNumber(value: string) {
  return value.replace(/[^+\d]/g, "");
}

function isAllowedCaller(call: ToolCall, env: Env) {
  const number = typeof call.from_number === "string" ? normalizeNumber(call.from_number) : "";
  const allowlist = (env.RETELL_TEST_NUMBERS || "").split(",").map(normalizeNumber).filter(Boolean);
  return Boolean(number && allowlist.includes(number));
}

function equalBytes(left: Uint8Array, right: Uint8Array) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let i = 0; i < left.length; i += 1) difference |= left[i] ^ right[i];
  return difference === 0;
}

async function verifyRetell(raw: string, signature: string | null, apiKey: string | undefined) {
  if (!signature || !apiKey) return false;
  const match = /^v=(\d+),d=([a-f0-9]{64})$/i.exec(signature);
  if (!match || Math.abs(Date.now() - Number(match[1])) > 300_000) return false;
  const key = await crypto.subtle.importKey("raw", encoder.encode(apiKey), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(raw + match[1])));
  const received = new Uint8Array((match[2].match(/.{2}/g) || []).map((part) => Number.parseInt(part, 16)));
  return equalBytes(digest, received);
}

async function retellTool(name: string, args: JsonRecord, call: ToolCall, env: Env) {
  if (!env.RETELL_TEST_NUMBERS || !isAllowedCaller(call, env)) {
    throw new ApiError(403, "test_caller_only", "This demo is limited to the configured test phone numbers.");
  }
  if (name === "get_availability") {
    const date = stringField(args.date, "date", 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ApiError(400, "invalid_date", "Use a date like 2026-10-15.");
    const type = stringField(args.appointment_type, "appointment type", 60);
    const timezone = validateTimezone(args.timezone);
    const snapshot = await loadSnapshot(env);
    return { slots: buildAvailability(snapshot.state, date, timezone, type).slice(0, 5), timezone, demo: true };
  }
  if (name === "create_appointment") {
    const requestCallId = stringField(call.call_id, "call ID", 100);
    const patient = stringField(args.patient_name, "sample patient", 60);
    if (!allowedNames.has(patient)) throw new ApiError(400, "sample_name_only", "Use one of the fictional sample names in the demo.");
    const type = stringField(args.appointment_type, "appointment type", 60);
    const startAt = stringField(args.start_at, "appointment time", 40);
    const timezone = validateTimezone(args.timezone);
    let booked: Appointment | undefined;
    const deterministicId = `apt-${await stableId(`${requestCallId}|${patient}|${type}|${startAt}`)}`;
    const snapshot = await mutateSnapshot(env, async (state) => {
      const existing = state.appointments.find((item) => item.id === deterministicId);
      if (existing) { booked = existing; return state; }
      if (!Number.isFinite(Date.parse(startAt))) throw new ApiError(400, "invalid_slot", "Choose a valid appointment time.");
      const date = localDate(new Date(startAt), timezone);
      const slots = buildAvailability(state, date, timezone, type);
      const selected = slots.find((slot) => Math.abs(Date.parse(slot.startAt) - Date.parse(startAt)) < 60_000);
      if (!selected) throw new ApiError(409, "slot_unavailable", "That time is no longer available. Offer another sample time.");
      const reference = freshReference(state);
      booked = { id: deterministicId, patient, reference, type, provider: selected.provider, location: selected.location, startAt: selected.startAt, timezone, status: "Confirmed", documents: type === "Follow-up visit" ? "Received" : "Needed" };
      const withAppointment = { ...state, appointments: [booked, ...state.appointments] };
      return scheduleFor(withAppointment, patient, reference, selected.startAt, timezone, booked.documents === "Needed");
    });
    const result = snapshot.state.appointments.find((item) => item.id === deterministicId) || booked;
    return { success: true, appointment: result, reference: result?.reference, message: "Sample appointment confirmed. No text was sent." };
  }
  if (name === "reschedule_appointment" || name === "cancel_appointment") {
    const requestCallId = stringField(call.call_id, "call ID", 100);
    const reference = stringField(args.booking_reference, "sample booking reference", 20);
    const patient = stringField(args.verification_name, "sample patient name", 60);
    if (!allowedNames.has(patient) || !/^DEMO-\d{4}$/.test(reference)) throw new ApiError(404, "sample_booking_not_found", "I could not match that sample booking. Please ask the front desk to follow up.");
    const next = name === "reschedule_appointment" ? stringField(args.new_start_at, "new appointment time", 40) : undefined;
    const timezone = name === "reschedule_appointment" ? validateTimezone(args.timezone) : undefined;
    const snapshot = await mutateSnapshot(env, async (state) => {
      const appointment = state.appointments.find((item) => item.reference === reference && item.patient === patient);
      if (!appointment) throw new ApiError(404, "sample_booking_not_found", "I could not match that sample booking. Please ask the front desk to follow up.");
      if (name === "cancel_appointment" && appointment.status === "Cancelled") return state;
      if (appointment.status === "Cancelled") throw new ApiError(404, "sample_booking_not_found", "I could not match that sample booking. Please ask the front desk to follow up.");
      if (next && timezone) {
        if (!Number.isFinite(Date.parse(next))) throw new ApiError(400, "invalid_slot", "Choose a valid appointment time.");
        const date = localDate(new Date(next), timezone);
        const slot = buildAvailability({ ...state, appointments: state.appointments.filter((item) => item.id !== appointment.id) }, date, timezone, appointment.type).find((item) => Math.abs(Date.parse(item.startAt) - Date.parse(next)) < 60_000);
        if (!slot) throw new ApiError(409, "slot_unavailable", "That time is no longer available. Offer another sample time.");
        const newMessages = state.messages.map((message) => {
          if (message.appointmentReference !== reference || message.status !== "Scheduled (demo)") return message;
          if (message.purpose === "24-hour appointment reminder") return { ...message, scheduledFor: new Date(Math.max(Date.now(), Date.parse(slot.startAt) - 86_400_000)).toISOString() };
          return message;
        });
        const confirmation = {
          id: `msg-${await stableId(`${requestCallId}|${reference}|reschedule|${slot.startAt}`)}`,
          recipient: `${patient} · ${reference}`,
          purpose: "Reschedule confirmation",
          body: "Your sample appointment has been rescheduled. This is a demo message; nothing was sent.",
          sentAt: new Date().toISOString(), appointmentReference: reference, status: "Queued (demo)" as const,
        };
        return {
          ...state,
          appointments: state.appointments.map((item) => item.id === appointment.id ? { ...item, startAt: slot.startAt, timezone, provider: slot.provider, location: slot.location } : item),
          messages: state.messages.some((message) => message.id === confirmation.id) ? newMessages : [confirmation, ...newMessages].slice(0, 200),
        };
      }
      const confirmation = {
        id: `msg-${await stableId(`${requestCallId}|${reference}|cancel`)}`,
        recipient: `${patient} · ${reference}`,
        purpose: "Cancellation confirmation",
        body: "Your sample appointment has been cancelled. This is a demo message; nothing was sent.",
        sentAt: new Date().toISOString(), appointmentReference: reference, status: "Queued (demo)" as const,
      };
      return {
        ...state,
        appointments: state.appointments.map((item) => item.id === appointment.id ? { ...item, status: "Cancelled" as const } : item),
        messages: state.messages.some((message) => message.id === confirmation.id)
          ? state.messages.map((message) => message.appointmentReference === reference && message.status === "Scheduled (demo)" ? { ...message, status: "Cancelled (demo)" as const } : message)
          : [confirmation, ...state.messages.map((message) => message.appointmentReference === reference && message.status === "Scheduled (demo)" ? { ...message, status: "Cancelled (demo)" as const } : message)].slice(0, 200),
      };
    });
    return { success: true, appointment: snapshot.state.appointments.find((item) => item.reference === reference), message: "The sample schedule is updated. No text was sent." };
  }
  if (name === "search_approved_faq") {
    const query = stringField(args.question, "question", 140).toLowerCase();
    const clinical = /symptom|diagnos|treatment|medicine|medication|prescription|pain|emergency|urgent|side effect/.test(query);
    if (clinical) return { answer: faqEntries.find((item) => item.id === "clinical")?.answer, handoff: true, approved: true };
    const words = query.split(/\W+/).filter((word) => word.length > 2);
    const ranked = faqEntries.map((entry) => ({ entry, score: words.reduce((score, word) => score + Number(`${entry.question} ${entry.category}`.toLowerCase().includes(word)), 0) })).sort((a, b) => b.score - a.score);
    const match = ranked[0]?.score ? ranked[0].entry : undefined;
    return match ? { answer: match.answer, approved: true, handoff: false } : { answer: "I don't have an approved answer for that. I can ask the front desk to follow up.", approved: false, handoff: true };
  }
  if (name === "request_staff_followup") {
    const requestCallId = stringField(call.call_id, "call ID", 100);
    const intent = stringField(args.request_type, "request type", 30);
    const task = taskForIntent(intent);
    const taskId = `task-${await stableId(`${requestCallId}|${intent}`)}`;
    await mutateSnapshot(env, (state) => state.tasks.some((item) => item.id === taskId)
      ? state
      : ({ ...state, tasks: [{ ...task, id: taskId, dueAt: new Date(Date.now() + 7_200_000).toISOString(), status: "Open" as const }, ...state.tasks].slice(0, 100) }));
    return { success: true, message: "I added a sample follow-up for the front desk. No personal details were stored." };
  }
  if (name === "check_document_status") {
    const reference = stringField(args.booking_reference, "sample booking reference", 20);
    const patient = stringField(args.sample_patient_name, "sample patient name", 60);
    if (!allowedNames.has(patient)) throw new ApiError(404, "sample_booking_not_found", "I could not match that sample booking.");
    const snapshot = await loadSnapshot(env);
    const matches = snapshot.state.referrals.filter((item) => item.reference === reference && item.patient === patient);
    return { documents: matches.map((item) => ({ document: item.document, status: item.status })), demo: true };
  }
  throw new ApiError(400, "unknown_function", "That front-desk function is not available in this demo.");
}

async function handleRetellFunction(request: Request, env: Env) {
  const raw = await request.text();
  if (encoder.encode(raw).byteLength > 16_384) throw new ApiError(413, "request_too_large", "That request is too large for the demo.");
  const valid = await verifyRetell(raw, request.headers.get("X-Retell-Signature"), env.RETELL_API_KEY);
  if (!valid) throw new ApiError(401, "invalid_signature", "The voice request could not be verified.");
  let body: JsonRecord;
  try { body = JSON.parse(raw) as JsonRecord; } catch { throw new ApiError(400, "invalid_json", "The voice request was not valid JSON."); }
  const name = stringField(body.name, "function name", 80);
  const args = body.args && typeof body.args === "object" && !Array.isArray(body.args) ? body.args as JsonRecord : {};
  const call = body.call && typeof body.call === "object" ? body.call as ToolCall : {};
  return retellTool(name, args, call, env);
}

async function handleRetellEvent(request: Request, env: Env) {
  const raw = await request.text();
  if (encoder.encode(raw).byteLength > 64_000) throw new ApiError(413, "request_too_large", "That voice event is too large for the demo.");
  if (!await verifyRetell(raw, request.headers.get("X-Retell-Signature"), env.RETELL_API_KEY)) throw new ApiError(401, "invalid_signature", "The voice event could not be verified.");
  let body: JsonRecord;
  try { body = JSON.parse(raw) as JsonRecord; } catch { throw new ApiError(400, "invalid_json", "The voice event was not valid JSON."); }
  const call = body.call && typeof body.call === "object" ? body.call as ToolCall : {};
  if (!env.RETELL_TEST_NUMBERS || !isAllowedCaller(call, env)) throw new ApiError(403, "test_caller_only", "Only configured demo test calls are accepted.");
  const callId = stringField(call.call_id, "call ID", 100);
  const event = stringField(body.event, "event type", 50);
  // Store no phone number, transcript, audio, summary, or caller-provided text.
  if (!configured(env)) throw new ApiError(503, "backend_not_configured", "The cloud demo has not been connected yet.");
  await supabaseRequest(env, "rpc/healthcare_record_retell_call_event", {
    method: "POST",
    body: JSON.stringify({ p_call_id: callId, p_event: event }),
  });
  return { accepted: true };
}

async function processDemoReminders(env: Env) {
  if (!configured(env)) return;
  // SMS is deliberately simulation-only. No provider call is made by this cron.
  const now = Date.now();
  await mutateSnapshot(env, (state) => ({
    ...state,
    messages: state.messages.map((message) => message.status === "Scheduled (demo)" && message.scheduledFor && Date.parse(message.scheduledFor) <= now
      ? { ...message, status: "Delivered (demo)" as const }
      : message),
  }));
}

async function fetchHandler(request: Request, env: Env): Promise<Response> {
  const requestId = crypto.randomUUID();
  const url = new URL(request.url);
  try {
    if (request.method === "OPTIONS") {
      if (!originAllowed(request, env)) return reply(request, env, requestId, 403, problem("origin_not_allowed", "This website is not allowed to use the demo API."));
      return new Response(null, { status: 204, headers: headersFor(request, env, requestId) });
    }
    if (request.method === "GET" && url.pathname === "/api/health") {
      let databaseConnected = false;
      if (configured(env)) {
        try {
          await supabaseRequest(env, "rpc/healthcare_read_demo_state", {
            method: "POST",
            body: JSON.stringify({ p_clinic_id: clinicId(env) }),
          });
          databaseConnected = true;
        } catch { /* Health output stays generic and never exposes provider details. */ }
      }
      return reply(request, env, requestId, 200, { ok: true, mode: "synthetic-demo", databaseConnected, liveCallsEnabled: false, liveSmsEnabled: false, requestId });
    }
    if (url.pathname.startsWith("/api/") && !originAllowed(request, env)) return reply(request, env, requestId, 403, problem("origin_not_allowed", "This website is not allowed to use the demo API."));
    if (url.pathname === "/webhooks/retell/custom-function" && request.method === "POST") {
      return reply(request, env, requestId, 200, await handleRetellFunction(request, env));
    }
    if (url.pathname === "/webhooks/retell/events" && request.method === "POST") {
      return reply(request, env, requestId, 200, await handleRetellEvent(request, env));
    }
    if (url.pathname === "/api/demo/state" && request.method === "GET") {
      await consumeLimit(request, env, "read");
      const snapshot = await loadSnapshot(env);
      return reply(request, env, requestId, 200, snapshot);
    }
    if (url.pathname === "/api/demo/state" && request.method === "PUT") {
      await consumeLimit(request, env, "write");
      const body = await readJson(request);
      const revision = Number(body.revision);
      if (!Number.isInteger(revision) || revision < 1 || !validateDemoState(body.state)) throw new ApiError(422, "demo_data_only", "Use the built-in fictional sample data only.");
      const saved = await saveSnapshot(env, { state: body.state, revision }, body.state);
      return reply(request, env, requestId, 200, saved);
    }
    if (url.pathname === "/api/faqs" && request.method === "GET") {
      await consumeLimit(request, env, "read");
      const query = (url.searchParams.get("q") || "").toLowerCase().slice(0, 120);
      const entries = faqEntries.filter((entry) => !query || `${entry.category} ${entry.question} ${entry.answer}`.toLowerCase().includes(query));
      return reply(request, env, requestId, 200, { entries, demo: true });
    }
    if (url.pathname === "/api/appointments/availability" && request.method === "POST") {
      await consumeLimit(request, env, "read");
      const body = await readJson(request);
      const date = stringField(body.date, "date", 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ApiError(400, "invalid_date", "Use a date like 2026-10-15.");
      const type = stringField(body.appointmentType, "appointment type", 60);
      const timezone = validateTimezone(body.timezone);
      const snapshot = await loadSnapshot(env);
      return reply(request, env, requestId, 200, { slots: buildAvailability(snapshot.state, date, timezone, type), timezone, demo: true });
    }
    if (url.pathname === "/api/tasks" && request.method === "POST") {
      await consumeLimit(request, env, "write");
      const body = await readJson(request);
      const task = taskForIntent(body.requestType);
      const snapshot = await mutateSnapshot(env, (state) => ({ ...state, tasks: [{ ...task, id: demoId("task"), dueAt: new Date(Date.now() + 7_200_000).toISOString(), status: "Open" as const }, ...state.tasks].slice(0, 100) }));
      return reply(request, env, requestId, 201, { task: snapshot.state.tasks[0], revision: snapshot.revision });
    }
    return reply(request, env, requestId, 404, problem("not_found", "That demo endpoint does not exist."));
  } catch (error) {
    if (error instanceof ApiError) return reply(request, env, requestId, error.status, problem(error.code, error.message));
    // Keep logs useful without writing request contents, caller details, or provider secrets.
    console.error(JSON.stringify({ event: "request_failed", requestId, path: url.pathname }));
    return reply(request, env, requestId, 500, problem("internal_error", "The demo could not complete that request. Please try again."));
  }
}

export default {
  fetch(request: Request, env: Env, _context: ExecutionContextLike) {
    return fetchHandler(request, env);
  },
  scheduled(_controller: ScheduledControllerLike, env: Env, context: ExecutionContextLike) {
    context.waitUntil(processDemoReminders(env));
  },
};
