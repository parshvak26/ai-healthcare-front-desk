// Test doubles: an in-memory stand-in for the Supabase RPC functions in supabase/migrations (same rules as the SQL,
// which is exercised separately against a real Postgres), plus a fetch router that sends Supabase, Retell and
// Turnstile requests to fakes. No test touches the network.
import assert from "node:assert/strict";
import { storedJsonBytes } from "../src/workspaces.ts";

export const SUPABASE_URL = "https://example-project.supabase.co";
const DAY = 86_400_000;

export interface WorkspaceRow { state: unknown; revision: number; createdAt: number; lastUsedAt: number; hadCall: boolean; bytes: number }
export interface CallRow {
  id: string; channel: "phone" | "web"; workspaceId: string | null; phoneHash: string | null; ipHash: string; owner: boolean;
  status: "reserved" | "placed" | "failed" | "unknown"; retellCallId: string | null; createdAt: number; suppressedUntil: number | null;
  toolLog: Array<{ tool: string; ms: number; ok: boolean }>; statusCheckedAt: number | null; releasedAt?: number | null;
}
export interface EventRow { callId: string; event: string; detail: string | null; occurredAt: number | null; receivedAt: number }

const hex64 = /^[a-f0-9]{64}$/;
const iso = (ms: number | null | undefined) => (ms === null || ms === undefined ? null : new Date(ms).toISOString().replace("Z", "+00:00"));

/** Holds the first `count` calls of one RPC until all of them have arrived, to force a race. */
interface Gate { name: string; count: number; waiting: Array<() => void> }

export class FakeSupabase {
  workspaces = new Map<string, WorkspaceRow>();
  calls: CallRow[] = [];
  events = new Map<string, EventRow>();
  rateLimits = new Map<string, { start: number; count: number; updated: number }>();
  /** Added to every rate-limit count, to simulate a busy client. */
  rateBoost = 0;
  rpcLog: string[] = [];
  /** RPC names that fail (as a database error) while listed. */
  failing = new Set<string>();
  /** Contract violations seen by the fake (the Worker swallows fetch errors, so tests check this list). */
  violations: Error[] = [];
  private gates: Gate[] = [];

  gate(name: string, count: number) { this.gates.push({ name, count, waiting: [] }); }

  workspace(id: string) { return this.workspaces.get(id); }
  call(id: string) { return this.calls.find((row) => row.id === id); }
  savesFor(id: string) { return this.rpcLog.filter((entry) => entry === `healthcare_save_workspace:${id}`).length; }

  private event(callId: string | null, event: string) { return callId ? this.events.get(`${callId}|${event}`) : undefined; }

  /** healthcare.demo_call_counts: fails closed, free only with proof that no call connected. */
  counts(row: CallRow) {
    if (row.status === "failed") return false;
    if (this.event(row.retellCallId, "call_started")) return true;
    const detail = this.event(row.retellCallId, "call_ended")?.detail;
    const neverConnected = Boolean(detail && (detail.startsWith("error_") || [
      "error_user_not_joined", "registered_call_timeout", "concurrency_limit_reached", "telephony_provider_permission_denied",
      "invalid_destination", "dial_failed", "network_blocked",
    ].includes(detail)));
    return !neverConnected;
  }

  /** healthcare.demo_call_active_until: when the call stops blocking the visitor's next one, or null. */
  activeUntil(row: CallRow, maxSeconds: number) {
    if (!["reserved", "placed", "unknown"].includes(row.status) || this.event(row.retellCallId, "call_ended")) return null;
    const limits = [row.createdAt + (maxSeconds + 90) * 1000];
    if (!this.event(row.retellCallId, "call_started")) limits.push(row.createdAt + 120_000);
    if (row.releasedAt) limits.push(row.createdAt + 45_000);
    return Math.min(...limits);
  }

  /** healthcare.demo_call_active (both channels) */
  active(row: CallRow, now: number, maxSeconds: number) {
    const until = this.activeUntil(row, maxSeconds);
    return until !== null && until > now;
  }

  async handle(name: string, body: Record<string, any>): Promise<unknown> {
    const gate = this.gates.find((item) => item.name === name && item.waiting.length < item.count);
    if (gate) {
      await new Promise<void>((resolve) => {
        gate.waiting.push(resolve);
        if (gate.waiting.length === gate.count) { gate.waiting.forEach((release) => release()); this.gates.splice(this.gates.indexOf(gate), 1); }
      });
    }
    this.rpcLog.push(body.p_workspace_id && name.includes("workspace") ? `${name}:${body.p_workspace_id}` : name);
    if (this.failing.has(name)) throw new Error(`simulated failure of ${name}`);
    const now = Date.now();
    switch (name) {
      case "healthcare_consume_demo_rate_limit": {
        assert.match(body.p_client_hash, hex64);
        const entry = this.rateLimits.get(body.p_client_hash);
        if (!entry || entry.start + body.p_window_seconds * 1000 <= now) this.rateLimits.set(body.p_client_hash, { start: now, count: 1, updated: now });
        else { entry.count += 1; entry.updated = now; }
        return this.rateLimits.get(body.p_client_hash)!.count + this.rateBoost;
      }
      case "healthcare_read_workspace": {
        const row = this.workspaces.get(body.p_workspace_id);
        if (!row) return [];
        const generation = row.createdAt;
        const unchanged = generation === body.p_known_generation && row.revision === body.p_known_revision;
        return [{ state: unchanged ? null : structuredClone(row.state), revision: row.revision, generation, unchanged }];
      }
      case "healthcare_create_workspace": {
        assert.match(body.p_workspace_id, hex64);
        const bytes = storedJsonBytes(body.p_state);
        assert.ok(bytes <= 131_072, "seed fits the SQL size check");
        const existing = this.workspaces.get(body.p_workspace_id);
        if (existing) return [{ created: false, reason: null, state: structuredClone(existing.state), revision: existing.revision, generation: existing.createdAt }];
        if (body.p_request_id && !this.calls.some((row) => row.id === body.p_request_id && row.workspaceId === body.p_workspace_id)) {
          return [{ created: false, reason: "not_linked", state: null, revision: null, generation: null }];
        }
        for (;;) {
          const total = [...this.workspaces.values()].reduce((sum, row) => sum + row.bytes, 0);
          if (this.workspaces.size < body.p_max_workspaces && total + bytes <= body.p_max_total_bytes) break;
          const victim = [...this.workspaces.entries()].filter(([, row]) => !row.hadCall).sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt)[0];
          if (!victim) return [{ created: false, reason: "demo_busy", state: null, revision: null, generation: null }];
          this.workspaces.delete(victim[0]);
          for (const row of this.calls) if (row.workspaceId === victim[0]) row.workspaceId = null;
        }
        // Distinct creation times, like clock_timestamp() in milliseconds.
        let createdAt = now;
        while ([...this.workspaces.values()].some((row) => row.createdAt === createdAt)) createdAt += 1;
        const row: WorkspaceRow = { state: structuredClone(body.p_state), revision: 1, createdAt, lastUsedAt: now, hadCall: Boolean(body.p_had_call), bytes };
        this.workspaces.set(body.p_workspace_id, row);
        return [{ created: true, reason: null, state: structuredClone(row.state), revision: 1, generation: row.createdAt }];
      }
      case "healthcare_save_workspace": {
        const bytes = storedJsonBytes(body.p_state);
        if (bytes > 131_072) throw new Error("workspace state too large");
        const row = this.workspaces.get(body.p_workspace_id);
        if (!row) return [{ saved: false, reason: "missing", revision: null, generation: null }];
        if (bytes > row.bytes) {
          const total = [...this.workspaces.values()].reduce((sum, item) => sum + item.bytes, 0);
          if (total - row.bytes + bytes > body.p_max_total_bytes) return [{ saved: false, reason: "demo_busy", revision: null, generation: null }];
        }
        if (row.revision !== body.p_expected_revision) return [{ saved: false, reason: "conflict", revision: row.revision, generation: row.createdAt }];
        Object.assign(row, { state: structuredClone(body.p_state), revision: row.revision + 1, lastUsedAt: now, bytes });
        return [{ saved: true, reason: null, revision: row.revision, generation: row.createdAt }];
      }
      case "healthcare_touch_workspace": {
        const row = this.workspaces.get(body.p_workspace_id);
        if (row) { row.lastUsedAt = now; row.hadCall ||= Boolean(body.p_had_call); }
        return Boolean(row);
      }
      case "healthcare_delete_workspace": {
        if (this.calls.some((row) => row.workspaceId === body.p_workspace_id && this.active(row, now, body.p_max_call_seconds))) return [{ deleted: false, reason: "call_in_progress" }];
        this.workspaces.delete(body.p_workspace_id);
        for (const row of this.calls) if (row.workspaceId === body.p_workspace_id) row.workspaceId = null;
        return [{ deleted: true, reason: null }];
      }
      case "healthcare_reserve_demo_call_v2": return [this.reserve(body, now)];
      case "healthcare_finish_demo_call_v2": {
        assert.ok(["placed", "failed", "unknown"].includes(body.p_status));
        const row = this.call(body.p_request_id);
        if (!row || row.status !== "reserved") return false;
        row.status = body.p_status;
        row.retellCallId ??= body.p_call_id;
        return true;
      }
      case "healthcare_record_retell_call_event_v2": {
        assert.ok(body.p_detail === null || /^[a-z_]{1,60}$/.test(body.p_detail), "detail shape");
        const key = `${body.p_call_id}|${body.p_event}`;
        const occurred = body.p_occurred_at ? Date.parse(body.p_occurred_at) : null;
        const existing = this.events.get(key);
        if (existing) { existing.detail ??= body.p_detail; existing.occurredAt ??= occurred; }
        else this.events.set(key, { callId: body.p_call_id, event: body.p_event, detail: body.p_detail, occurredAt: occurred, receivedAt: now });
        const row = body.p_request_id ? this.call(body.p_request_id) : undefined;
        if (row && (row.retellCallId === null || row.retellCallId === body.p_call_id)) {
          row.retellCallId ??= body.p_call_id;
          if (body.p_event === "call_started") {
            if (row.status === "failed" || row.status === "unknown") row.status = "placed";
            row.releasedAt = null;
          }
        }
        return true;
      }
      case "healthcare_demo_call_status": {
        const row = this.calls.find((item) => item.id === body.p_request_id && item.workspaceId !== null && item.workspaceId === body.p_workspace_id);
        if (!row) return [];
        const started = this.event(row.retellCallId, "call_started");
        const ended = this.event(row.retellCallId, "call_ended");
        return [{
          channel: row.channel, status: row.status, retell_call_id: row.retellCallId, placed_at: iso(row.createdAt),
          started_at: started ? iso(started.occurredAt ?? started.receivedAt) : null, ended_at: ended ? iso(ended.occurredAt ?? ended.receivedAt) : null,
          end_reason: ended?.detail ?? null, tool_log: row.toolLog, status_checked_at: iso(row.statusCheckedAt), released_at: iso(row.releasedAt),
        }];
      }
      case "healthcare_claim_demo_call_status_check": {
        const row = this.calls.find((item) => item.id === body.p_request_id && item.workspaceId === body.p_workspace_id && item.retellCallId);
        if (!row || (row.statusCheckedAt !== null && row.statusCheckedAt > now - body.p_min_seconds * 1000)) return false;
        row.statusCheckedAt = now;
        return true;
      }
      case "healthcare_release_demo_call": {
        const row = this.calls.find((item) => item.id === body.p_request_id && item.workspaceId === body.p_workspace_id && item.channel === "web");
        if (!row || !["reserved", "placed", "unknown"].includes(row.status) || this.event(row.retellCallId, "call_started")) return false;
        row.releasedAt ??= now;
        return true;
      }
      case "healthcare_suppress_demo_call_number": {
        const row = this.call(body.p_request_id);
        if (!row || row.channel !== "phone" || !row.phoneHash || (row.retellCallId !== null && row.retellCallId !== body.p_call_id)) return false;
        row.suppressedUntil = Math.max(row.suppressedUntil ?? 0, now + body.p_days * DAY);
        return true;
      }
      case "healthcare_append_demo_call_tool_log": {
        assert.match(body.p_tool, /^[a-z_]{1,40}$/);
        const row = this.call(body.p_request_id);
        if (!row || (row.retellCallId !== null && row.retellCallId !== body.p_call_id) || row.toolLog.length >= 40) return false;
        row.toolLog.push({ tool: body.p_tool, ms: body.p_ms, ok: body.p_ok });
        return true;
      }
      case "healthcare_demo_call_linked":
        return this.calls.some((row) => row.id === body.p_request_id && row.workspaceId === body.p_workspace_id);
      case "healthcare_purge_demo_data": {
        let workspaces = 0;
        for (const [id, row] of [...this.workspaces]) {
          if (row.lastUsedAt < now - 7 * DAY) {
            this.workspaces.delete(id);
            workspaces += 1;
            for (const call of this.calls) if (call.workspaceId === id) call.workspaceId = null;
          }
        }
        let callEvents = 0;
        for (const [key, row] of [...this.events]) if (row.receivedAt < now - 30 * DAY) { this.events.delete(key); callEvents += 1; }
        let links = 0;
        let hashes = 0;
        for (const row of this.calls) {
          const ended = this.event(row.retellCallId, "call_ended");
          if (row.workspaceId && (row.createdAt < now - 2 * 3_600_000 || (ended && ended.receivedAt < now - 3_600_000))) { row.workspaceId = null; links += 1; }
          if (row.phoneHash && row.createdAt < now - DAY && (row.suppressedUntil === null || row.suppressedUntil <= now)) { row.phoneHash = null; hashes += 1; }
        }
        const before = this.calls.length;
        this.calls = this.calls.filter((row) => !(row.createdAt < now - 30 * DAY && (row.suppressedUntil === null || row.suppressedUntil <= now)));
        return [{ workspaces_deleted: workspaces, call_events_deleted: callEvents, call_links_cleared: links, phone_hashes_cleared: hashes, call_requests_deleted: before - this.calls.length }];
      }
      default:
        throw new Error(`unexpected RPC ${name}`);
    }
  }

  private reserve(body: Record<string, any>, now: number) {
    assert.ok(["phone", "web"].includes(body.p_channel));
    assert.match(body.p_workspace_id, hex64);
    assert.match(body.p_ip_hash, hex64);
    if (body.p_channel === "phone") assert.match(body.p_phone_hash, hex64); else assert.equal(body.p_phone_hash, null);
    const owner = Boolean(body.p_owner) && body.p_channel === "phone";
    const refuse = (reason: string, retry: number) => ({ allowed: false, reason, retry_after_seconds: Math.max(1, Math.ceil(retry / 1000)) });
    if (body.p_channel === "phone" && !owner) {
      const until = Math.max(0, ...this.calls.filter((row) => row.phoneHash === body.p_phone_hash && (row.suppressedUntil ?? 0) > now).map((row) => row.suppressedUntil!));
      if (until) return refuse("phone_suppressed", until - now);
    }
    const live = this.calls.filter((row) => row.workspaceId === body.p_workspace_id && this.active(row, now, body.p_max_call_seconds));
    if (live.length) return refuse("call_in_progress", Math.max(...live.map((row) => this.activeUntil(row, body.p_max_call_seconds)!)) - now);
    if (!owner) {
      if (body.p_channel === "phone") {
        const recent = this.calls.filter((row) => row.phoneHash === body.p_phone_hash && row.createdAt > now - body.p_phone_cooldown_minutes * 60_000 && this.counts(row));
        if (recent.length) return refuse("phone_cooldown", Math.max(...recent.map((row) => row.createdAt)) + body.p_phone_cooldown_minutes * 60_000 - now);
      }
      const client = this.calls.filter((row) => row.ipHash === body.p_ip_hash && !row.owner && row.createdAt > now - DAY && this.counts(row));
      if (client.length >= body.p_max_calls_per_ip_per_day) return refuse("ip_daily_limit", Math.min(...client.map((row) => row.createdAt)) + DAY - now);
      const dayStart = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
      const today = this.calls.filter((row) => !row.owner && row.createdAt >= dayStart && this.counts(row));
      if (today.length >= body.p_max_calls_per_day) return refuse("daily_limit", dayStart + DAY - now);
    }
    this.calls.push({
      id: body.p_request_id, channel: body.p_channel, workspaceId: body.p_workspace_id, phoneHash: body.p_channel === "phone" ? body.p_phone_hash : null,
      ipHash: body.p_ip_hash, owner, status: "reserved", retellCallId: null, createdAt: now, suppressedUntil: null, toolLog: [], statusCheckedAt: null,
    });
    const workspace = this.workspaces.get(body.p_workspace_id);
    if (workspace) { workspace.hadCall = true; workspace.lastUsedAt = now; }
    return { allowed: true, reason: null, retry_after_seconds: 0 };
  }
}

export type Handler = (url: URL, init: RequestInit | undefined) => Response | Promise<Response>;

export const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });

/** Routes fetch to the fakes. Retell and Turnstile handlers are optional; an unexpected host fails the test. */
export function installFetch(db: FakeSupabase, handlers: { retell?: Handler; turnstile?: Handler } = {}) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.origin === SUPABASE_URL) {
      assert.ok(url.pathname.startsWith("/rest/v1/rpc/"), "only RPCs are called");
      try {
        return json(await db.handle(url.pathname.replace("/rest/v1/rpc/", ""), JSON.parse(String(init?.body ?? "{}"))));
      } catch (error) {
        if (error instanceof assert.AssertionError) { db.violations.push(error); throw error; }
        return json({ message: "database error" }, 500);
      }
    }
    if (url.host === "api.retellai.com" && handlers.retell) return handlers.retell(url, init);
    if (url.host === "challenges.cloudflare.com" && handlers.turnstile) return handlers.turnstile(url, init);
    throw new Error(`unexpected network request to ${url.host}`);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = realFetch;
    assert.deepEqual(db.violations.map((error) => error.message), [], "the fake database saw invalid RPC input");
  };
}

let visitorCounter = 0;
/** A distinct, valid visitor key (43 base64url characters). */
export function newVisitor() {
  visitorCounter += 1;
  return `${"v".repeat(36)}${String(visitorCounter).padStart(7, "0")}`;
}

export async function sign(raw: string, apiKey: string, timestamp = Date.now()) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(apiKey), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw + timestamp)));
  return `v=${timestamp},d=${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** The next clinic weekday at least a week away, as YYYY-MM-DD. */
export function nextWeekday(daysAhead = 7) {
  const date = new Date(Date.now() + daysAhead * DAY);
  while ([0, 6].includes(date.getUTCDay())) date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}
