// Supabase access for the Worker. The Worker is the only client; the browser never sees database credentials.
// All access goes through service-role-only RPC functions in the private schema (see supabase/migrations).
import { DomainError } from "../../../packages/shared/src/index.ts";

export interface Env {
  SUPABASE_URL?: string;
  SUPABASE_SECRET_KEY?: string;
  CLINIC_ID?: string;
  CLINIC_TIMEZONE?: string;
  PUBLIC_ORIGINS?: string;
  RETELL_API_KEY?: string;
  RETELL_TEST_NUMBERS?: string;
  SMS_MODE?: string;
  /** "on" enables public demo calls; anything else keeps them off. */
  DEMO_CALLS?: string;
  /** "on" additionally enables browser (web) calls. Both switches must be on. */
  DEMO_WEB_CALLS?: string;
  RETELL_FROM_NUMBER?: string;
  RETELL_AGENT_ID?: string;
  /** Published agent version the Worker was built for (an integer). Unset means "latest_published". */
  RETELL_AGENT_VERSION?: string;
  /** This Worker's /webhooks/retell/events URL, sent per call so Retell reports call_started / call_ended. */
  RETELL_EVENTS_URL?: string;
  TURNSTILE_SECRET_KEY?: string;
  TURNSTILE_HOSTNAME?: string;
  MAX_CALLS_PER_DAY?: string;
  MAX_CALLS_PER_IP_PER_DAY?: string;
  PHONE_COOLDOWN_MINUTES?: string;
  MAX_CALL_DURATION_SECONDS?: string;
}

/** The part of Cloudflare's ExecutionContext the Worker uses: work that may finish after the response is sent. */
export interface ExecutionContextLike { waitUntil(promise: Promise<unknown>): void }

const encoder = new TextEncoder();

export function configured(env: Env): env is Env & { SUPABASE_URL: string; SUPABASE_SECRET_KEY: string } {
  return Boolean(env.SUPABASE_URL && env.SUPABASE_SECRET_KEY);
}

export const notConfigured = () => new DomainError(503, "backend_not_configured", "The cloud demo has not been connected yet.");
export const databaseError = () => new DomainError(502, "database_error", "The demo database could not complete that request.");

/** A refusal the client may retry later; the response carries Retry-After and retryAfterSeconds. */
export class RetryLaterError extends DomainError {
  readonly retryAfter: number;
  constructor(status: number, code: string, message: string, retryAfter: number) {
    super(status, code, message);
    this.retryAfter = Math.max(1, Math.min(30 * 86_400, Math.ceil(retryAfter) || 60));
  }
}

export async function rpc(env: Env, name: string, body: unknown) {
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

/** First row of a set-returning RPC, or undefined. Anything that is not an array is a database error. */
export async function rpcRow<T>(env: Env, name: string, body: unknown): Promise<T | undefined> {
  const rows = await rpc(env, name, body);
  if (!Array.isArray(rows)) throw databaseError();
  return rows[0] as T | undefined;
}

function hex(bytes: ArrayBuffer) {
  return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

/** Keyed hash (HMAC-SHA256, hex) with a key derived from the server secret, so stored values cannot be reversed by guessing. */
export async function keyedHash(env: Env, purpose: string, value: string) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(`${env.SUPABASE_SECRET_KEY ?? ""}|${purpose}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}

export async function pingDatabase(env: Env) {
  await rpc(env, "healthcare_read_workspace", { p_workspace_id: "0".repeat(64), p_known_generation: null, p_known_revision: null });
}

function ipv6Groups(value: string) {
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if (halves.length === 1 && head.length !== 8) return null;
  const missing = 8 - head.length - tail.length;
  if (missing < (halves.length === 2 ? 1 : 0)) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  return groups.every((group) => /^[0-9a-f]{1,4}$/.test(group)) ? groups.map((group) => group.padStart(4, "0")) : null;
}

/**
 * The identity used for every per-client limit: the full IPv4 address, or the /64 prefix of an IPv6 address
 * (one home or phone connection usually owns a whole /64, so per-address limits would be trivial to dodge).
 */
export function clientKey(ip: string) {
  const value = ip.trim().toLowerCase().replace(/%.*$/, "");
  if (!value.includes(":")) return value || "local";
  const mapped = /^(?:0{0,4}:){0,4}:?(?:0{0,4}:)?ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(value);
  if (mapped) return mapped[1];
  const groups = ipv6Groups(value);
  return groups ? `${groups.slice(0, 4).join(":")}::/64` : value;
}

/**
 * Counts one request against a per-client window and refuses it beyond `max`. Separate buckets keep reads, writes
 * and new workspaces apart, so browsing availability or polling cannot block a booking.
 */
export async function consumeLimit(env: Env, client: string, bucket: string, windowSeconds: number, max: number, refuse: () => DomainError) {
  const key = await keyedHash(env, "rate-limit", `${client}|${bucket}`);
  const count = await rpc(env, "healthcare_consume_demo_rate_limit", { p_client_hash: key, p_window_seconds: windowSeconds });
  if (typeof count !== "number" || !Number.isInteger(count)) throw databaseError();
  if (count > max) throw refuse();
}

export function consumeRateLimit(env: Env, client: string, kind: "read" | "write") {
  return consumeLimit(env, client, kind, 60, kind === "read" ? 120 : 30,
    () => new RetryLaterError(429, "rate_limited", "Please wait a minute before trying again.", 60));
}

/** Runs work after the response when the runtime allows it (Cloudflare's waitUntil); otherwise waits for it. */
export async function afterResponse(context: ExecutionContextLike | undefined, work: Promise<unknown>) {
  const safe = work.catch(() => undefined);
  if (context) context.waitUntil(safe);
  else await safe;
}
