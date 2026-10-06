// Two interchangeable back ends for the demo:
// - the cloud back end talks to the Cloudflare Worker (API v3), which keeps one private demo clinic per visitor key;
// - the local back end runs the same shared rules in the browser when no Worker is configured, reachable or current.
// Either way the UI updates only from the back end's answer, so it never shows a change that was not saved.
// The local back end is in localBackend.ts and loaded only when needed, so the call page ships less JavaScript.
import type { Appointment, AvailabilitySlot, DemoAction, DemoSnapshot, FollowUpTask, WaitlistItem } from "../types";
import { getVisitorKey } from "./visitor";

export const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL || "").trim().replace(/\/$/, "");
/** The Worker API version this website needs (see docs/plans/call-page-contract.md). */
export const requiredApiVersion = 3;

/** A demo snapshot plus the workspace generation (changes when the private demo is recreated) and whether it is stored. */
export interface Snapshot extends DemoSnapshot {
  generation: number;
  persisted: boolean;
}

export interface Unchanged {
  unchanged: true;
  generation: number;
  revision: number;
}

export interface ActionResponse extends Snapshot {
  result: { changed: boolean; message: string; appointment?: Appointment; waitlistItem?: WaitlistItem; task?: FollowUpTask };
}

export interface AvailabilityQuery {
  date: string;
  appointmentType: string;
  timezone: string;
  ignoreAppointmentId?: string;
}

export interface DemoBackend {
  kind: "cloud" | "local";
  /** With `known`, the cloud answers `{unchanged:true}` instead of shipping the same state again. */
  load(known?: { generation: number; revision: number }): Promise<Snapshot | Unchanged>;
  perform(action: DemoAction, idempotencyKey: string): Promise<ActionResponse>;
  availability(query: AvailabilityQuery): Promise<AvailabilitySlot[]>;
  /** Deletes this visitor's private demo. */
  forget(): Promise<void>;
}

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;
  /** True when the request may have reached the server, so the outcome is unknown until the page refreshes. */
  readonly uncertain: boolean;
  readonly retryAfterSeconds?: number;
  constructor(status: number, code: string, message: string, uncertain = false, retryAfterSeconds?: number) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.code = code;
    this.uncertain = uncertain;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export function newIdempotencyKey() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** The viewer's own IANA time zone, e.g. "Asia/Kolkata". */
export function viewerTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

// Old open tabs get 409 reload_required once the Worker changes underneath them. The page shows one "Reload" prompt.
const reloadListeners = new Set<() => void>();
export function onReloadRequired(listener: () => void) {
  reloadListeners.add(listener);
  return () => { reloadListeners.delete(listener); };
}

async function request<T>(path: string, init: RequestInit & { visitor?: boolean } = {}, timeoutMs = 12_000): Promise<T> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  const write = (init.method || "GET") !== "GET";
  const { visitor = true, ...rest } = init;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (rest.body) headers["Content-Type"] = "application/json";
  if (visitor) headers["X-Demo-Visitor"] = getVisitorKey();
  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl}${path}`, { ...rest, signal: controller.signal, headers });
  } catch {
    throw new ApiRequestError(0, "network_error", write
      ? "The demo server did not answer. The change may or may not have been saved, so the page will refresh."
      : "The demo server did not answer. Please try again.", write);
  } finally {
    window.clearTimeout(timer);
  }
  let body: unknown = null;
  try { body = await response.json(); } catch { /* handled below */ }
  if (!response.ok) {
    const payload = body as { error?: { code?: string; message?: string; retryAfterSeconds?: number }; retryAfterSeconds?: number } | null;
    const error = payload?.error;
    const header = Number(response.headers.get("Retry-After"));
    const retryAfter = Number(payload?.retryAfterSeconds ?? error?.retryAfterSeconds) || (Number.isFinite(header) && header > 0 ? header : undefined);
    const code = error?.code || "request_failed";
    if (code === "reload_required") reloadListeners.forEach((listener) => listener());
    throw new ApiRequestError(response.status, code, error?.message || "The demo could not complete that request.", write && response.status >= 500, retryAfter);
  }
  return body as T;
}

const post = <T>(path: string, body: unknown, timeoutMs?: number) => request<T>(path, { method: "POST", body: JSON.stringify(body) }, timeoutMs);

// ---------- health ----------

export type CallCountry = "US" | "IN";

export interface DemoCallsInfo {
  enabled: boolean;
  countries?: string[];
  fromNumber?: string;
  maxMinutes?: number;
  maxCallsPerDay?: number;
  web?: { enabled: boolean };
}

export interface HealthResponse {
  ok: boolean;
  apiVersion?: number;
  databaseConnected: boolean;
  liveCallsEnabled: boolean;
  liveSmsEnabled: boolean;
  demoCalls?: DemoCallsInfo;
  privateDemo?: { retentionDays: number };
}

export function getHealth() {
  return request<HealthResponse>("/api/health", { visitor: false }, 8_000);
}

// ---------- calls ----------

export interface DemoCallResponse {
  status: "calling";
  callRef: string;
  channel: "phone";
  country: CallCountry;
  maskedNumber: string;
  fromNumber: string;
  maxMinutes: number;
}

/** Asks the Worker to place one AI demo call to the visitor's phone. */
export function requestDemoCall(input: { phoneNumber: string; turnstileToken: string }) {
  return post<DemoCallResponse>("/api/demo-call", { ...input, consent: true, timezone: viewerTimezone() }, 20_000);
}

export interface WebCallResponse {
  callRef: string;
  channel: "web";
  callId: string;
  accessToken: string;
  transport?: "livekit" | "gateway";
  iceServers?: RTCIceServer[];
  expiresAt?: number | string;
  maxMinutes: number;
}

/** Asks the Worker to create one browser call. The access token is short-lived (~30 s): start the call at once. */
export function requestWebCall(input: { turnstileToken: string }) {
  return post<WebCallResponse>("/api/demo-web-call", { ...input, consent: true, timezone: viewerTimezone() }, 20_000);
}

export type CallPhase = "ringing" | "connecting" | "live" | "ended" | "unknown";
export type CallOutcome = "completed" | "time_limit" | "no_answer" | "blocked" | "error";
export interface ToolTiming { tool: string; ms: number; ok: boolean }

export interface CallStatusResponse {
  callRef: string;
  channel: "phone" | "web";
  phase: CallPhase;
  outcome?: CallOutcome;
  placedAt?: string | number;
  startedAt?: string | number;
  endedAt?: string | number;
  maxMinutes?: number;
  tools?: ToolTiming[];
}

export function getCallStatus(callRef: string) {
  return request<CallStatusResponse>(`/api/demo-call/status?ref=${encodeURIComponent(callRef)}`, {}, 8_000);
}

/**
 * Tells the server a browser call never connected, so it stops blocking a new call at once. It still counts toward the
 * limits unless Retell later reports that it never connected. Refused once the call has started.
 */
export function releaseCall(callRef: string, options: { keepalive?: boolean } = {}) {
  // keepalive lets the request finish while the page unloads (sendBeacon can't carry the X-Demo-Visitor header).
  return request<{ released: boolean }>("/api/demo-call/release", { method: "POST", body: JSON.stringify({ callRef }), keepalive: options.keepalive }, 8_000);
}

/** Server timestamps may arrive as ISO strings or epoch milliseconds. */
export function toMillis(value: string | number | undefined | null) {
  if (value === undefined || value === null || value === "") return undefined;
  const ms = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

// ---------- the two back ends ----------

export const cloudBackend: DemoBackend = {
  kind: "cloud",
  load: (known) => request<Snapshot | Unchanged>(known ? `/api/demo/state?known=${known.generation}.${known.revision}` : "/api/demo/state"),
  perform: (action, idempotencyKey) => post<ActionResponse>("/api/demo/actions", { action, idempotencyKey }),
  availability: async (query) => (await post<{ slots: AvailabilitySlot[] }>("/api/appointments/availability", query)).slots,
  forget: async () => { await post<{ deleted: boolean }>("/api/demo/forget", {}); },
};
