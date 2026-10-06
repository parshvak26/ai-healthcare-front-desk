// HTTP routes and the retention job for the synthetic AI Healthcare Front Desk demo Worker.
// Each visitor has a private copy of the fictional clinic, changed only through validated front-desk actions; there
// is no whole-state write route.
import { DomainError, applyDemoAction, buildAvailability, faqEntries, parseDemoAction } from "../../../packages/shared/src/index.ts";
import { callStatus, demoCallSettings, handlePhoneCall, handleWebCall, releaseCall } from "./calls.ts";
import type { CallRequest } from "./calls.ts";
import type { CallCountry } from "./context.ts";
import { handleRetellEvent, handleRetellFunction, maxEventBodyBytes, maxFunctionBodyBytes } from "./retell.ts";
import type { WebhookResult } from "./retell.ts";
import { RetryLaterError, clientKey, configured, consumeRateLimit, notConfigured, pingDatabase, rpcRow } from "./store.ts";
import type { Env, ExecutionContextLike } from "./store.ts";
import { forgetWorkspace, loadWorkspace, mutateWorkspace, readWorkspace, retentionDays, visitorHeader, visitorWorkspaceId } from "./workspaces.ts";

export type { Env, ExecutionContextLike } from "./store.ts";

/** Bumped when the browser needs routes that older Workers do not have. The web app checks it before using cloud mode. */
export const apiVersion = 3;
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
    headers.set("Access-Control-Allow-Headers", `Content-Type, X-Request-Id, ${visitorHeader}`);
    headers.set("Access-Control-Expose-Headers", "Retry-After, X-Request-Id");
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

/** Cloudflare's country for the request, when it is one the demo has emergency numbers for. */
function visitorCountry(request: Request): CallCountry | undefined {
  const country = (request as Request & { cf?: { country?: unknown } }).cf?.country;
  return country === "US" || country === "IN" ? country : undefined;
}

/** "?known=<generation>.<revision>" from a browser that already has that copy. */
function knownVersion(url: URL) {
  const match = /^(\d{1,16})\.(\d{1,16})$/.exec(url.searchParams.get("known") ?? "");
  return match ? { generation: Number(match[1]), revision: Number(match[2]) } : null;
}

async function handleAction(request: Request, env: Env, workspaceId: string, client: string) {
  await consumeRateLimit(env, client, "write");
  const body = await readJson(request);
  const key = body.idempotencyKey;
  if (typeof key !== "string" || !idempotencyKeyPattern.test(key)) throw new DomainError(400, "invalid_idempotency_key", "Each demo change needs a request ID.");
  const action = parseDemoAction(body.action);
  const now = Date.now();
  const { workspace, value } = await mutateWorkspace(env, workspaceId, (state) => {
    const outcome = applyDemoAction(state, action, { now, channel: "Staff console", key: `web|${key}`, random: Math.random, seedTimezone: env.CLINIC_TIMEZONE });
    return { state: outcome.state, changed: outcome.changed, value: outcome };
  }, { kind: "visitor", client }, now);
  return {
    state: workspace.state, revision: workspace.revision, generation: workspace.generation, persisted: workspace.persisted,
    result: { changed: value.changed, message: value.message, appointment: value.appointment, waitlistItem: value.waitlistItem, task: value.task },
  };
}

async function visitorRoute(request: Request, env: Env, url: URL): Promise<{ status?: number; body: unknown } | null> {
  const routes: Record<string, string> = {
    "GET /api/demo/state": "state", "POST /api/demo/actions": "actions", "POST /api/appointments/availability": "availability",
    "POST /api/demo/forget": "forget", "POST /api/demo-call": "phone", "POST /api/demo-web-call": "web",
    "GET /api/demo-call/status": "status", "POST /api/demo-call/release": "release",
  };
  const route = routes[`${request.method} ${url.pathname}`];
  if (!route) return null;
  if (!configured(env)) throw notConfigured();
  const workspaceId = await visitorWorkspaceId(env, request);
  const client = clientKey(clientIp(request));
  switch (route) {
    case "state":
      await consumeRateLimit(env, client, "read");
      return { body: await readWorkspace(env, workspaceId, knownVersion(url)) };
    case "actions":
      return { body: await handleAction(request, env, workspaceId, client) };
    case "availability": {
      await consumeRateLimit(env, client, "read");
      const body = await readJson(request);
      const { state } = await loadWorkspace(env, workspaceId);
      const slots = buildAvailability(state, {
        date: String(body.date ?? ""), appointmentType: String(body.appointmentType ?? ""), timezone: String(body.timezone ?? ""), now: Date.now(),
        ignoreAppointmentId: typeof body.ignoreAppointmentId === "string" ? body.ignoreAppointmentId : undefined,
      });
      return { body: { slots, timezone: body.timezone, demo: true } };
    }
    case "forget":
      await consumeRateLimit(env, client, "write");
      await forgetWorkspace(env, workspaceId, demoCallSettings(env).maxCallDurationSeconds);
      return { body: { deleted: true } };
    case "phone":
    case "web": {
      const input: CallRequest = { body: await readJson(request), ip: clientIp(request), client, workspaceId, visitorCountry: visitorCountry(request) };
      return { body: route === "phone" ? await handlePhoneCall(input, env) : await handleWebCall(input, env) };
    }
    case "status":
      await consumeRateLimit(env, client, "read");
      return { body: await callStatus(env, workspaceId, url.searchParams.get("ref")) };
    case "release": {
      await consumeRateLimit(env, client, "write");
      const body = await readJson(request);
      return { body: await releaseCall(env, workspaceId, body.callRef) };
    }
    default:
      return null;
  }
}

export async function fetchHandler(request: Request, env: Env, context?: ExecutionContextLike): Promise<Response> {
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
      // SMS is hard-wired off. Demo calls exist only when every call setting is present (see calls.ts).
      const calls = demoCallSettings(env);
      return reply(request, env, requestId, 200, {
        ok: true, mode: "synthetic-demo", apiVersion, databaseConnected, liveCallsEnabled: calls.enabled, liveSmsEnabled: false,
        demoCalls: calls.enabled
          ? {
            enabled: true, countries: ["US", "IN"], fromNumber: calls.fromNumber, maxMinutes: Math.round(calls.maxCallDurationSeconds / 60),
            maxCallsPerDay: calls.maxCallsPerDay, web: { enabled: calls.webEnabled },
          }
          : { enabled: false, web: { enabled: false } },
        privateDemo: { retentionDays },
        requestId,
      });
    }

    if (url.pathname.startsWith("/webhooks/retell/") && request.method === "POST") {
      const isEvent = url.pathname === "/webhooks/retell/events";
      if (!isEvent && url.pathname !== "/webhooks/retell/custom-function") return reply(request, env, requestId, 404, problem("not_found", "That demo endpoint does not exist."));
      const raw = await readBody(request, isEvent ? maxEventBodyBytes : maxFunctionBodyBytes);
      const signature = request.headers.get("X-Retell-Signature");
      const result: WebhookResult = isEvent ? await handleRetellEvent(raw, signature, env, context) : await handleRetellFunction(raw, signature, env, context);
      return reply(request, env, requestId, result.status, result.body);
    }

    if (url.pathname.startsWith("/api/") && !originAllowed(request, env)) return reply(request, env, requestId, 403, problem("origin_not_allowed", "This website is not allowed to use the demo API."));

    if (url.pathname === "/api/demo/state" && request.method === "PUT") {
      // Retired in API v2: clients may no longer overwrite a schedule wholesale.
      return reply(request, env, requestId, 410, problem("route_retired", "Reload the page to use the updated demo."));
    }
    if (url.pathname === "/api/faqs" && request.method === "GET") {
      if (configured(env)) await consumeRateLimit(env, clientKey(clientIp(request)), "read");
      const query = (url.searchParams.get("q") || "").toLowerCase().slice(0, 120);
      const entries = faqEntries.filter((entry) => !query || `${entry.category} ${entry.question} ${entry.answer}`.toLowerCase().includes(query));
      return reply(request, env, requestId, 200, { entries, demo: true });
    }
    const handled = await visitorRoute(request, env, url);
    if (handled) return reply(request, env, requestId, handled.status ?? 200, handled.body);
    return reply(request, env, requestId, 404, problem("not_found", "That demo endpoint does not exist."));
  } catch (error) {
    if (error instanceof RetryLaterError) {
      const response = reply(request, env, requestId, error.status, { ...problem(error.code, error.message), retryAfterSeconds: error.retryAfter });
      response.headers.set("Retry-After", String(error.retryAfter));
      return response;
    }
    if (error instanceof DomainError) return reply(request, env, requestId, error.status, problem(error.code, error.message));
    // Keep logs useful without writing request contents, caller details, or provider secrets.
    console.error(JSON.stringify({ event: "request_failed", requestId, path: url.pathname }));
    return reply(request, env, requestId, 500, problem("internal_error", "The demo could not complete that request. Please try again."));
  }
}

/**
 * Retention job (cron): deletes workspaces unused for 7 days, old call events, and the call rows' links and phone
 * hashes on schedule. The reminder simulation no longer needs a job: it runs on every read and write.
 */
export async function purgeDemoData(env: Env) {
  if (!configured(env)) return null;
  const row = await rpcRow<Record<string, unknown>>(env, "healthcare_purge_demo_data", {});
  const counts = {
    workspaces: Number(row?.workspaces_deleted) || 0, callEvents: Number(row?.call_events_deleted) || 0,
    callLinks: Number(row?.call_links_cleared) || 0, phoneHashes: Number(row?.phone_hashes_cleared) || 0,
    callRequests: Number(row?.call_requests_deleted) || 0,
  };
  console.log(JSON.stringify({ event: "demo_data_purged", ...counts }));
  return counts;
}
