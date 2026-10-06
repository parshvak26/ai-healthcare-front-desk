// Public demo calls: "Call my phone" (Retell create-phone-call from the shared demo number, with the Healthcare
// agent as a one-time override) and "Talk in browser" (Retell create-web-call). Both share one budget.
//
// Order in both routes: validate → write rate limit → Turnstile → make sure the visitor's workspace exists →
// reserve (one SQL function under an advisory lock: suppression, one live call per workspace, phone cooldown,
// per-client and daily budget) → Retell → record the outcome. Only keyed hashes of the phone number and client
// are stored; the number is never logged. The number's own Retell settings are never changed.
import { DomainError, displayPhone, normalizeDemoPhone } from "../../../packages/shared/src/index.ts";
import { buildCallContext } from "./context.ts";
import type { CallChannel, CallCountry } from "./context.ts";
import { RetryLaterError, configured, consumeRateLimit, databaseError, keyedHash, rpc, rpcRow } from "./store.ts";
import type { Env } from "./store.ts";
import { clinicTimezone, ensureWorkspace } from "./workspaces.ts";

export const demoCallSource = "healthcare-web-demo";
export const turnstileAction = "healthcare_demo_call";
const createPhoneCallUrl = "https://api.retellai.com/v2/create-phone-call";
const createWebCallUrl = "https://api.retellai.com/v3/create-web-call";
const getCallUrl = "https://api.retellai.com/v2/get-call/";
const turnstileVerifyUrl = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A call with no call_started this long after it was placed is shown as "unknown" (did the phone ring?). */
const unknownAfterMs = 90_000;
/** Ask Retell's get-call at most this often per call, and not before the call has had a moment to start. */
const statusCheckSeconds = 10;
/** Days a number stays blocked after the person who answered said it was a wrong number. */
export const wrongNumberSuppressionDays = 30;

export interface DemoCallSettings {
  enabled: boolean;
  webEnabled: boolean;
  fromNumber?: string;
  maxCallsPerDay: number;
  maxCallsPerIpPerDay: number;
  phoneCooldownMinutes: number;
  maxCallDurationSeconds: number;
  agentVersion: number | "latest_published";
  eventsUrl?: string;
}

function boundedInteger(value: string | undefined, fallback: number, min: number, max: number) {
  if (value === undefined || value === "") return fallback;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return parsed >= min && parsed <= max ? parsed : null;
}

function agentVersion(value: string | undefined): number | "latest_published" | null {
  if (value === undefined || value === "" || value === "latest_published") return "latest_published";
  return /^\d{1,6}$/.test(value) ? Number(value) : null;
}

function eventsUrl(value: string | undefined): string | undefined | null {
  if (value === undefined || value === "") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Fails closed: any missing or malformed setting turns calls off. Browser calls also need DEMO_WEB_CALLS = "on" and
 * RETELL_EVENTS_URL: without call_started / call_ended events a live browser call would stop blocking the next one
 * after 2 minutes, and the call page could not follow it.
 */
export function demoCallSettings(env: Env): DemoCallSettings {
  const maxCallsPerDay = boundedInteger(env.MAX_CALLS_PER_DAY, 10, 1, 1000);
  const maxCallsPerIpPerDay = boundedInteger(env.MAX_CALLS_PER_IP_PER_DAY, 3, 1, 100);
  const phoneCooldownMinutes = boundedInteger(env.PHONE_COOLDOWN_MINUTES, 30, 1, 1440);
  const maxCallDurationSeconds = boundedInteger(env.MAX_CALL_DURATION_SECONDS, 300, 60, 600);
  const version = agentVersion(env.RETELL_AGENT_VERSION);
  const webhook = eventsUrl(env.RETELL_EVENTS_URL);
  const from = normalizeDemoPhone(env.RETELL_FROM_NUMBER ?? "");
  const enabled = env.DEMO_CALLS === "on"
    && Boolean(env.RETELL_API_KEY && env.TURNSTILE_SECRET_KEY)
    && configured(env)
    && from?.country === "US" && from.e164 === env.RETELL_FROM_NUMBER
    && /^agent_[A-Za-z0-9]{6,64}$/.test(env.RETELL_AGENT_ID ?? "")
    && maxCallsPerDay !== null && maxCallsPerIpPerDay !== null && phoneCooldownMinutes !== null && maxCallDurationSeconds !== null
    && version !== null && webhook !== null;
  return {
    enabled,
    webEnabled: enabled && env.DEMO_WEB_CALLS === "on" && typeof webhook === "string",
    ...(enabled && from ? { fromNumber: from.display } : {}),
    maxCallsPerDay: maxCallsPerDay ?? 10,
    maxCallsPerIpPerDay: maxCallsPerIpPerDay ?? 3,
    phoneCooldownMinutes: phoneCooldownMinutes ?? 30,
    maxCallDurationSeconds: maxCallDurationSeconds ?? 300,
    agentVersion: version ?? "latest_published",
    ...(typeof webhook === "string" ? { eventsUrl: webhook } : {}),
  };
}

function normalizeNumber(value: string) {
  return value.replace(/[^+\d]/g, "");
}

export function isOwnerNumber(e164: string, env: Env) {
  return (env.RETELL_TEST_NUMBERS || "").split(",").map(normalizeNumber).filter(Boolean).includes(e164);
}

/** Keyed hash of a phone number or client, so the stored value cannot be reversed by guessing. */
function hashIdentifier(kind: "phone" | "ip", value: string, env: Env) {
  return keyedHash(env, "demo-call-hash", `${kind}|${value}`);
}

async function verifyTurnstile(env: Env, token: string, remoteIp: string) {
  const form = new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY ?? "", response: token });
  if (remoteIp !== "local") form.set("remoteip", remoteIp);
  let response: Response;
  try {
    response = await fetch(turnstileVerifyUrl, { method: "POST", body: form, signal: AbortSignal.timeout(8_000) });
  } catch {
    throw new DomainError(503, "verification_unavailable", "The security check could not be completed. Please try again.");
  }
  let result: { success?: boolean; hostname?: string; action?: string } = {};
  try { result = await response.json() as typeof result; } catch { /* treated as failed below */ }
  return result.success === true
    && result.hostname === (env.TURNSTILE_HOSTNAME || "parshvak26.github.io")
    && result.action === turnstileAction;
}

/** "+1 (415) 555-0123" → "+1 (•••) •••-0123": enough to recognise your own number, not to read someone else's. */
export function maskPhone(display: string, country: "US" | "IN") {
  const prefix = country === "US" ? "+1" : "+91";
  const rest = display.slice(prefix.length);
  return `${prefix}${rest.slice(0, -4).replace(/\d/g, "•")}${rest.slice(-4)}`;
}

export interface CallRequest {
  body: Record<string, unknown>;
  /** The connecting IP, only for Turnstile. */
  ip: string;
  /** IPv4 address or IPv6 /64: the identity for limits. */
  client: string;
  workspaceId: string;
  /** Cloudflare's view of the visitor's country, when it is one the demo knows. */
  visitorCountry?: CallCountry;
}

function checkFields(body: Record<string, unknown>, allowed: string[]) {
  for (const key of Object.keys(body)) if (!allowed.includes(key)) throw new DomainError(400, "invalid_request", "That call request is not valid.");
  if (body.consent !== true) throw new DomainError(400, "consent_required", "Please agree to receive the AI demo call first.");
  if (body.timezone !== undefined && (typeof body.timezone !== "string" || body.timezone.length > 80)) throw new DomainError(400, "invalid_request", "That call request is not valid.");
  if (typeof body.turnstileToken !== "string" || body.turnstileToken.length < 10 || body.turnstileToken.length > 2048) {
    throw new DomainError(400, "verification_required", "Please complete the security check.");
  }
  return body.turnstileToken;
}

async function passChecks(request: CallRequest, env: Env, token: string) {
  await consumeRateLimit(env, request.client, "write");
  if (!await verifyTurnstile(env, token, request.ip)) throw new DomainError(403, "verification_failed", "The security check did not pass. Please try again.");
}

const refusals: Record<string, { status: number; code: string; message: string }> = {
  phone_suppressed: { status: 403, code: "number_blocked", message: "This number asked not to receive demo calls. You can try Talk in browser instead." },
  call_in_progress: { status: 409, code: "call_in_progress", message: "A demo call is already in progress for this browser. Please wait for it to end." },
  phone_cooldown: { status: 429, code: "phone_cooldown", message: "A demo call was already placed to this number recently. Please try again later." },
  ip_daily_limit: { status: 429, code: "ip_daily_limit", message: "This connection has reached today's demo call limit. Please try again tomorrow." },
  daily_limit: { status: 429, code: "daily_limit", message: "Today's demo calls are used up. Please try again tomorrow." },
};

async function reserve(env: Env, settings: DemoCallSettings, input: {
  requestId: string; channel: CallChannel; workspaceId: string; phoneHash: string | null; client: string; owner: boolean;
}) {
  const row = await rpcRow<{ allowed?: unknown; reason?: unknown; retry_after_seconds?: unknown }>(env, "healthcare_reserve_demo_call_v2", {
    p_request_id: input.requestId,
    p_channel: input.channel,
    p_workspace_id: input.workspaceId,
    p_phone_hash: input.phoneHash,
    p_ip_hash: await hashIdentifier("ip", input.client, env),
    p_owner: input.owner,
    p_phone_cooldown_minutes: settings.phoneCooldownMinutes,
    p_max_calls_per_ip_per_day: settings.maxCallsPerIpPerDay,
    p_max_calls_per_day: settings.maxCallsPerDay,
    p_max_call_seconds: settings.maxCallDurationSeconds,
  });
  if (!row) throw databaseError();
  if (row.allowed === true) return;
  const refusal = refusals[String(row.reason)] ?? { status: 429, code: "rate_limited", message: "Please try again later." };
  throw new RetryLaterError(refusal.status, refusal.code, refusal.message, Number(row.retry_after_seconds) || 60);
}

async function finish(env: Env, requestId: string, status: "placed" | "failed" | "unknown", callId: string | null) {
  try {
    await rpc(env, "healthcare_finish_demo_call_v2", { p_request_id: requestId, p_status: status, p_call_id: callId });
  } catch {
    console.error(JSON.stringify({ event: "demo_call_finish_failed", status }));
  }
}

/** The Retell request parts both channels share: metadata, dynamic variables and the one-call agent override. */
function retellCallParts(settings: DemoCallSettings, input: {
  requestId: string; workspaceId: string; channel: CallChannel; context: ReturnType<typeof buildCallContext>; placedAt: number;
}) {
  return {
    agent_override: {
      agent: {
        max_call_duration_ms: settings.maxCallDurationSeconds * 1000,
        ...(settings.eventsUrl ? { webhook_url: settings.eventsUrl, webhook_events: ["call_started", "call_ended"] } : {}),
      },
      retell_llm: { begin_message: input.context.beginMessage },
    },
    metadata: {
      source: demoCallSource,
      request_id: input.requestId,
      workspace: input.workspaceId,
      channel: input.channel,
      caller_timezone: input.context.callerTimezone,
      placed_at: input.placedAt,
      max_seconds: String(settings.maxCallDurationSeconds),
    },
    retell_llm_dynamic_variables: input.context.dynamicVariables,
  };
}

async function callRetell(env: Env, url: string, body: unknown) {
  try {
    return await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.RETELL_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    // A timeout may still have created the call, so it is recorded as unknown (it counts); a failed connection did not.
    return error instanceof Error && error.name === "TimeoutError" ? "timeout" as const : "unreachable" as const;
  }
}

async function readCreated(response: Response) {
  try {
    const value = await response.json() as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function callIdFrom(created: Record<string, unknown>) {
  return typeof created.call_id === "string" && created.call_id.length >= 1 && created.call_id.length <= 120 ? created.call_id : null;
}

/** Prepares a call for either channel: rate limit, Turnstile, workspace, then the reservation. */
async function prepare(request: CallRequest, env: Env, settings: DemoCallSettings, token: string, input: {
  channel: CallChannel; phoneHash: string | null; owner: boolean; country?: CallCountry;
}) {
  await passChecks(request, env, token);
  const now = Date.now();
  const workspace = await ensureWorkspace(env, request.workspaceId, { kind: "visitor", client: request.client }, now);
  const requestId = crypto.randomUUID();
  await reserve(env, settings, { requestId, channel: input.channel, workspaceId: request.workspaceId, phoneHash: input.phoneHash, client: request.client, owner: input.owner });
  const context = buildCallContext({
    channel: input.channel, country: input.country, requestedTimezone: request.body.timezone, state: workspace.state, now,
    clinicTimezone: clinicTimezone(env), maxSeconds: settings.maxCallDurationSeconds,
  });
  return { requestId, parts: retellCallParts(settings, { requestId, workspaceId: request.workspaceId, channel: input.channel, context, placedAt: now }) };
}

const maxMinutes = (settings: DemoCallSettings) => Math.round(settings.maxCallDurationSeconds / 60);

export async function handlePhoneCall(request: CallRequest, env: Env): Promise<Record<string, unknown>> {
  const settings = demoCallSettings(env);
  if (!settings.enabled) throw new DomainError(503, "demo_calls_off", "Live demo calls are not switched on yet.");
  const token = checkFields(request.body, ["phoneNumber", "consent", "turnstileToken", "timezone"]);
  const phone = normalizeDemoPhone(request.body.phoneNumber);
  if (!phone) throw new DomainError(400, "invalid_phone", "Include the country code: +1 for a US number or +91 for an Indian mobile.");

  const owner = isOwnerNumber(phone.e164, env);
  const { requestId, parts } = await prepare(request, env, settings, token, {
    channel: "phone", phoneHash: await hashIdentifier("phone", phone.e164, env), owner, country: phone.country,
  });
  const response = await callRetell(env, createPhoneCallUrl, {
    from_number: env.RETELL_FROM_NUMBER,
    to_number: phone.e164,
    override_agent_id: env.RETELL_AGENT_ID,
    override_agent_version: settings.agentVersion,
    idempotency_key: requestId,
    ...parts,
  });
  if (response === "timeout" || response === "unreachable") {
    await finish(env, requestId, response === "timeout" ? "unknown" : "failed", null);
    console.error(JSON.stringify({ event: "demo_call_no_answer_from_provider", channel: "phone", outcome: response }));
    throw new DomainError(503, "calls_unavailable", response === "timeout"
      ? "The call service was slow to answer. If your phone rings in the next minute, pick up; otherwise please try again later."
      : "The call service did not answer. Please try again in a minute.");
  }
  if (response.status === 201 || response.status === 200) {
    await finish(env, requestId, "placed", callIdFrom(await readCreated(response)));
    // Never echo the visitor's number in logs; the response only confirms the masked destination.
    console.log(JSON.stringify({ event: "demo_call_placed", channel: "phone", country: phone.country, owner }));
    return {
      status: "calling", callRef: requestId, channel: "phone", country: phone.country, maskedNumber: maskPhone(phone.display, phone.country),
      fromNumber: displayPhone(env.RETELL_FROM_NUMBER ?? ""), maxMinutes: maxMinutes(settings),
    };
  }
  await finish(env, requestId, "failed", null);
  console.error(JSON.stringify({ event: "demo_call_rejected", channel: "phone", status: response.status, country: phone.country }));
  if (response.status === 400 || response.status === 422) {
    throw new DomainError(422, "call_rejected", phone.country === "IN"
      ? "The call service did not accept this Indian number. Calls to India may not be enabled on this demo's phone line yet; try Talk in browser instead."
      : "The call service did not accept this number. Please check it and try again.");
  }
  throw new DomainError(503, "calls_unavailable", "Demo calling is not available right now. Please try again later.");
}

export async function handleWebCall(request: CallRequest, env: Env): Promise<Record<string, unknown>> {
  const settings = demoCallSettings(env);
  if (!settings.enabled) throw new DomainError(503, "demo_calls_off", "Live demo calls are not switched on yet.");
  if (!settings.webEnabled) throw new DomainError(503, "web_calls_off", "Talking in the browser is not switched on right now.");
  const token = checkFields(request.body, ["consent", "turnstileToken", "timezone"]);

  // No owner exemption for browser calls: there is no number to recognise the owner by.
  const { requestId, parts } = await prepare(request, env, settings, token, { channel: "web", phoneHash: null, owner: false, country: request.visitorCountry });
  const response = await callRetell(env, createWebCallUrl, { agent_id: env.RETELL_AGENT_ID, agent_version: settings.agentVersion, ...parts });
  if (response === "timeout" || response === "unreachable") {
    await finish(env, requestId, response === "timeout" ? "unknown" : "failed", null);
    console.error(JSON.stringify({ event: "demo_call_no_answer_from_provider", channel: "web", outcome: response }));
    throw new DomainError(503, "calls_unavailable", "The call service did not answer. Please try again in a minute.");
  }
  if (response.status === 201 || response.status === 200) {
    const created = await readCreated(response);
    const callId = callIdFrom(created);
    const accessToken = typeof created.access_token === "string" && created.access_token.length <= 8192 ? created.access_token : "";
    if (!callId || !accessToken) {
      await finish(env, requestId, "failed", callId);
      console.error(JSON.stringify({ event: "demo_call_unusable_response", channel: "web" }));
      throw new DomainError(503, "calls_unavailable", "The call service did not start the call. Please try again in a minute.");
    }
    await finish(env, requestId, "placed", callId);
    console.log(JSON.stringify({ event: "demo_call_placed", channel: "web" }));
    const transport = typeof created.transport === "string" && /^[a-z_-]{1,20}$/.test(created.transport) ? created.transport : undefined;
    const iceServers = Array.isArray(created.ice_servers) && JSON.stringify(created.ice_servers).length <= 8192 ? created.ice_servers : undefined;
    const expiry = [created.access_token_expiration_timestamp, created.expires_at, created.expiration_timestamp]
      .find((value) => typeof value === "number" || typeof value === "string");
    return {
      callRef: requestId, channel: "web", callId, accessToken, transport, iceServers,
      // The token is short-lived (about 30 seconds); the browser starts the call at once.
      expiresAt: expiry ?? Date.now() + 30_000,
      maxMinutes: maxMinutes(settings),
    };
  }
  await finish(env, requestId, "failed", null);
  console.error(JSON.stringify({ event: "demo_call_rejected", channel: "web", status: response.status }));
  throw new DomainError(503, "calls_unavailable", "Talking in the browser is not available right now. Please try again later.");
}

// ---------- status ----------

export type CallOutcome = "completed" | "time_limit" | "no_answer" | "blocked" | "error";

const outcomes: Record<string, CallOutcome> = {};
for (const reason of ["user_hangup", "agent_hangup", "inactivity", "call_transfer"]) outcomes[reason] = "completed";
outcomes.max_duration_reached = "time_limit";
for (const reason of ["dial_no_answer", "dial_busy", "user_declined", "voicemail_reached", "ivr_reached", "error_user_not_joined", "registered_call_timeout"]) outcomes[reason] = "no_answer";
for (const reason of ["telephony_provider_permission_denied", "invalid_destination", "dial_failed", "marked_as_spam", "network_blocked", "user_requested_dnc", "scam_detected"]) outcomes[reason] = "blocked";

/** Outcome shown on the call page for Retell's disconnection_reason. */
export function callOutcome(reason: unknown): CallOutcome {
  return typeof reason === "string" && Object.hasOwn(outcomes, reason) ? outcomes[reason] : "error";
}

export function isRequestId(value: unknown): value is string {
  return typeof value === "string" && uuidPattern.test(value);
}

/** Retell's disconnection_reason, if it has the expected shape (it is stored). */
export function reasonCode(value: unknown) {
  return typeof value === "string" && /^[a-z_]{1,60}$/.test(value) ? value : null;
}

function millis(value: unknown) {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const ms = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

function isoOrNull(value: unknown) {
  const ms = millis(value);
  return ms === undefined ? null : new Date(ms).toISOString();
}

export async function recordCallEvent(env: Env, input: { callId: string; event: "call_started" | "call_ended"; detail: string | null; requestId: string | null; at: unknown }) {
  await rpc(env, "healthcare_record_retell_call_event_v2", {
    p_call_id: input.callId, p_event: input.event, p_detail: input.detail, p_request_id: input.requestId, p_occurred_at: isoOrNull(input.at),
  });
}

interface StatusRow {
  channel?: unknown; status?: unknown; retell_call_id?: unknown; placed_at?: unknown; started_at?: unknown; ended_at?: unknown;
  end_reason?: unknown; tool_log?: unknown; released_at?: unknown;
}

const readStatus = (env: Env, requestId: string, workspaceId: string) =>
  rpcRow<StatusRow>(env, "healthcare_demo_call_status", { p_request_id: requestId, p_workspace_id: workspaceId });

/** Asks Retell about a call no event has finished yet, and stores what it says as events. */
async function checkWithRetell(env: Env, requestId: string, callId: string) {
  let response: Response;
  try {
    response = await fetch(`${getCallUrl}${encodeURIComponent(callId)}`, {
      headers: { Authorization: `Bearer ${env.RETELL_API_KEY}` }, signal: AbortSignal.timeout(5_000),
    });
  } catch {
    return false;
  }
  if (!response.ok) return false;
  const call = await readCreated(response);
  const metadata = call.metadata && typeof call.metadata === "object" ? call.metadata as Record<string, unknown> : {};
  if (call.call_id !== callId || metadata.request_id !== requestId) return false;
  let recorded = false;
  if (millis(call.start_timestamp) !== undefined) {
    await recordCallEvent(env, { callId, event: "call_started", detail: null, requestId, at: call.start_timestamp });
    recorded = true;
  }
  if (call.call_status === "ended" || call.call_status === "error" || call.call_status === "not_connected") {
    await recordCallEvent(env, { callId, event: "call_ended", detail: reasonCode(call.disconnection_reason), requestId, at: call.end_timestamp });
    recorded = true;
  }
  return recorded;
}

function toolLog(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is { tool: string; ms: number; ok: boolean } => Boolean(item && typeof item === "object"
    && typeof (item as Record<string, unknown>).tool === "string" && typeof (item as Record<string, unknown>).ms === "number"
    && typeof (item as Record<string, unknown>).ok === "boolean")).map(({ tool, ms, ok }) => ({ tool, ms, ok }));
}

/** Call status for the call page. The reference must belong to the visitor's workspace; otherwise 404. */
export async function callStatus(env: Env, workspaceId: string, ref: unknown, now = Date.now()): Promise<Record<string, unknown>> {
  const notFound = () => new DomainError(404, "not_found", "That demo call was not found.");
  if (!isRequestId(ref)) throw notFound();
  let row = await readStatus(env, ref, workspaceId);
  if (!row) throw notFound();
  const placedAt = millis(row.placed_at) ?? now;
  const callId = typeof row.retell_call_id === "string" ? row.retell_call_id : null;

  // Fallback when no event has finished the call yet (for example, the per-call webhook did not arrive).
  if (callId && row.status !== "failed" && millis(row.ended_at) === undefined && now - placedAt >= statusCheckSeconds * 1000 && env.RETELL_API_KEY) {
    const claimed = await rpc(env, "healthcare_claim_demo_call_status_check", { p_request_id: ref, p_workspace_id: workspaceId, p_min_seconds: statusCheckSeconds });
    if (claimed === true && await checkWithRetell(env, ref, callId)) row = await readStatus(env, ref, workspaceId) ?? row;
  }

  const channel = row.channel === "web" ? "web" : "phone";
  const startedAt = millis(row.started_at);
  const endedAt = millis(row.ended_at);
  let phase: "ringing" | "connecting" | "live" | "ended" | "unknown";
  let outcome: CallOutcome | undefined;
  if (endedAt !== undefined) {
    phase = "ended";
    outcome = callOutcome(row.end_reason);
  } else if (startedAt !== undefined) {
    phase = "live";
  } else if (row.status === "failed" || millis(row.released_at) !== undefined) {
    // Retell refused the call, or the browser gave up before connecting.
    phase = "ended";
    outcome = "error";
  } else if (now - placedAt > unknownAfterMs) {
    phase = "unknown";
  } else {
    phase = channel === "phone" ? "ringing" : "connecting";
  }
  return {
    callRef: ref, channel, phase, ...(outcome ? { outcome } : {}), placedAt,
    ...(startedAt !== undefined ? { startedAt } : {}), ...(endedAt !== undefined ? { endedAt } : {}),
    maxMinutes: maxMinutes(demoCallSettings(env)), tools: toolLog(row.tool_log),
  };
}

/**
 * For a browser call whose browser could not connect: the visitor may start another call straight away, but the
 * released call still counts towards the budget (its access token could still be used). Refused once it started.
 */
export async function releaseCall(env: Env, workspaceId: string, ref: unknown) {
  if (!isRequestId(ref)) throw new DomainError(400, "invalid_request", "That call reference is not valid.");
  const released = await rpc(env, "healthcare_release_demo_call", { p_request_id: ref, p_workspace_id: workspaceId });
  if (typeof released !== "boolean") throw databaseError();
  return { released };
}
