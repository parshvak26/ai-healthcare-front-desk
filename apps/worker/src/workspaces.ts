// Private demo clinics ("workspaces"), one per browser. The browser keeps a random visitor key; the Worker turns it
// into workspace_id = HMAC(secret, key), so the raw key is never stored or logged.
//
// Lifecycle: reading an unknown workspace returns a fresh seed without writing. The first change creates the row
// from a seed (seed only, idempotent) and then applies the change with the normal optimistic read → apply → save
// loop, so concurrent first writes cannot lose data. The reminder simulation (processDueMessages) runs in memory on
// every read and before every change, so no cron job has to visit every workspace.
import {
  DomainError, createSeedState, defaultClinicTimezone, isTimezone, maxStateBytes, normalizeDemoState, processDueMessages,
  validateDemoState,
} from "../../../packages/shared/src/index.ts";
import type { DemoState } from "../../../packages/shared/src/index.ts";
import { RetryLaterError, consumeLimit, databaseError, keyedHash, rpc, rpcRow } from "./store.ts";
import type { Env } from "./store.ts";

export const visitorHeader = "X-Demo-Visitor";
export const retentionDays = 7;
export const maxWorkspaces = 3000;
export const maxTotalStateBytes = 150 * 1024 * 1024;
const maxNewWorkspacesPerHour = 6;
const visitorKeyPattern = /^[A-Za-z0-9_-]{43}$/;
const workspaceIdPattern = /^[a-f0-9]{64}$/;
const encoder = new TextEncoder();

export interface Workspace {
  state: DemoState;
  revision: number;
  /** created_at in ms; 0 while not stored. Changes when the workspace is deleted and created again. */
  generation: number;
  persisted: boolean;
}

interface StoredRow { state: unknown; revision: number; generation: number }

/**
 * How a missing workspace may be created: by its visitor (counted against the per-client limit), by a tool call of
 * a demo call that still links it, or for the owner's own inbound test calls.
 */
export type CreateMode = { kind: "visitor"; client: string } | { kind: "call"; requestId: string } | { kind: "owner" };

export function isWorkspaceId(value: unknown): value is string {
  return typeof value === "string" && workspaceIdPattern.test(value);
}

export function clinicTimezone(env: Env) {
  return env.CLINIC_TIMEZONE && isTimezone(env.CLINIC_TIMEZONE) ? env.CLINIC_TIMEZONE : defaultClinicTimezone;
}

/** Resolves the caller's workspace from the X-Demo-Visitor header. Old open tabs send none and are asked to reload. */
export async function visitorWorkspaceId(env: Env, request: Request) {
  const key = request.headers.get(visitorHeader);
  if (!key) throw new DomainError(409, "reload_required", "Please reload the page to continue.");
  if (!visitorKeyPattern.test(key)) throw new DomainError(400, "invalid_visitor", "This browser's demo key is not valid. Please reload the page.");
  return keyedHash(env, "visitor-workspace", key);
}

/** The fixed workspace for inbound test calls from the owner's allowlisted numbers (no call metadata). */
export function ownerWorkspaceId(env: Env) {
  // Not a valid visitor key (wrong length), so no browser can ever address this workspace.
  return keyedHash(env, "visitor-workspace", "owner-inbound-test-calls");
}

export const sessionCleared = () => new DomainError(410, "session_cleared", "This demo session was cleared, so nothing can be looked up or changed. Apologise briefly and end the call.");
const demoBusy = () => new DomainError(503, "demo_busy", "The demo is busy right now. Please try again in a few minutes.");
const demoFull = () => new DomainError(409, "demo_full", "This demo is full. Reset your demo in Settings and try again.");

/**
 * Size of a state as Postgres stores it (octet_length(state::text)): jsonb prints ", " and ": " between items, so
 * this is a little more than JSON.stringify. Checking it here turns an oversized demo into a clear 409 instead of a
 * database error.
 */
export function storedJsonBytes(value: unknown): number {
  if (value === null || typeof value !== "object") return encoder.encode(JSON.stringify(value) ?? "null").byteLength;
  if (Array.isArray(value)) {
    return 2 + value.reduce<number>((sum, item) => sum + storedJsonBytes(item ?? null), 0) + Math.max(0, value.length - 1) * 2;
  }
  const entries = Object.entries(value).filter(([, item]) => item !== undefined);
  return 2 + entries.reduce((sum, [key, item]) => sum + encoder.encode(JSON.stringify(key)).byteLength + 2 + storedJsonBytes(item), 0)
    + Math.max(0, entries.length - 1) * 2;
}

export function seedState(env: Env, now: number) {
  return createSeedState(now, clinicTimezone(env));
}

function parseRow(row: { state?: unknown; revision?: unknown; generation?: unknown } | undefined): StoredRow | undefined {
  if (!row) return undefined;
  const revision = Number(row.revision);
  const generation = Number(row.generation);
  if (!Number.isSafeInteger(revision) || revision < 1 || !Number.isSafeInteger(generation) || generation < 1) throw databaseError();
  return { state: row.state, revision, generation };
}

/** The stored state, upgraded if needed, with due simulated texts processed in memory. */
function usable(env: Env, row: StoredRow, now: number): Workspace {
  const normalized = normalizeDemoState(row.state);
  // Only synthetic data is ever stored, so an unreadable copy is served as a fresh seed; the next save replaces it.
  if (!normalized) console.error(JSON.stringify({ event: "workspace_state_invalid", revision: row.revision }));
  const state = normalized ? normalized.state : seedState(env, now);
  return { state: processDueMessages(state, now).state, revision: row.revision, generation: row.generation, persisted: true };
}

function freshSeed(env: Env, now: number): Workspace {
  return { state: processDueMessages(seedState(env, now), now).state, revision: 0, generation: 0, persisted: false };
}

async function readRow(env: Env, workspaceId: string) {
  return parseRow(await rpcRow(env, "healthcare_read_workspace", { p_workspace_id: workspaceId, p_known_generation: null, p_known_revision: null }));
}

/** Reads a workspace. Never writes: an unknown workspace is a fresh seed (revision 0, persisted false). */
export async function loadWorkspace(env: Env, workspaceId: string, now = Date.now()): Promise<Workspace> {
  const row = await readRow(env, workspaceId);
  return row ? usable(env, row, now) : freshSeed(env, now);
}

export interface Unchanged { unchanged: true; revision: number; generation: number }

/** Like loadWorkspace, but answers `unchanged` without the state when the caller already has this generation and revision. */
export async function readWorkspace(env: Env, workspaceId: string, known: { generation: number; revision: number } | null, now = Date.now()): Promise<Workspace | Unchanged> {
  if (!known) return loadWorkspace(env, workspaceId, now);
  const row = await rpcRow<{ state?: unknown; revision?: unknown; generation?: unknown; unchanged?: unknown }>(env, "healthcare_read_workspace", {
    p_workspace_id: workspaceId, p_known_generation: known.generation, p_known_revision: known.revision,
  });
  const parsed = parseRow(row);
  // Nothing stored and the browser already shows a seed: keep it, rather than sending one rebuilt for a later time.
  if (!parsed) return known.generation === 0 && known.revision === 0 ? { unchanged: true, revision: 0, generation: 0 } : freshSeed(env, now);
  if (row?.unchanged === true) return { unchanged: true, revision: parsed.revision, generation: parsed.generation };
  return usable(env, parsed, now);
}

async function createRow(env: Env, workspaceId: string, seed: DemoState, mode: CreateMode): Promise<StoredRow> {
  if (mode.kind === "visitor") {
    await consumeLimit(env, mode.client, "workspace-create", 3600, maxNewWorkspacesPerHour,
      () => new RetryLaterError(429, "demo_busy_creation", "Too many new demos were started from this connection. Please try again in an hour.", 3600));
  }
  const row = await rpcRow<{ created?: unknown; reason?: unknown; state?: unknown; revision?: unknown; generation?: unknown }>(env, "healthcare_create_workspace", {
    p_workspace_id: workspaceId,
    p_state: seed,
    p_max_workspaces: maxWorkspaces,
    p_max_total_bytes: maxTotalStateBytes,
    p_request_id: mode.kind === "call" ? mode.requestId : null,
    p_had_call: mode.kind !== "visitor",
  });
  if (!row) throw databaseError();
  if (row.reason === "demo_busy") throw demoBusy();
  if (row.reason === "not_linked") throw sessionCleared();
  const parsed = parseRow(row);
  if (!parsed) throw databaseError();
  return parsed;
}

/**
 * A tool call may only use a workspace that is missing (never stored, or deleted) while its call request still
 * links it; after "Delete my demo data" the link is gone and the call's tools are refused.
 */
export async function assertLinked(env: Env, workspaceId: string, requestId: string) {
  if (await rpc(env, "healthcare_demo_call_linked", { p_request_id: requestId, p_workspace_id: workspaceId }) !== true) throw sessionCleared();
}

/** Makes sure the workspace is stored (seed only when new) and returns it. Used before placing a call. */
export async function ensureWorkspace(env: Env, workspaceId: string, mode: CreateMode, now = Date.now()): Promise<Workspace> {
  const row = await readRow(env, workspaceId) ?? await createRow(env, workspaceId, seedState(env, now), mode);
  return usable(env, row, now);
}

/** Refuses a state the database would refuse, before any write. */
export function checkStorable(state: DemoState) {
  if (!validateDemoState(state)) throw new DomainError(422, "demo_data_only", "Use the built-in fictional sample data only.");
  if (storedJsonBytes(state) > maxStateBytes) throw demoFull();
}

export interface ChangeResult<T> { state: DemoState; changed: boolean; value: T }

/**
 * Applies a change with optimistic concurrency. The change runs against the latest stored copy (after the in-memory
 * reminder simulation); when it reports changed=false (for example an idempotent replay) nothing is written.
 * A missing workspace is first tried against an in-memory seed, so an invalid or no-op request never creates one.
 */
export async function mutateWorkspace<T>(env: Env, workspaceId: string, change: (state: DemoState) => ChangeResult<T>, mode: CreateMode, now = Date.now()): Promise<{ workspace: Workspace; value: T }> {
  let row = await readRow(env, workspaceId);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (!row) {
      if (mode.kind === "call") await assertLinked(env, workspaceId, mode.requestId);
      const seed = seedState(env, now);
      const trial = change(processDueMessages(seed, now).state);
      if (!trial.changed) return { workspace: { state: trial.state, revision: 0, generation: 0, persisted: false }, value: trial.value };
      row = await createRow(env, workspaceId, seed, mode);
    }
    const current = usable(env, row, now);
    const result = change(current.state);
    if (!result.changed) return { workspace: { ...current, state: result.state }, value: result.value };
    checkStorable(result.state);
    const saved = await rpcRow<{ saved?: unknown; reason?: unknown; revision?: unknown; generation?: unknown }>(env, "healthcare_save_workspace", {
      p_workspace_id: workspaceId, p_expected_revision: row.revision, p_state: result.state, p_max_total_bytes: maxTotalStateBytes,
    });
    if (!saved) throw databaseError();
    if (saved.saved === true) {
      const revision = Number(saved.revision);
      if (revision !== row.revision + 1) throw databaseError();
      return { workspace: { state: result.state, revision, generation: row.generation, persisted: true }, value: result.value };
    }
    if (saved.reason === "demo_busy") throw demoBusy();
    // Someone saved first, or the workspace was deleted meanwhile: start again from the latest copy.
    row = await readRow(env, workspaceId);
  }
  throw new DomainError(409, "demo_state_conflict", "Please try that request again.");
}

/** "Delete my demo data". Refused while one of the workspace's calls may still be live. */
export async function forgetWorkspace(env: Env, workspaceId: string, maxCallSeconds: number) {
  const row = await rpcRow<{ deleted?: unknown; reason?: unknown }>(env, "healthcare_delete_workspace", { p_workspace_id: workspaceId, p_max_call_seconds: maxCallSeconds });
  if (!row) throw databaseError();
  if (row.reason === "call_in_progress") throw new DomainError(409, "call_in_progress", "Your demo call is still in progress. Delete your demo data after it ends.");
  if (row.deleted !== true) throw databaseError();
}
