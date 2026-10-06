// Public "Call me" demo calls, following the HVAC site's pattern: the visitor gives a US or Indian number and
// explicit consent, passes Cloudflare Turnstile, and the Worker asks Retell to call them from the shared demo
// number with the Healthcare agent as a one-time override. The number's own Retell settings are never changed.
//
// Cost and abuse controls: a global daily cap, a per-IP daily cap, a per-number cooldown, a per-call duration cap,
// and the general write rate limit. Allowlisted owner numbers (RETELL_TEST_NUMBERS) skip the daily caps and
// cooldown. Only salted hashes of the phone number and IP are stored; the number is never logged.
import { DomainError, displayPhone, normalizeDemoPhone } from "../../../packages/shared/src/index.ts";
import { configured, consumeRateLimit, rpc } from "./store.ts";
import type { Env } from "./store.ts";

export const demoCallSource = "healthcare-web-demo";
export const turnstileAction = "healthcare_demo_call";
const createPhoneCallUrl = "https://api.retellai.com/v2/create-phone-call";
const turnstileVerifyUrl = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const encoder = new TextEncoder();

export interface DemoCallSettings {
  enabled: boolean;
  fromNumber?: string;
  maxCallsPerDay: number;
  maxCallsPerIpPerDay: number;
  phoneCooldownMinutes: number;
  maxCallDurationSeconds: number;
}

function boundedInteger(value: string | undefined, fallback: number, min: number, max: number) {
  if (value === undefined || value === "") return fallback;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return parsed >= min && parsed <= max ? parsed : null;
}

/** Fails closed: any missing or malformed setting turns the feature off. */
export function demoCallSettings(env: Env): DemoCallSettings {
  const maxCallsPerDay = boundedInteger(env.MAX_CALLS_PER_DAY, 10, 1, 1000);
  const maxCallsPerIpPerDay = boundedInteger(env.MAX_CALLS_PER_IP_PER_DAY, 3, 1, 100);
  const phoneCooldownMinutes = boundedInteger(env.PHONE_COOLDOWN_MINUTES, 30, 1, 1440);
  const maxCallDurationSeconds = boundedInteger(env.MAX_CALL_DURATION_SECONDS, 300, 60, 600);
  const from = normalizeDemoPhone(env.RETELL_FROM_NUMBER ?? "");
  const enabled = env.DEMO_CALLS === "on"
    && Boolean(env.RETELL_API_KEY && env.TURNSTILE_SECRET_KEY)
    && configured(env)
    && from?.country === "US" && from.e164 === env.RETELL_FROM_NUMBER
    && /^agent_[A-Za-z0-9]{6,64}$/.test(env.RETELL_AGENT_ID ?? "")
    && maxCallsPerDay !== null && maxCallsPerIpPerDay !== null && phoneCooldownMinutes !== null && maxCallDurationSeconds !== null;
  return {
    enabled,
    ...(enabled && from ? { fromNumber: from.display } : {}),
    maxCallsPerDay: maxCallsPerDay ?? 10,
    maxCallsPerIpPerDay: maxCallsPerIpPerDay ?? 3,
    phoneCooldownMinutes: phoneCooldownMinutes ?? 30,
    maxCallDurationSeconds: maxCallDurationSeconds ?? 300,
  };
}

function normalizeNumber(value: string) {
  return value.replace(/[^+\d]/g, "");
}

export function isOwnerNumber(e164: string, env: Env) {
  return (env.RETELL_TEST_NUMBERS || "").split(",").map(normalizeNumber).filter(Boolean).includes(e164);
}

async function hashIdentifier(kind: string, value: string, env: Env) {
  // Keyed hash so the stored values cannot be reversed by guessing numbers. The key never leaves the Worker.
  const key = await crypto.subtle.importKey("raw", encoder.encode(`${env.SUPABASE_SECRET_KEY}|demo-call-hash`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(`${kind}|${value}`));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
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

const limitMessages: Record<string, string> = {
  phone_cooldown: "A demo call was already placed to this number recently. Please try again later.",
  ip_daily_limit: "This connection has reached today's demo call limit. Please try again tomorrow.",
  daily_limit: "Today's demo calls are used up. Please try again tomorrow.",
};

async function finish(env: Env, requestId: string, status: "placed" | "failed", callId: string | null) {
  try {
    await rpc(env, "healthcare_finish_demo_call", { p_request_id: requestId, p_status: status, p_call_id: callId });
  } catch {
    console.error(JSON.stringify({ event: "demo_call_finish_failed", status }));
  }
}

/** "+1 (415) 555-0123" → "+1 (•••) •••-0123": enough to recognise your own number, not to read someone else's. */
export function maskPhone(display: string, country: "US" | "IN") {
  const prefix = country === "US" ? "+1" : "+91";
  const rest = display.slice(prefix.length);
  return `${prefix}${rest.slice(0, -4).replace(/\d/g, "•")}${rest.slice(-4)}`;
}

export interface DemoCallResult { status: number; body: Record<string, unknown>; retryAfter?: number }

export async function handleDemoCallRequest(body: Record<string, unknown>, clientIp: string, env: Env): Promise<DemoCallResult> {
  const settings = demoCallSettings(env);
  if (!settings.enabled) throw new DomainError(503, "demo_calls_off", "Live demo calls are not switched on yet.");
  for (const key of Object.keys(body)) {
    if (!["phoneNumber", "consent", "turnstileToken"].includes(key)) throw new DomainError(400, "invalid_request", "That call request is not valid.");
  }
  if (body.consent !== true) throw new DomainError(400, "consent_required", "Please agree to receive the AI demo call first.");
  const phone = normalizeDemoPhone(body.phoneNumber);
  if (!phone) throw new DomainError(400, "invalid_phone", "Include the country code: +1 for a US number or +91 for an Indian mobile.");
  if (typeof body.turnstileToken !== "string" || body.turnstileToken.length < 10 || body.turnstileToken.length > 2048) {
    throw new DomainError(400, "verification_required", "Please complete the security check.");
  }
  await consumeRateLimit(env, clientIp, "write");
  if (!await verifyTurnstile(env, body.turnstileToken, clientIp)) {
    throw new DomainError(403, "verification_failed", "The security check did not pass. Please try again.");
  }

  const owner = isOwnerNumber(phone.e164, env);
  const requestId = crypto.randomUUID();
  const reservation = await rpc(env, "healthcare_reserve_demo_call", {
    p_request_id: requestId,
    p_phone_hash: await hashIdentifier("phone", phone.e164, env),
    p_ip_hash: await hashIdentifier("ip", clientIp, env),
    p_owner: owner,
    p_phone_cooldown_minutes: settings.phoneCooldownMinutes,
    p_max_calls_per_ip_per_day: settings.maxCallsPerIpPerDay,
    p_max_calls_per_day: settings.maxCallsPerDay,
  });
  const row = Array.isArray(reservation) ? reservation[0] as { allowed?: boolean; reason?: string; retry_after_seconds?: number } | undefined : undefined;
  if (!row) throw new DomainError(502, "database_error", "The demo database could not complete that request.");
  if (!row.allowed) {
    const retryAfter = Math.max(1, Math.min(86_400, Number(row.retry_after_seconds) || 60));
    return { status: 429, retryAfter, body: { error: { code: row.reason || "rate_limited", message: limitMessages[row.reason ?? ""] ?? "Please try again later." }, retryAfterSeconds: retryAfter } };
  }

  let response: Response;
  try {
    response = await fetch(createPhoneCallUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.RETELL_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from_number: env.RETELL_FROM_NUMBER,
        to_number: phone.e164,
        override_agent_id: env.RETELL_AGENT_ID,
        override_agent_version: "latest_published",
        agent_override: { agent: { max_call_duration_ms: settings.maxCallDurationSeconds * 1000 } },
        idempotency_key: requestId,
        metadata: { source: demoCallSource, request_id: requestId },
        retell_llm_dynamic_variables: { call_origin: "outbound web demo request" },
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    await finish(env, requestId, "failed", null);
    throw new DomainError(503, "calls_unavailable", "The call service did not answer. Please try again in a minute.");
  }

  if (response.status === 201 || response.status === 200) {
    let callId: string | null = null;
    try { const created = await response.json() as { call_id?: unknown }; callId = typeof created.call_id === "string" && created.call_id.length <= 128 ? created.call_id : null; } catch { /* ignore */ }
    await finish(env, requestId, "placed", callId);
    // Never echo the visitor's number back in logs; the response only confirms the masked destination.
    console.log(JSON.stringify({ event: "demo_call_placed", country: phone.country, owner }));
    return {
      status: 200,
      body: { status: "calling", country: phone.country, maskedNumber: maskPhone(phone.display, phone.country), fromNumber: displayPhone(env.RETELL_FROM_NUMBER ?? ""), maxMinutes: Math.round(settings.maxCallDurationSeconds / 60) },
    };
  }

  await finish(env, requestId, "failed", null);
  console.error(JSON.stringify({ event: "demo_call_rejected", status: response.status, country: phone.country }));
  if (response.status === 400 || response.status === 422) {
    throw new DomainError(422, "call_rejected", phone.country === "IN"
      ? "The call service did not accept this Indian number. Calls to India may need to be enabled in Retell; a US number should work."
      : "The call service did not accept this number. Please check it and try again.");
  }
  throw new DomainError(503, "calls_unavailable", "Demo calling is not available right now. Please try again later.");
}
