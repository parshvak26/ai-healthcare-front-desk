// Retell custom-function and call-event webhooks. Requests must carry a valid X-Retell-Signature and belong to a
// call this Worker started (or come from an allowlisted owner number). Tool calls run the same front-desk rules as
// the staff console, against the private demo named in the call's signed metadata.
import {
  DomainError, appointmentTypes, applyDemoAction, findAppointment, findAppointmentsByName, foldName, formatLocalLong, isDateKey,
  isTimezone, parseBookingReference, providers, searchApprovedFaq, searchAvailability, spokenDateTime, spokenReference,
  voiceRequestTypes,
} from "../../../packages/shared/src/index.ts";
import type { Appointment, DemoAction, PartOfDay, RequestType } from "../../../packages/shared/src/index.ts";
import { demoCallSettings, demoCallSource, isRequestId, reasonCode, recordCallEvent, wrongNumberSuppressionDays } from "./calls.ts";
import { callerTime } from "./context.ts";
import { afterResponse, configured, rpc } from "./store.ts";
import type { Env, ExecutionContextLike } from "./store.ts";
import {
  assertLinked, clinicTimezone, isWorkspaceId, loadWorkspace, mutateWorkspace, ownerWorkspaceId, sessionCleared,
} from "./workspaces.ts";
import type { CreateMode } from "./workspaces.ts";

type JsonRecord = Record<string, unknown>;
interface RetellCall {
  call_id?: unknown; call_type?: unknown; from_number?: unknown; agent_id?: unknown; direction?: unknown; metadata?: unknown;
  start_timestamp?: unknown; end_timestamp?: unknown; disconnection_reason?: unknown;
}

const encoder = new TextEncoder();
const signatureTolerance = 5 * 60 * 1000;
// Retell includes the call transcript in each tool request, so allow long calls; the signature is checked before parsing.
export const maxFunctionBodyBytes = 512_000;
// call_ended carries the whole transcript too.
export const maxEventBodyBytes = 1_000_000;

/** Same algorithm as Retell's SDK (retell-sdk lib/webhook_auth): HMAC-SHA256 of raw body + timestamp. */
export async function verifyRetellSignature(raw: string, signature: string | null, apiKey: string | undefined, now = Date.now()) {
  if (!signature || !apiKey) return false;
  const match = /^v=(\d+),d=([0-9a-f]{64})$/i.exec(signature);
  if (!match) return false;
  const timestamp = Number(match[1]);
  if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > signatureTolerance) return false;
  const digest = new Uint8Array((match[2].match(/.{2}/g) || []).map((pair) => Number.parseInt(pair, 16)));
  const key = await crypto.subtle.importKey("raw", encoder.encode(apiKey), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  return crypto.subtle.verify("HMAC", key, digest, encoder.encode(raw + match[1]));
}

function normalizeNumber(value: string) {
  return value.replace(/[^+\d]/g, "");
}

export function isAllowedCaller(call: RetellCall, env: Env) {
  const number = typeof call.from_number === "string" ? normalizeNumber(call.from_number) : "";
  const allowlist = (env.RETELL_TEST_NUMBERS || "").split(",").map(normalizeNumber).filter(Boolean);
  return Boolean(number && allowlist.includes(number));
}

function metadataOf(call: RetellCall): JsonRecord {
  return call.metadata && typeof call.metadata === "object" && !Array.isArray(call.metadata) ? call.metadata as JsonRecord : {};
}

/**
 * Tools answer inbound calls from an allowlisted owner number, and calls this Worker started for the Healthcare
 * agent: browser calls (call_type web_call) and outbound phone calls. Only holders of the Retell API key can set
 * call metadata, and the signature has already been verified, so the metadata marker cannot be forged by a caller.
 */
export function isTrustedCall(call: RetellCall, env: Env) {
  if (isAllowedCaller(call, env)) return true;
  if (!env.RETELL_AGENT_ID || call.agent_id !== env.RETELL_AGENT_ID || metadataOf(call).source !== demoCallSource) return false;
  if (call.call_type === "web_call") return true;
  return call.direction === "outbound";
}

// ---------- the call's session: workspace, channel, time ----------

interface VoiceSession {
  callId: string;
  workspaceId: string;
  mode: CreateMode;
  requestId: string | null;
  channel: "phone" | "web";
  clinicTimezone: string;
  callerTimezone: string;
  secondsLeft?: number;
}

function millis(value: unknown) {
  const ms = typeof value === "number" ? value : typeof value === "string" && /^\d{10,16}$/.test(value) ? Number(value) : Number.NaN;
  return Number.isFinite(ms) ? ms : undefined;
}

async function resolveSession(call: RetellCall, callId: string, env: Env, now: number): Promise<VoiceSession> {
  const metadata = metadataOf(call);
  const zone = clinicTimezone(env);
  const requestId = isRequestId(metadata.request_id) ? metadata.request_id : null;
  let workspaceId: string;
  let mode: CreateMode;
  if (metadata.workspace !== undefined) {
    if (!isWorkspaceId(metadata.workspace) || !requestId) throw sessionCleared();
    workspaceId = metadata.workspace;
    mode = { kind: "call", requestId };
  } else if (isAllowedCaller(call, env)) {
    workspaceId = await ownerWorkspaceId(env);
    mode = { kind: "owner" };
  } else {
    // A trusted demo call without a workspace (for example one placed by the previous Worker version).
    throw sessionCleared();
  }
  const maxSeconds = Number(metadata.max_seconds) || demoCallSettings(env).maxCallDurationSeconds;
  const start = millis(call.start_timestamp) ?? millis(metadata.placed_at);
  return {
    callId, workspaceId, mode, requestId,
    channel: call.call_type === "web_call" ? "web" : "phone",
    clinicTimezone: zone,
    callerTimezone: isTimezone(metadata.caller_timezone) ? metadata.caller_timezone : zone,
    ...(start !== undefined ? { secondsLeft: Math.max(0, Math.floor(maxSeconds - (now - start) / 1000)) } : {}),
  };
}

// ---------- arguments (new names first, then the aliases the previously published agent sends) ----------

function pick(args: JsonRecord, names: string[]) {
  for (const name of names) {
    const value = args[name];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function text(args: JsonRecord, names: string[], label: string, max = 100) {
  const value = pick(args, names);
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new DomainError(400, "invalid_field", `Please provide a valid ${label}.`);
  return value.trim();
}

function optionalText(args: JsonRecord, names: string[], label: string, max = 100) {
  return pick(args, names) === undefined ? undefined : text(args, names, label, max);
}

const nameArgs = ["patient_name", "verification_name", "sample_patient_name"];

function appointmentTypeArg(args: JsonRecord) {
  const value = text(args, ["appointment_type"], "appointment type", 60);
  const match = appointmentTypes.find((item) => item.toLowerCase() === value.toLowerCase());
  if (!match) throw new DomainError(400, "invalid_appointment_type", "Use one of: New patient visit, Follow-up visit, Consultation, Administrative call.");
  return match;
}

/** "Dr. Avery Chen", "Doctor Chen" or "chen" → "Dr. Avery Chen". */
function providerArg(args: JsonRecord) {
  const value = optionalText(args, ["provider"], "provider", 60);
  if (value === undefined) return undefined;
  const folded = value.toLowerCase();
  const match = providers.find((item) => item.name.toLowerCase() === folded)
    ?? providers.find((item) => folded.includes(item.name.split(" ").pop()!.toLowerCase()));
  if (!match) throw new DomainError(400, "invalid_provider", "Use one of the providers returned by get_availability.");
  return match.name;
}

function referenceArg(args: JsonRecord) {
  const reference = parseBookingReference(text(args, ["booking_reference"], "booking reference", 40));
  if (!reference) throw new DomainError(400, "invalid_reference", "I need the four-digit booking number, like demo four eight one two. Ask the caller for it again.");
  return reference;
}

/** Same instant, same text: "…00Z" and "…00.000Z" must not count as different requests. */
function normalizedInstant(value: string) {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : value;
}

function searchDaysArg(args: JsonRecord) {
  const value = pick(args, ["search_days"]);
  if (value === undefined) return 1;
  const days = typeof value === "number" ? value : typeof value === "string" && /^\d{1,2}$/.test(value.trim()) ? Number(value) : Number.NaN;
  if (!Number.isInteger(days) || days < 1 || days > 14) throw new DomainError(400, "invalid_range", "Search between 1 and 14 days.");
  return days;
}

function partOfDayArg(args: JsonRecord): PartOfDay {
  const value = pick(args, ["time_of_day"]);
  return value === "morning" || value === "afternoon" ? value : "any";
}

// ---------- results ----------

function voiceAppointment(appointment: Appointment, session: VoiceSession) {
  const local = callerTime(appointment.startAt, session.callerTimezone, session.clinicTimezone);
  return {
    reference: appointment.reference,
    reference_spoken: spokenReference(appointment.reference),
    patient: appointment.patient,
    appointment_type: appointment.type,
    status: appointment.status,
    start_at: appointment.startAt,
    spoken_time: spokenDateTime(appointment.startAt, session.clinicTimezone),
    ...(local ? { caller_time: local } : {}),
    provider: appointment.provider,
    location: appointment.location,
    documents: appointment.documents,
    // Read by the previously published prompt.
    local_time: formatLocalLong(appointment.startAt, session.clinicTimezone),
  };
}

async function readState(env: Env, session: VoiceSession, now: number) {
  const workspace = await loadWorkspace(env, session.workspaceId, now);
  if (!workspace.persisted && session.mode.kind === "call") await assertLinked(env, session.workspaceId, session.mode.requestId);
  return workspace.state;
}

/**
 * Runs a write through the shared rules. The idempotency key is built from the call ID, the tool and the canonical
 * action (plan R7): a repeated tool call that differs only in name capitalisation or timestamp spelling is the same
 * request, so a retry never books twice.
 */
async function runAction(env: Env, session: VoiceSession, key: string, action: DemoAction, now: number) {
  const { value } = await mutateWorkspace(env, session.workspaceId, (state) => {
    const outcome = applyDemoAction(state, action, { now, channel: "Voice assistant", key: `${session.callId}|${key}`, random: Math.random, seedTimezone: env.CLINIC_TIMEZONE });
    return { state: outcome.state, changed: outcome.changed, value: outcome };
  }, session.mode, now);
  return value;
}

async function tool(name: string, args: JsonRecord, session: VoiceSession, env: Env, now: number): Promise<JsonRecord> {
  const zone = session.clinicTimezone;
  switch (name) {
    case "get_availability": {
      const appointmentType = appointmentTypeArg(args);
      const startDate = text(args, ["start_date", "date"], "date", 40);
      if (!isDateKey(startDate)) throw new DomainError(400, "invalid_date", "Use a clinic date like 2026-10-15, taken from clinic_calendar.");
      const earliestTime = optionalText(args, ["earliest_time"], "earliest time", 5);
      const provider = providerArg(args);
      const state = await readState(env, session, now);
      const result = searchAvailability(state, {
        startDate, days: searchDaysArg(args), appointmentType, timezone: zone, now, partOfDay: partOfDayArg(args), limit: 3,
        ...(earliestTime ? { earliestTime } : {}), ...(provider ? { provider } : {}),
      });
      return {
        success: true, searched_from: result.searchedFrom, searched_to: result.searchedTo,
        slots: result.slots.map((slot) => {
          const local = callerTime(slot.startAt, session.callerTimezone, zone);
          return { start_at: slot.startAt, provider: slot.provider, location: slot.location, spoken: spokenDateTime(slot.startAt, zone), ...(local ? { caller_time: local } : {}), local_time: slot.localTime };
        }),
        more_available: result.moreAvailable,
        message: result.slots.length
          ? "Offer only these times, read as spoken. To book, pass the chosen slot's start_at and provider."
          : "No openings in that range. Offer to search other days, or the waitlist.",
      };
    }
    case "create_appointment": {
      const patient = text(args, ["patient_name"], "name", 60);
      const appointmentType = appointmentTypeArg(args);
      const startAt = normalizedInstant(text(args, ["start_at"], "appointment time", 40));
      const provider = providerArg(args);
      const outcome = await runAction(env, session, `book|${foldName(patient)}|${appointmentType}|${startAt}`, {
        type: "book_appointment", patient, appointmentType, startAt, timezone: zone, ...(provider ? { provider } : {}),
      }, now);
      const appointment = outcome.appointment!;
      return {
        success: true, reference: appointment.reference, reference_spoken: spokenReference(appointment.reference), patient_name: appointment.patient,
        appointment: voiceAppointment(appointment, session), message: "Booked. Read back the spoken_time and give the reference as reference_spoken. No text was sent.",
      };
    }
    case "reschedule_appointment": {
      const reference = referenceArg(args);
      const patient = text(args, nameArgs, "name", 60);
      const newStartAt = normalizedInstant(text(args, ["new_start_at"], "new appointment time", 40));
      const provider = providerArg(args);
      const outcome = await runAction(env, session, `move|${reference}|${newStartAt}`, {
        type: "reschedule_appointment", reference, patient, newStartAt, timezone: zone, ...(provider ? { provider } : {}),
      }, now);
      return { success: true, appointment: voiceAppointment(outcome.appointment!, session), message: outcome.message };
    }
    case "cancel_appointment":
    case "confirm_appointment": {
      const reference = referenceArg(args);
      const patient = text(args, nameArgs, "name", 60);
      const outcome = await runAction(env, session, `${name}|${reference}`, {
        type: name === "cancel_appointment" ? "cancel_appointment" : "confirm_appointment", reference, patient,
      }, now);
      return { success: true, appointment: voiceAppointment(outcome.appointment!, session), message: outcome.message };
    }
    case "lookup_appointment": {
      const rawReference = optionalText(args, ["booking_reference"], "booking reference", 40);
      const patient = optionalText(args, nameArgs, "name", 60);
      if (rawReference === undefined && patient === undefined) throw new DomainError(400, "invalid_field", "Ask for the caller's name or booking reference first.");
      const state = await readState(env, session, now);
      if (rawReference !== undefined) {
        const appointment = findAppointment(state, referenceArg(args), patient);
        return { success: true, appointments: [voiceAppointment(appointment, session)], match: "reference", message: "Read back the spoken_time, appointment type and location." };
      }
      const found = findAppointmentsByName(state, patient!, now);
      if (!found.appointments.length) throw new DomainError(404, "sample_booking_not_found", "No upcoming visits were found under that name. Ask for the booking reference, or offer to book a new visit.");
      return {
        success: true, appointments: found.appointments.slice(0, 5).map((item) => voiceAppointment(item, session)), match: found.tier,
        message: found.appointments.length > 1
          ? "More than one booking matches. Ask which one, using the spoken times. Do not change anything yet."
          : "Read back the spoken_time, appointment type and location.",
      };
    }
    case "search_approved_faq": {
      // Kept for the previously published agent; the new prompt embeds the approved answers.
      const result = searchApprovedFaq(text(args, ["question"], "question", 300));
      return {
        success: true, approved: result.approved, handoff: result.handoff, answer: result.answer,
        ...(result.emergency ? { emergency: true } : {}),
        ...(result.suggestedRequest ? { suggested_request_type: result.suggestedRequest } : {}),
      };
    }
    case "request_staff_followup": {
      const requestType = text(args, ["request_type"], "request type", 30);
      if (!(voiceRequestTypes as string[]).includes(requestType)) throw new DomainError(400, "invalid_request_type", "Choose a supported front-desk request.");
      const patient = optionalText(args, ["patient_name"], "name", 60);
      // One task per request type per call, however many times the model calls the tool.
      const outcome = await runAction(env, session, `task|${requestType}`, {
        type: "create_task", requestType: requestType as RequestType, ...(patient ? { patient } : {}),
      }, now);
      return { success: true, message: outcome.message };
    }
    case "join_waitlist": {
      const patient = text(args, ["patient_name"], "name", 60);
      const appointmentType = appointmentTypeArg(args);
      const preferredDate = text(args, ["preferred_date", "date"], "preferred date", 40);
      const outcome = await runAction(env, session, `wait|${foldName(patient)}|${appointmentType}|${preferredDate}`, {
        type: "join_waitlist", patient, appointmentType, preferredDate, timezone: zone,
      }, now);
      const item = outcome.waitlistItem;
      return {
        success: true,
        waitlist_request: item && { preferred_date: item.preferredDate, appointment_type: item.appointmentType, status: item.status },
        message: outcome.message,
      };
    }
    case "check_document_status": {
      const reference = referenceArg(args);
      const patient = optionalText(args, nameArgs, "name", 60);
      const state = await readState(env, session, now);
      const appointment = findAppointment(state, reference, patient);
      const documents = state.referrals.filter((item) => item.reference === appointment.reference).map((item) => ({ document: item.document, status: item.status }));
      return {
        success: true, appointment_documents: appointment.documents, documents,
        message: documents.length ? "Read back each sample document and its status." : "No sample documents are listed for this booking.",
      };
    }
    case "report_wrong_number": {
      // Only the dialled number's keyed hash is blocked; nothing is stored for browser or owner test calls.
      if (session.channel === "phone" && session.requestId) {
        await rpc(env, "healthcare_suppress_demo_call_number", { p_request_id: session.requestId, p_call_id: session.callId, p_days: wrongNumberSuppressionDays });
        console.log(JSON.stringify({ event: "demo_call_wrong_number" }));
      }
      return { success: true, message: "Apologise in one sentence and end the call." };
    }
    default:
      throw new DomainError(400, "unknown_function", "That front-desk function is not available in this demo.");
  }
}

export interface WebhookResult { status: number; body: JsonRecord }

function parseBody(raw: string): JsonRecord | null {
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
  } catch {
    return null;
  }
}

/**
 * Retell only shows the agent the HTTP status for non-2xx responses, not the body. Business outcomes
 * (slot taken, booking not found) are therefore returned as 200 with success=false and a message the agent can
 * act on. Authentication failures stay as 401/403 so nothing is revealed to an unverified caller.
 */
export async function handleRetellFunction(raw: string, signature: string | null, env: Env, context?: ExecutionContextLike): Promise<WebhookResult> {
  if (!await verifyRetellSignature(raw, signature, env.RETELL_API_KEY)) return { status: 401, body: { error: { code: "invalid_signature", message: "The voice request could not be verified." } } };
  const body = parseBody(raw);
  if (!body) return { status: 400, body: { error: { code: "invalid_json", message: "The voice request was not valid JSON." } } };
  const call = (body.call && typeof body.call === "object" ? body.call : {}) as RetellCall;
  if (!isTrustedCall(call, env)) return { status: 403, body: { error: { code: "test_caller_only", message: "This demo only answers its own demo calls and approved test numbers." } } };
  const name = typeof body.name === "string" ? body.name : "";
  const args = (body.args && typeof body.args === "object" && !Array.isArray(body.args) ? body.args : {}) as JsonRecord;
  const callId = typeof call.call_id === "string" && call.call_id.length <= 120 ? call.call_id : "";
  if (!name || !callId) return { status: 400, body: { error: { code: "invalid_request", message: "The voice request is missing its function name or call ID." } } };

  const started = Date.now();
  let session: VoiceSession | undefined;
  let result: JsonRecord;
  try {
    session = await resolveSession(call, callId, env, started);
    result = await tool(name, args, session, env, started);
  } catch (error) {
    if (error instanceof DomainError && error.status < 500) {
      result = { success: false, error: error.code, message: error.message };
    } else {
      console.error(JSON.stringify({ event: "voice_tool_failed", tool: /^[a-z_]{1,40}$/.test(name) ? name : "unknown", code: error instanceof DomainError ? error.code : "internal_error" }));
      result = {
        success: false, error: "service_unavailable",
        message: "I couldn't confirm that with the demo scheduler. Try once more with exactly the same details; if it fails again, do not say it succeeded and offer a staff follow-up.",
      };
    }
  }
  if (session?.secondsLeft !== undefined) result = { ...result, seconds_left: session.secondsLeft };
  // "Under the hood" timing for the call page, written after the response so it adds no latency.
  if (session?.requestId && /^[a-z_]{1,40}$/.test(name)) {
    await afterResponse(context, rpc(env, "healthcare_append_demo_call_tool_log", {
      p_request_id: session.requestId, p_call_id: callId, p_tool: name, p_ms: Math.min(600_000, Date.now() - started), p_ok: result.success === true,
    }));
  }
  return { status: 200, body: result };
}

export async function handleRetellEvent(raw: string, signature: string | null, env: Env, context?: ExecutionContextLike): Promise<WebhookResult> {
  if (!await verifyRetellSignature(raw, signature, env.RETELL_API_KEY)) return { status: 401, body: { error: { code: "invalid_signature", message: "The voice event could not be verified." } } };
  const body = parseBody(raw);
  if (!body) return { status: 400, body: { error: { code: "invalid_json", message: "The voice event was not valid JSON." } } };
  const call = (body.call && typeof body.call === "object" ? body.call : {}) as RetellCall;
  if (!isTrustedCall(call, env)) return { status: 403, body: { error: { code: "test_caller_only", message: "Only this demo's own calls are accepted." } } };
  const callId = typeof call.call_id === "string" ? call.call_id : "";
  const event = typeof body.event === "string" ? body.event : "";
  if (!callId || callId.length > 120 || !event || event.length > 60) return { status: 400, body: { error: { code: "invalid_request", message: "The voice event is missing required fields." } } };
  // Only the start and end matter to the demo; other events (for example call_analyzed) are acknowledged and dropped.
  if (event !== "call_started" && event !== "call_ended") return { status: 200, body: { accepted: true } };
  if (!configured(env)) return { status: 503, body: { error: { code: "backend_not_configured", message: "The cloud demo has not been connected yet." } } };
  const metadata = metadataOf(call);
  // Store only the opaque call ID, the event, Retell's disconnection reason and its time: no number, transcript or audio.
  await recordCallEvent(env, {
    callId, event,
    detail: event === "call_ended" ? reasonCode(call.disconnection_reason) : null,
    requestId: isRequestId(metadata.request_id) ? metadata.request_id : null,
    at: event === "call_started" ? call.start_timestamp : call.end_timestamp,
  });
  // A finished call counts as a use of the demo: it is kept for 7 days from now.
  if (event === "call_ended" && isWorkspaceId(metadata.workspace)) {
    await afterResponse(context, rpc(env, "healthcare_touch_workspace", { p_workspace_id: metadata.workspace, p_had_call: true }));
  }
  return { status: 200, body: { accepted: true } };
}
