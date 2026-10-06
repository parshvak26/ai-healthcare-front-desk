// Two interchangeable back ends for the staff console:
// - CloudBackend talks to the Cloudflare Worker, which owns the shared synthetic schedule.
// - LocalBackend runs the same shared rules in the browser when no Worker is configured or reachable.
// Either way the UI updates only from the back end's answer, so it never shows a change that was not saved.
import { applyDemoAction, buildAvailability, DomainError, processDueMessages } from "../../../../packages/shared/src/index.ts";
import type { Appointment, AvailabilitySlot, DemoAction, DemoSnapshot, FollowUpTask, WaitlistItem } from "../types";
import { loadLocalSnapshot, saveLocalSnapshot } from "./store";

export const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL || "").trim().replace(/\/$/, "");
/** The Worker API version this website needs (see apps/worker/src/app.ts). */
export const requiredApiVersion = 2;

export interface ActionResponse extends DemoSnapshot {
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
  load(): Promise<DemoSnapshot>;
  perform(action: DemoAction, idempotencyKey: string): Promise<ActionResponse>;
  availability(query: AvailabilityQuery): Promise<AvailabilitySlot[]>;
}

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;
  /** True when the request may have reached the server, so the outcome is unknown until the page refreshes. */
  readonly uncertain: boolean;
  constructor(status: number, code: string, message: string, uncertain = false) {
    super(message);
    this.status = status;
    this.code = code;
    this.uncertain = uncertain;
  }
}

export function newIdempotencyKey() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

async function request<T>(path: string, init: RequestInit = {}, timeoutMs = 12_000): Promise<T> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  const write = (init.method || "GET") !== "GET";
  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl}${path}`, { ...init, signal: controller.signal, headers: { Accept: "application/json", ...(init.body ? { "Content-Type": "application/json" } : {}) } });
  } catch {
    throw new ApiRequestError(0, "network_error", write
      ? "The cloud demo did not answer. The change may or may not have been saved, so the schedule will refresh."
      : "The cloud demo did not answer. Please try again.", write);
  } finally {
    window.clearTimeout(timer);
  }
  let body: unknown = null;
  try { body = await response.json(); } catch { /* handled below */ }
  if (!response.ok) {
    const error = (body as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiRequestError(response.status, error?.code || "request_failed", error?.message || "The demo could not complete that request.", write && response.status >= 500);
  }
  return body as T;
}

export interface HealthResponse {
  ok: boolean;
  apiVersion?: number;
  databaseConnected: boolean;
  liveCallsEnabled: boolean;
  liveSmsEnabled: boolean;
}

export function getHealth() {
  return request<HealthResponse>("/api/health", {}, 8_000);
}

export const cloudBackend: DemoBackend = {
  kind: "cloud",
  load: () => request<DemoSnapshot>("/api/demo/state"),
  perform: (action, idempotencyKey) => request<ActionResponse>("/api/demo/actions", { method: "POST", body: JSON.stringify({ action, idempotencyKey }) }),
  availability: async (query) => (await request<{ slots: AvailabilitySlot[] }>("/api/appointments/availability", { method: "POST", body: JSON.stringify(query) })).slots,
};

function asApiError(error: unknown) {
  if (error instanceof DomainError) return new ApiRequestError(error.status, error.code, error.message);
  return error;
}

/** Browser-only back end. It applies the same rules and runs the reminder simulation on load and on a timer. */
export function createLocalBackend(): DemoBackend & { tick(): DemoSnapshot | null } {
  let snapshot = loadLocalSnapshot();
  const persist = (next: DemoSnapshot) => { snapshot = next; saveLocalSnapshot(next); return next; };
  const tick = () => {
    const processed = processDueMessages(snapshot.state, Date.now());
    return processed.changed ? persist({ state: processed.state, revision: snapshot.revision + 1 }) : null;
  };
  return {
    kind: "local",
    tick,
    load: async () => { tick(); return snapshot; },
    perform: async (action, idempotencyKey) => {
      try {
        const outcome = applyDemoAction(snapshot.state, action, { now: Date.now(), channel: "Staff console", key: `web|${idempotencyKey}`, random: Math.random });
        const next = outcome.changed ? persist({ state: outcome.state, revision: snapshot.revision + 1 }) : snapshot;
        return { ...next, result: { changed: outcome.changed, message: outcome.message, appointment: outcome.appointment, waitlistItem: outcome.waitlistItem, task: outcome.task } };
      } catch (error) {
        throw asApiError(error);
      }
    },
    availability: async (query) => {
      try {
        return buildAvailability(snapshot.state, { ...query, now: Date.now() });
      } catch (error) {
        throw asApiError(error);
      }
    },
  };
}
