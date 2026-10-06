// Retell custom-function and call-event webhooks. Requests must carry a valid X-Retell-Signature and come from
// an allowlisted test number. Tool calls run the same front-desk rules as the staff console.
import {
  DomainError, applyDemoAction, appointmentSummary, buildAvailability, defaultClinicTimezone, findAppointment, searchApprovedFaq,
  voiceRequestTypes,
} from "../../../packages/shared/src/index.ts";
import type { DemoAction, RequestType } from "../../../packages/shared/src/index.ts";
import { demoCallSource } from "./calls.ts";
import { configured, loadSnapshot, mutateSnapshot, recordCallEvent } from "./store.ts";
import type { Env } from "./store.ts";

type JsonRecord = Record<string, unknown>;
interface RetellCall { call_id?: unknown; from_number?: unknown; agent_id?: unknown; direction?: unknown; metadata?: unknown }

const encoder = new TextEncoder();
const signatureTolerance = 5 * 60 * 1000;
// Retell includes the call transcript in each tool request, so allow long calls; the signature is checked before parsing.
export const maxFunctionBodyBytes = 512_000;

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

/**
 * Tools answer two kinds of calls: inbound calls from an allowlisted owner number, and outbound demo calls this
 * Worker started for the Healthcare agent. Only holders of the Retell API key can set call metadata, and the request
 * signature has already been verified, so the metadata marker cannot be forged by a caller.
 */
export function isTrustedCall(call: RetellCall, env: Env) {
  if (isAllowedCaller(call, env)) return true;
  const metadata = call.metadata && typeof call.metadata === "object" ? call.metadata as Record<string, unknown> : {};
  return Boolean(env.RETELL_AGENT_ID && call.agent_id === env.RETELL_AGENT_ID
    && metadata.source === demoCallSource && (call.direction === undefined || call.direction === "outbound"));
}

function text(args: JsonRecord, name: string, label: string, max = 100) {
  const value = args[name];
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new DomainError(400, "invalid_field", `Please provide a valid ${label}.`);
  return value.trim();
}

function timezoneArg(args: JsonRecord, env: Env) {
  const value = args.timezone;
  return typeof value === "string" && value.trim() ? value.trim() : env.CLINIC_TIMEZONE || defaultClinicTimezone;
}

function optionalText(args: JsonRecord, name: string, max = 100) {
  return args[name] === undefined || args[name] === null || args[name] === "" ? undefined : text(args, name, name.replace(/_/g, " "), max);
}

/** Same instant, same text: "…00Z" and "…00.000Z" must not count as different requests. */
function normalizedInstant(value: string) {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : value;
}

/**
 * The idempotency key is built from the normalized action, not the raw arguments, so a repeated tool call that
 * differs only in formatting (an omitted default timezone, a different timestamp spelling) is still one request.
 */
async function runAction(env: Env, callId: string, name: string, action: DemoAction) {
  const key = `${callId}|${name}|${JSON.stringify(action)}`;
  const { value } = await mutateSnapshot(env, (state) => {
    const outcome = applyDemoAction(state, action, { now: Date.now(), channel: "Voice assistant", key, random: Math.random, seedTimezone: env.CLINIC_TIMEZONE });
    return { state: outcome.state, changed: outcome.changed, value: outcome };
  });
  return value;
}

async function tool(name: string, args: JsonRecord, callId: string, env: Env): Promise<JsonRecord> {
  switch (name) {
    case "get_availability": {
      const date = text(args, "date", "date", 10);
      const timezone = timezoneArg(args, env);
      const { state } = await loadSnapshot(env);
      const slots = buildAvailability(state, { date, appointmentType: text(args, "appointment_type", "appointment type", 60), timezone, now: Date.now() }).slice(0, 5);
      return {
        success: true, demo: true, date, timezone,
        slots: slots.map((slot) => ({ start_at: slot.startAt, local_time: slot.localTime, provider: slot.provider, location: slot.location })),
        message: slots.length ? "Offer only these sample times, read as local_time. When booking, pass the chosen slot's start_at and provider." : "No sample openings on that date. Offer another date or the demo waitlist.",
      };
    }
    case "create_appointment": {
      const provider = optionalText(args, "provider", 60);
      const outcome = await runAction(env, callId, name, {
        type: "book_appointment", patient: text(args, "patient_name", "sample patient", 60), appointmentType: text(args, "appointment_type", "appointment type", 60),
        startAt: normalizedInstant(text(args, "start_at", "appointment time", 40)), timezone: timezoneArg(args, env), ...(provider ? { provider } : {}),
      });
      return { success: true, reference: outcome.appointment?.reference, appointment: outcome.appointment && appointmentSummary(outcome.appointment), message: outcome.message };
    }
    case "reschedule_appointment": {
      const provider = optionalText(args, "provider", 60);
      const outcome = await runAction(env, callId, name, {
        type: "reschedule_appointment", reference: text(args, "booking_reference", "sample booking reference", 20).toUpperCase(), patient: text(args, "verification_name", "sample patient name", 60),
        newStartAt: normalizedInstant(text(args, "new_start_at", "new appointment time", 40)), timezone: timezoneArg(args, env), ...(provider ? { provider } : {}),
      });
      return { success: true, appointment: outcome.appointment && appointmentSummary(outcome.appointment), message: outcome.message };
    }
    case "cancel_appointment":
    case "confirm_appointment": {
      const outcome = await runAction(env, callId, name, {
        type: name === "cancel_appointment" ? "cancel_appointment" : "confirm_appointment",
        reference: text(args, "booking_reference", "sample booking reference", 20).toUpperCase(), patient: text(args, "verification_name", "sample patient name", 60),
      });
      return { success: true, appointment: outcome.appointment && appointmentSummary(outcome.appointment), message: outcome.message };
    }
    case "lookup_appointment": {
      const { state } = await loadSnapshot(env);
      const appointment = findAppointment(state, text(args, "booking_reference", "sample booking reference", 20).toUpperCase(), text(args, "verification_name", "sample patient name", 60));
      return { success: true, appointment: appointmentSummary(appointment), message: "Read back the local_time, appointment type, and location." };
    }
    case "search_approved_faq": {
      const result = searchApprovedFaq(text(args, "question", "question", 300));
      return {
        success: true, approved: result.approved, handoff: result.handoff, answer: result.answer,
        ...(result.emergency ? { emergency: true } : {}),
        ...(result.suggestedRequest ? { suggested_request_type: result.suggestedRequest } : {}),
      };
    }
    case "request_staff_followup": {
      const requestType = text(args, "request_type", "request type", 30);
      if (!(voiceRequestTypes as string[]).includes(requestType)) throw new DomainError(400, "invalid_request_type", "Choose a supported front-desk request.");
      // One task per request type per call, however many times the model calls the tool.
      const outcome = await runAction(env, callId, name, { type: "create_task", requestType: requestType as RequestType });
      return { success: true, message: outcome.message };
    }
    case "join_waitlist": {
      const outcome = await runAction(env, callId, name, {
        type: "join_waitlist", patient: text(args, "patient_name", "sample patient", 60), appointmentType: text(args, "appointment_type", "appointment type", 60),
        preferredDate: text(args, "preferred_date", "preferred date", 10), timezone: timezoneArg(args, env),
      });
      return { success: true, waitlist_request: outcome.waitlistItem && { preferred_date: outcome.waitlistItem.preferredDate, appointment_type: outcome.waitlistItem.appointmentType, status: outcome.waitlistItem.status }, message: outcome.message };
    }
    case "check_document_status": {
      const { state } = await loadSnapshot(env);
      const appointment = findAppointment(state, text(args, "booking_reference", "sample booking reference", 20).toUpperCase(), text(args, "sample_patient_name", "sample patient name", 60));
      const documents = state.referrals.filter((item) => item.reference === appointment.reference).map((item) => ({ document: item.document, status: item.status }));
      return {
        success: true, demo: true, appointment_documents: appointment.documents, documents,
        message: documents.length ? "Read back each sample document and its status." : "No sample documents are listed for this booking.",
      };
    }
    default:
      throw new DomainError(400, "unknown_function", "That front-desk function is not available in this demo.");
  }
}

export interface WebhookResult { status: number; body: JsonRecord }

/**
 * Retell only shows the agent the HTTP status for non-2xx responses, not the body. Business outcomes
 * (slot taken, booking not found) are therefore returned as 200 with success=false and a message the agent can
 * act on. Authentication failures stay as 401/403 so nothing is revealed to an unverified caller.
 */
export async function handleRetellFunction(raw: string, signature: string | null, env: Env): Promise<WebhookResult> {
  if (!await verifyRetellSignature(raw, signature, env.RETELL_API_KEY)) return { status: 401, body: { error: { code: "invalid_signature", message: "The voice request could not be verified." } } };
  let body: JsonRecord;
  try { body = JSON.parse(raw) as JsonRecord; } catch { return { status: 400, body: { error: { code: "invalid_json", message: "The voice request was not valid JSON." } } }; }
  const call = (body.call && typeof body.call === "object" ? body.call : {}) as RetellCall;
  if (!isTrustedCall(call, env)) return { status: 403, body: { error: { code: "test_caller_only", message: "This demo only answers its own demo calls and approved test numbers." } } };
  const name = typeof body.name === "string" ? body.name : "";
  const args = (body.args && typeof body.args === "object" && !Array.isArray(body.args) ? body.args : {}) as JsonRecord;
  const callId = typeof call.call_id === "string" && call.call_id.length <= 120 ? call.call_id : "";
  if (!name || !callId) return { status: 400, body: { error: { code: "invalid_request", message: "The voice request is missing its function name or call ID." } } };
  try {
    return { status: 200, body: await tool(name, args, callId, env) };
  } catch (error) {
    if (error instanceof DomainError && error.status < 500) return { status: 200, body: { success: false, error: error.code, message: error.message } };
    console.error(JSON.stringify({ event: "voice_tool_failed", tool: name, code: error instanceof DomainError ? error.code : "internal_error" }));
    return { status: 200, body: { success: false, error: "service_unavailable", message: "I couldn't confirm that with the demo scheduler. Do not say it succeeded; offer a staff follow-up instead." } };
  }
}

export async function handleRetellEvent(raw: string, signature: string | null, env: Env): Promise<WebhookResult> {
  if (!await verifyRetellSignature(raw, signature, env.RETELL_API_KEY)) return { status: 401, body: { error: { code: "invalid_signature", message: "The voice event could not be verified." } } };
  let body: JsonRecord;
  try { body = JSON.parse(raw) as JsonRecord; } catch { return { status: 400, body: { error: { code: "invalid_json", message: "The voice event was not valid JSON." } } }; }
  const call = (body.call && typeof body.call === "object" ? body.call : {}) as RetellCall;
  if (!isTrustedCall(call, env)) return { status: 403, body: { error: { code: "test_caller_only", message: "Only this demo's own calls are accepted." } } };
  const callId = typeof call.call_id === "string" ? call.call_id : "";
  const event = typeof body.event === "string" ? body.event : "";
  if (!callId || callId.length > 120 || !event || event.length > 60) return { status: 400, body: { error: { code: "invalid_request", message: "The voice event is missing required fields." } } };
  if (!configured(env)) return { status: 503, body: { error: { code: "backend_not_configured", message: "The cloud demo has not been connected yet." } } };
  // Store only the opaque call ID and event name: no phone number, transcript, audio, or summary.
  await recordCallEvent(env, callId, event);
  return { status: 200, body: { accepted: true } };
}
