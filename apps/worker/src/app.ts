// HTTP routes and the reminder job for the synthetic AI Healthcare Front Desk demo Worker.
// The shared snapshot is changed only through validated front-desk actions; there is no whole-state write route.
import {
  DomainError, applyDemoAction, buildAvailability, faqEntries, parseDemoAction, processDueMessages,
} from "../../../packages/shared/src/index.ts";
import { demoCallSettings, handleDemoCallRequest } from "./calls.ts";
import { handleRetellEvent, handleRetellFunction, maxFunctionBodyBytes } from "./retell.ts";
import type { WebhookResult } from "./retell.ts";
import { configured, consumeRateLimit, loadSnapshot, mutateSnapshot, pingDatabase } from "./store.ts";
import type { Env } from "./store.ts";

export type { Env } from "./store.ts";

/** Bumped when the browser needs routes that older Workers do not have. The web app checks it before using cloud mode. */
export const apiVersion = 2;
const maxJsonBytes = 16_384;
const idempotencyKeyPattern = /^[A-Za-z0-9_-]{8,100}$/;

function originAllowed(request: Request, env: Env) {
  const origin = request.headers.get("Origin");
  if (!origin) return true;
  const allowed = (env.PUBLIC_ORIGINS || "http://localhost:5173").split(",").map((item) => item.trim()).filter(Boolean);
  return allowed.includes(origin);
}

function headersFor(request: Request, env: Env, requestId: string) {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Request-Id": requestId,
    Vary: "Origin",
  });
  const origin = request.headers.get("Origin");
  if (origin && originAllowed(request, env)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
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

async function readBody(request: Request, limit: number) {
  if (Number(request.headers.get("Content-Length") || "0") > limit) throw new DomainError(413, "request_too_large", "That request is too large for the demo.");
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > limit) throw new DomainError(413, "request_too_large", "That request is too large for the demo.");
  return raw;
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const raw = await readBody(request, maxJsonBytes);
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
    return value as Record<string, unknown>;
  } catch {
    throw new DomainError(400, "invalid_json", "Please send valid JSON for the demo request.");
  }
}

function clientIp(request: Request) {
  return request.headers.get("CF-Connecting-IP") || "local";
}

async function handleAction(request: Request, env: Env) {
  if (!configured(env)) throw new DomainError(503, "backend_not_configured", "The cloud demo has not been connected yet.");
  await consumeRateLimit(env, clientIp(request), "write");
  const body = await readJson(request);
  const key = body.idempotencyKey;
  if (typeof key !== "string" || !idempotencyKeyPattern.test(key)) throw new DomainError(400, "invalid_idempotency_key", "Each demo change needs a request ID.");
  const action = parseDemoAction(body.action);
  const { snapshot, value } = await mutateSnapshot(env, (state) => {
    const outcome = applyDemoAction(state, action, { now: Date.now(), channel: "Staff console", key: `web|${key}`, random: Math.random, seedTimezone: env.CLINIC_TIMEZONE });
    return { state: outcome.state, changed: outcome.changed, value: outcome };
  });
  return {
    state: snapshot.state,
    revision: snapshot.revision,
    result: { changed: value.changed, message: value.message, appointment: value.appointment, waitlistItem: value.waitlistItem, task: value.task },
  };
}

export async function fetchHandler(request: Request, env: Env): Promise<Response> {
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
        try { await pingDatabase(env); databaseConnected = true; } catch { /* Health stays generic and never exposes provider details. */ }
      }
      // SMS is hard-wired off. Outbound demo calls exist only when every call setting is present (see calls.ts).
      const calls = demoCallSettings(env);
      return reply(request, env, requestId, 200, {
        ok: true, mode: "synthetic-demo", apiVersion, databaseConnected, liveCallsEnabled: calls.enabled, liveSmsEnabled: false,
        demoCalls: calls.enabled
          ? { enabled: true, countries: ["US", "IN"], fromNumber: calls.fromNumber, maxMinutes: Math.round(calls.maxCallDurationSeconds / 60), maxCallsPerDay: calls.maxCallsPerDay }
          : { enabled: false },
        requestId,
      });
    }

    if (url.pathname.startsWith("/webhooks/retell/") && request.method === "POST") {
      const raw = await readBody(request, maxFunctionBodyBytes);
      const signature = request.headers.get("X-Retell-Signature");
      let result: WebhookResult;
      if (url.pathname === "/webhooks/retell/custom-function") result = await handleRetellFunction(raw, signature, env);
      else if (url.pathname === "/webhooks/retell/events") result = await handleRetellEvent(raw, signature, env);
      else return reply(request, env, requestId, 404, problem("not_found", "That demo endpoint does not exist."));
      return reply(request, env, requestId, result.status, result.body);
    }

    if (url.pathname.startsWith("/api/") && !originAllowed(request, env)) return reply(request, env, requestId, 403, problem("origin_not_allowed", "This website is not allowed to use the demo API."));

    if (url.pathname === "/api/demo/state" && request.method === "GET") {
      await consumeRateLimit(env, clientIp(request), "read");
      return reply(request, env, requestId, 200, await loadSnapshot(env));
    }
    if (url.pathname === "/api/demo/actions" && request.method === "POST") {
      return reply(request, env, requestId, 200, await handleAction(request, env));
    }
    if (url.pathname === "/api/demo-call" && request.method === "POST") {
      const result = await handleDemoCallRequest(await readJson(request), clientIp(request), env);
      const response = reply(request, env, requestId, result.status, result.body);
      if (result.retryAfter) response.headers.set("Retry-After", String(result.retryAfter));
      return response;
    }
    if (url.pathname === "/api/appointments/availability" && request.method === "POST") {
      await consumeRateLimit(env, clientIp(request), "read");
      const body = await readJson(request);
      const { state } = await loadSnapshot(env);
      const slots = buildAvailability(state, {
        date: String(body.date ?? ""), appointmentType: String(body.appointmentType ?? ""), timezone: String(body.timezone ?? ""), now: Date.now(),
        ignoreAppointmentId: typeof body.ignoreAppointmentId === "string" ? body.ignoreAppointmentId : undefined,
      });
      return reply(request, env, requestId, 200, { slots, timezone: body.timezone, demo: true });
    }
    if (url.pathname === "/api/faqs" && request.method === "GET") {
      await consumeRateLimit(env, clientIp(request), "read");
      const query = (url.searchParams.get("q") || "").toLowerCase().slice(0, 120);
      const entries = faqEntries.filter((entry) => !query || `${entry.category} ${entry.question} ${entry.answer}`.toLowerCase().includes(query));
      return reply(request, env, requestId, 200, { entries, demo: true });
    }
    if (url.pathname === "/api/demo/state" && request.method === "PUT") {
      // Retired in API v2: clients may no longer overwrite the shared schedule wholesale.
      return reply(request, env, requestId, 410, problem("route_retired", "Reload the page to use the updated demo."));
    }
    return reply(request, env, requestId, 404, problem("not_found", "That demo endpoint does not exist."));
  } catch (error) {
    if (error instanceof DomainError) return reply(request, env, requestId, error.status, problem(error.code, error.message));
    // Keep logs useful without writing request contents, caller details, or provider secrets.
    console.error(JSON.stringify({ event: "request_failed", requestId, path: url.pathname }));
    return reply(request, env, requestId, 500, problem("internal_error", "The demo could not complete that request. Please try again."));
  }
}

/** Simulated reminder job: marks due texts delivered, suppressed, or cancelled. It never contacts a provider. */
export async function processDemoReminders(env: Env, now = Date.now()) {
  if (!configured(env)) return { changed: false };
  const { value } = await mutateSnapshot(env, (state) => {
    const result = processDueMessages(state, now);
    return { state: result.state, changed: result.changed, value: result.changed };
  });
  return { changed: value };
}
