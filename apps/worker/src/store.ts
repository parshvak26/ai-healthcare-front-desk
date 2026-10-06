// Supabase-backed storage for the shared synthetic snapshot. The Worker is the only client; the browser never
// sees database credentials. All access goes through service-role-only RPC functions in the private schema.
import { DomainError, createSeedState, normalizeDemoState, validateDemoState } from "../../../packages/shared/src/index.ts";
import type { DemoSnapshot, DemoState } from "../../../packages/shared/src/index.ts";

export interface Env {
  SUPABASE_URL?: string;
  SUPABASE_SECRET_KEY?: string;
  CLINIC_ID?: string;
  CLINIC_TIMEZONE?: string;
  PUBLIC_ORIGINS?: string;
  RETELL_API_KEY?: string;
  RETELL_TEST_NUMBERS?: string;
  SMS_MODE?: string;
}

const defaultClinicId = "harbor-health-demo";
const encoder = new TextEncoder();

export function clinicId(env: Env) {
  return env.CLINIC_ID || defaultClinicId;
}

export function configured(env: Env): env is Env & { SUPABASE_URL: string; SUPABASE_SECRET_KEY: string } {
  return Boolean(env.SUPABASE_URL && env.SUPABASE_SECRET_KEY);
}

const notConfigured = () => new DomainError(503, "backend_not_configured", "The cloud demo has not been connected yet.");
const databaseError = () => new DomainError(502, "database_error", "The demo database could not complete that request.");
const unreadable = () => new DomainError(502, "demo_seed_failed", "The sample schedule could not be loaded.");

async function rpc(env: Env, name: string, body: unknown) {
  if (!configured(env)) throw notConfigured();
  const url = new URL(`/rest/v1/rpc/${name}`, env.SUPABASE_URL);
  const headers = new Headers({ "Content-Type": "application/json", apikey: env.SUPABASE_SECRET_KEY });
  // Legacy JWT service-role keys need Authorization; new sb_secret keys must only use apikey.
  if (env.SUPABASE_SECRET_KEY.split(".").length === 3) headers.set("Authorization", `Bearer ${env.SUPABASE_SECRET_KEY}`);
  let response: Response;
  try {
    response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  } catch {
    console.error(JSON.stringify({ event: "database_unreachable", rpc: name }));
    throw databaseError();
  }
  if (!response.ok) {
    console.error(JSON.stringify({ event: "database_request_failed", rpc: name, status: response.status }));
    throw databaseError();
  }
  return response.json() as Promise<unknown>;
}

export async function pingDatabase(env: Env) {
  await rpc(env, "healthcare_read_demo_state", { p_clinic_id: clinicId(env) });
}

export async function consumeRateLimit(env: Env, clientIp: string, kind: "read" | "write") {
  // Separate buckets for reads and writes, so browsing availability or polling cannot block a booking.
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(`${clientIp}|${kind}`));
  const key = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
  const count = await rpc(env, "healthcare_consume_demo_rate_limit", { p_client_hash: key, p_window_seconds: 60 });
  if (typeof count !== "number" || !Number.isInteger(count)) throw databaseError();
  if (count > (kind === "read" ? 120 : 30)) throw new DomainError(429, "rate_limited", "Please wait a minute before trying again.");
}

async function readRow(env: Env) {
  const rows = await rpc(env, "healthcare_read_demo_state", { p_clinic_id: clinicId(env) });
  if (!Array.isArray(rows)) throw databaseError();
  return rows[0] as { state?: unknown; revision?: unknown } | undefined;
}

export async function saveSnapshot(env: Env, expectedRevision: number, state: DemoState): Promise<DemoSnapshot> {
  if (!validateDemoState(state)) throw new DomainError(422, "demo_data_only", "Use the built-in fictional sample data only.");
  const result = await rpc(env, "healthcare_save_demo_state", { p_clinic_id: clinicId(env), p_expected_revision: expectedRevision, p_state: state });
  const row = Array.isArray(result) ? result[0] as { saved?: boolean; revision?: number } | undefined : undefined;
  if (!row?.saved) throw new DomainError(409, "demo_state_conflict", "Another demo session saved first. Please try again.");
  const revision = Number(row.revision);
  if (!Number.isInteger(revision) || revision !== expectedRevision + 1) throw databaseError();
  return { state, revision };
}

/** Loads the snapshot, creating the fictional seed on first use and upgrading older stored formats. */
export async function loadSnapshot(env: Env, now = Date.now()): Promise<DemoSnapshot> {
  if (!configured(env)) throw notConfigured();
  let row = await readRow(env);
  if (!row) {
    await rpc(env, "healthcare_initialize_demo_state", { p_clinic_id: clinicId(env), p_state: createSeedState(now, env.CLINIC_TIMEZONE || undefined) });
    row = await readRow(env);
  }
  const revision = Number(row?.revision);
  if (!row || !Number.isInteger(revision) || revision < 1) throw unreadable();
  const normalized = normalizeDemoState(row.state);
  if (!normalized) {
    // The store only ever holds synthetic sample data, so an unreadable snapshot is replaced with fresh samples
    // rather than leaving the public demo broken. The revision check still prevents overwriting a newer save.
    console.error(JSON.stringify({ event: "demo_state_invalid_reseeded", revision }));
    return saveSnapshot(env, revision, createSeedState(now, env.CLINIC_TIMEZONE || undefined));
  }
  if (!normalized.migrated) return { state: normalized.state, revision };
  try {
    return await saveSnapshot(env, revision, normalized.state);
  } catch (error) {
    // Another writer may have upgraded it first; the normalized copy is still correct to serve.
    if (error instanceof DomainError && error.status === 409) return { state: normalized.state, revision };
    throw error;
  }
}

/**
 * Applies a change with optimistic concurrency. The change function runs against the latest snapshot; when it
 * reports changed=false (for example, an idempotent replay) nothing is written, so the revision does not churn.
 */
export async function mutateSnapshot<T>(env: Env, change: (state: DemoState) => { state: DemoState; changed: boolean; value: T }): Promise<{ snapshot: DemoSnapshot; value: T }> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current = await loadSnapshot(env);
    const result = change(current.state);
    if (!result.changed) return { snapshot: current, value: result.value };
    try {
      return { snapshot: await saveSnapshot(env, current.revision, result.state), value: result.value };
    } catch (error) {
      if (!(error instanceof DomainError) || error.status !== 409 || error.code !== "demo_state_conflict" || attempt === 3) throw error;
    }
  }
  throw new DomainError(409, "demo_state_conflict", "Please try the sample request again.");
}

export async function recordCallEvent(env: Env, callId: string, event: string) {
  await rpc(env, "healthcare_record_retell_call_event", { p_call_id: callId, p_event: event });
}
