import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { apiVersion, fetchHandler } from "../src/app.ts";
import type { Env } from "../src/app.ts";
import worker from "../src/index.ts";
import { clientKey } from "../src/store.ts";
import { checkStorable, storedJsonBytes } from "../src/workspaces.ts";
import { DomainError, createSeedState, validateDemoState } from "../../../packages/shared/src/index.ts";
import type { DemoState } from "../../../packages/shared/src/index.ts";
import { FakeSupabase, SUPABASE_URL, installFetch, newVisitor, nextWeekday } from "./harness.ts";

let db: FakeSupabase;
let restore: () => void;
const env: Env = { SUPABASE_URL, SUPABASE_SECRET_KEY: "sb_secret_test", PUBLIC_ORIGINS: "https://demo.example", RETELL_API_KEY: "test-retell-key" };
const origin = "https://demo.example";

beforeEach(() => { db = new FakeSupabase(); restore = installFetch(db); });
afterEach(() => restore());

function call(path: string, init: RequestInit & { visitor?: string | null; ip?: string } = {}) {
  const { visitor, ip, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (!headers.has("Origin")) headers.set("Origin", origin);
  if (visitor) headers.set("X-Demo-Visitor", visitor);
  if (ip) headers.set("CF-Connecting-IP", ip);
  return fetchHandler(new Request(`https://worker.example${path}`, { ...rest, headers }), env);
}
const get = (path: string, visitor: string | null, ip?: string) => call(path, { visitor, ip });
const post = (path: string, body: unknown, visitor: string | null, ip?: string) => call(path, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" }, visitor, ip });
const bodyOf = async (response: Response) => await response.json() as Record<string, any>;
let keyCounter = 0;
const newKey = () => `test-${Date.now()}-${(keyCounter += 1)}`;
const task = (requestType: string) => ({ idempotencyKey: newKey(), action: { type: "create_task", requestType } });
const workspaceIds = () => [...db.workspaces.keys()];

describe("public API v3", () => {
  it("reports health with API v3, the private demo retention and calls off", async () => {
    const body = await bodyOf(await get("/api/health", null));
    assert.deepEqual(
      { ok: body.ok, apiVersion: body.apiVersion, db: body.databaseConnected, calls: body.liveCallsEnabled, sms: body.liveSmsEnabled, demoCalls: body.demoCalls, privateDemo: body.privateDemo },
      { ok: true, apiVersion: 3, db: true, calls: false, sms: false, demoCalls: { enabled: false, web: { enabled: false } }, privateDemo: { retentionDays: 7 } },
    );
    assert.equal(apiVersion, 3);
  });

  it("asks old tabs without a visitor key to reload, and rejects malformed keys", async () => {
    const missing = await get("/api/demo/state", null);
    assert.equal(missing.status, 409);
    assert.equal((await bodyOf(missing)).error.code, "reload_required");
    for (const path of ["/api/demo/actions", "/api/demo/forget", "/api/demo-call", "/api/demo-web-call", "/api/demo-call/release"]) {
      assert.equal((await bodyOf(await post(path, {}, null))).error.code, "reload_required", path);
    }
    assert.equal((await bodyOf(await get("/api/demo-call/status?ref=x", null))).error.code, "reload_required");
    const malformed = await get("/api/demo/state", "short-key");
    assert.deepEqual([malformed.status, (await bodyOf(malformed)).error.code], [400, "invalid_visitor"]);
    assert.equal(db.rpcLog.length, 0, "nothing reaches the database");
  });

  it("allows the visitor header in CORS and keeps the Origin check", async () => {
    const preflight = await call("/api/demo/state", { method: "OPTIONS" });
    assert.equal(preflight.status, 204);
    assert.match(preflight.headers.get("Access-Control-Allow-Headers") ?? "", /X-Demo-Visitor/);
    assert.equal(preflight.headers.get("Access-Control-Allow-Origin"), origin);
    const evil = await call("/api/demo/state", { visitor: newVisitor(), headers: { Origin: "https://evil.example" } });
    assert.equal(evil.status, 403);
    assert.equal((await call("/api/demo/state", { method: "OPTIONS", headers: { Origin: "https://evil.example" } })).status, 403);
  });

  it("keeps the whole-state write route retired", async () => {
    assert.equal((await call("/api/demo/state", { method: "PUT", body: "{}", visitor: newVisitor() })).status, 410);
  });

  it("never calls the retired shared-snapshot functions", async () => {
    const visitor = newVisitor();
    await get("/api/demo/state", visitor);
    await post("/api/demo/actions", task("callback"), visitor);
    await get("/api/health", null);
    assert.ok(db.rpcLog.every((name) => !/demo_state|initialize|record_retell_call_event$|reserve_demo_call$|finish_demo_call$/.test(name)), db.rpcLog.join(","));
  });
});

describe("private workspaces", () => {
  it("serves a fresh seed to a new visitor without writing anything", async () => {
    const body = await bodyOf(await get("/api/demo/state", newVisitor()));
    assert.deepEqual([body.revision, body.generation, body.persisted], [0, 0, false]);
    assert.equal(body.state.appointments.length, 5);
    const slots = await bodyOf(await post("/api/appointments/availability", { date: nextWeekday(), appointmentType: "Consultation", timezone: "America/Chicago" }, newVisitor()));
    assert.ok(slots.slots.length > 0);
    assert.equal(db.workspaces.size, 0);
    assert.ok(!db.rpcLog.some((name) => /create_workspace|save_workspace/.test(name)));
  });

  it("does not create a workspace for an invalid or no-op change", async () => {
    const visitor = newVisitor();
    const invalid = await post("/api/demo/actions", { idempotencyKey: newKey(), action: { type: "book_appointment", patient: "Someone New", appointmentType: "Consultation", startAt: `${nextWeekday()}T15:00:00.000Z`, timezone: "America/Chicago" } }, visitor);
    assert.equal((await bodyOf(invalid)).error.code, "unknown_patient", "console actions cannot introduce new names");
    const noop = await bodyOf(await post("/api/demo/actions", { idempotencyKey: newKey(), action: { type: "set_sms_preference", patient: "Maya Patel", optedOut: false } }, visitor));
    assert.deepEqual([noop.result.changed, noop.persisted, noop.revision], [false, false, 0]);
    assert.equal(db.workspaces.size, 0);
  });

  it("creates the workspace on the first change, then saves revisions", async () => {
    const visitor = newVisitor();
    const first = await bodyOf(await post("/api/demo/actions", task("callback"), visitor));
    assert.deepEqual([first.result.changed, first.persisted, first.revision], [true, true, 2], "seed is revision 1, the change revision 2");
    assert.ok(first.generation > 0);
    const read = await bodyOf(await get("/api/demo/state", visitor));
    assert.deepEqual([read.revision, read.generation, read.persisted], [2, first.generation, true]);
    assert.ok(read.state.tasks.some((item: { title: string; patient: string }) => item.title === "Call back requested" && item.patient === "Front desk"));
  });

  it("keeps two visitors' demos apart", async () => {
    const [alice, bob] = [newVisitor(), newVisitor()];
    const request = task("billing");
    await post("/api/demo/actions", request, alice);
    const bobView = await bodyOf(await get("/api/demo/state", bob));
    assert.equal(bobView.persisted, false);
    assert.equal(bobView.state.tasks.filter((item: { title: string }) => item.title === "Billing question").length, 1, "only the seed's task");
    // The same idempotency key in another workspace is a separate request.
    const bobChange = await bodyOf(await post("/api/demo/actions", request, bob));
    assert.equal(bobChange.result.changed, true);
    assert.equal(db.workspaces.size, 2);
    const [a, b] = workspaceIds();
    assert.notEqual(a, b);
    assert.match(a, /^[a-f0-9]{64}$/);
    assert.ok(!JSON.stringify([...db.workspaces.keys()]).includes(alice.slice(0, 20)), "the raw key is never stored");
  });

  it("does not lose either of two concurrent first writes", async () => {
    const visitor = newVisitor();
    db.gate("healthcare_read_workspace", 2);
    db.gate("healthcare_save_workspace", 2);
    const [one, two] = await Promise.all([post("/api/demo/actions", task("callback"), visitor), post("/api/demo/actions", task("records"), visitor)]);
    assert.deepEqual([one.status, two.status], [200, 200]);
    const state = (await bodyOf(await get("/api/demo/state", visitor))).state as DemoState;
    assert.ok(state.tasks.some((item) => item.title === "Call back requested"));
    assert.ok(state.tasks.some((item) => item.title === "Records request"));
    const [id] = workspaceIds();
    assert.equal(db.workspace(id)!.revision, 3);
    assert.equal(db.savesFor(id), 3, "one save conflicted and was retried");
  });

  it("(f) keeps an unsaved seed: known=0.0 is unchanged until the first change is stored", async () => {
    const visitor = newVisitor();
    assert.deepEqual(await bodyOf(await get("/api/demo/state?known=0.0", visitor)), { unchanged: true, revision: 0, generation: 0 });
    const first = await bodyOf(await post("/api/demo/actions", task("callback"), visitor));
    const stored = await bodyOf(await get("/api/demo/state?known=0.0", visitor));
    assert.deepEqual([stored.revision, stored.generation, stored.persisted], [first.revision, first.generation, true]);
    assert.ok(stored.state, "once stored, the browser gets the real copy");
    assert.equal(db.workspaces.size, 1);
  });

  it("answers conditional reads without the state when nothing changed", async () => {
    const visitor = newVisitor();
    const first = await bodyOf(await post("/api/demo/actions", task("callback"), visitor));
    const unchanged = await bodyOf(await get(`/api/demo/state?known=${first.generation}.${first.revision}`, visitor));
    assert.deepEqual(unchanged, { unchanged: true, revision: first.revision, generation: first.generation });
    await post("/api/demo/actions", task("records"), visitor);
    const changed = await bodyOf(await get(`/api/demo/state?known=${first.generation}.${first.revision}`, visitor));
    assert.equal(changed.revision, first.revision + 1);
    assert.ok(changed.state);
    const otherGeneration = await bodyOf(await get(`/api/demo/state?known=1.${first.revision + 1}`, visitor));
    assert.ok(otherGeneration.state, "a different generation gets the full state");
  });

  it("runs the reminder simulation in memory on reads, without writing", async () => {
    const visitor = newVisitor();
    await post("/api/demo/actions", task("callback"), visitor);
    const [id] = workspaceIds();
    const row = db.workspace(id)!;
    const stored = row.state as DemoState;
    // Make every scheduled text due.
    row.state = { ...stored, messages: stored.messages.map((item) => item.scheduledFor ? { ...item, scheduledFor: new Date(Date.now() - 60_000).toISOString() } : item) };
    const saves = db.savesFor(id);
    const read = (await bodyOf(await get("/api/demo/state", visitor))).state as DemoState;
    assert.ok(read.messages.every((item) => item.status !== "Scheduled (demo)"));
    assert.equal(db.savesFor(id), saves);
  });

  it("serves an unreadable stored copy as a fresh seed and replaces it on the next change", async () => {
    const visitor = newVisitor();
    await post("/api/demo/actions", task("callback"), visitor);
    const [id] = workspaceIds();
    db.workspace(id)!.state = { appointments: [{ patient: "Real Person" }], tasks: [], referrals: [], messages: [] };
    const read = await bodyOf(await get("/api/demo/state", visitor));
    assert.equal(read.persisted, true);
    assert.ok((read.state as DemoState).appointments.every((item) => item.patient !== "Real Person"));
    await post("/api/demo/actions", task("records"), visitor);
    assert.ok((db.workspace(id)!.state as DemoState).appointments.every((item) => item.patient !== "Real Person"));
  });

  it("refuses a valid state that would exceed the stored size limit before writing", () => {
    // Every list at its limit, with the longest allowed names and message bodies.
    const name = "Abcdefghijk Abcdefghijk Abcdefghijk Abcdefghijk Abcdefghijkl";
    const at = new Date(Date.now() + 86_400_000).toISOString();
    const seed = createSeedState();
    const body = `Reminder for your sample appointment at ${"Thursday October 8 at 9:30 AM ".repeat(13)} (America / Chicago). This text is not sent.`;
    const state: DemoState = {
      ...seed,
      messages: Array.from({ length: 120 }, (_, i) => ({ id: `msg-big-${i}`, recipient: `${name} · DEMO-${1000 + i}`, purpose: "24-hour appointment reminder", body, sentAt: at, scheduledFor: at, appointmentReference: `DEMO-${1000 + i}`, status: "Scheduled (demo)" as const })),
      tasks: Array.from({ length: 60 }, (_, i) => ({ id: `task-big-${i}`, title: "Accessibility or interpreter request", patient: name, detail: "Caller asked for accessibility or interpreter support. Staff will confirm the arrangements.", dueAt: at, priority: "Today" as const, status: "Open" as const, appointmentReference: `DEMO-${2000 + i}` })),
      events: Array.from({ length: 60 }, (_, i) => ({ id: `evt-big-${i}`, at, action: "Staff task created" as const, channel: "Voice assistant" as const, patient: name, reference: `DEMO-${3000 + i}`, taskId: `task-big-${i}` })),
      referrals: Array.from({ length: 60 }, (_, i) => ({ id: `doc-big-${i}`, patient: name, reference: `DEMO-${4000 + i}`, appointment: "Consultation", document: "Referral document · sample needed", status: "Needed" as const })),
    };
    assert.ok(validateDemoState(state), "the state itself is valid");
    assert.ok(storedJsonBytes(state) > 128 * 1024);
    assert.throws(() => checkStorable(state), (error: unknown) => error instanceof DomainError && error.code === "demo_full" && error.status === 409);
    assert.doesNotThrow(() => checkStorable(seed));
  });

  it("deletes the demo on forget, and starts a new generation afterwards", async () => {
    const visitor = newVisitor();
    const first = await bodyOf(await post("/api/demo/actions", task("callback"), visitor));
    const forgotten = await post("/api/demo/forget", {}, visitor);
    assert.deepEqual(await bodyOf(forgotten), { deleted: true });
    assert.equal(db.workspaces.size, 0);
    const after = await bodyOf(await get("/api/demo/state", visitor));
    assert.deepEqual([after.persisted, after.revision], [false, 0]);
    const again = await bodyOf(await post("/api/demo/actions", task("callback"), visitor));
    assert.notEqual(again.generation, first.generation);
  });

  it("limits new workspaces to 6 per client per hour, keyed by the IPv6 /64", async () => {
    for (let i = 0; i < 6; i += 1) {
      assert.equal((await post("/api/demo/actions", task("callback"), newVisitor(), `2001:db8:1:2::${i + 1}`)).status, 200);
    }
    const refused = await post("/api/demo/actions", task("callback"), newVisitor(), "2001:db8:1:2:ffff:ffff:ffff:ffff");
    assert.equal(refused.status, 429);
    assert.equal((await bodyOf(refused)).error.code, "demo_busy_creation");
    assert.ok(Number(refused.headers.get("Retry-After")) > 0);
    assert.equal((await post("/api/demo/actions", task("callback"), newVisitor(), "2001:db8:1:3::1")).status, 200, "another /64 is another client");
    assert.equal((await get("/api/demo/state", newVisitor(), "2001:db8:1:2::99")).status, 200, "reads are not limited by creation");
  });

  it("evicts the least recently used demo without calls at the cap, and refuses when none can go", async () => {
    // Fill to the cap cheaply: the fake trusts the same caps the Worker passes (3,000 rows).
    for (let i = 0; i < 2999; i += 1) db.workspaces.set(i.toString(16).padStart(64, "0"), { state: {}, revision: 1, createdAt: i + 1, lastUsedAt: i + 1, hadCall: i !== 0, bytes: 2 });
    assert.equal((await post("/api/demo/actions", task("callback"), newVisitor(), "198.51.100.1")).status, 200);
    assert.equal(db.workspaces.size, 3000);
    assert.equal((await post("/api/demo/actions", task("callback"), newVisitor(), "198.51.100.2")).status, 200, "evicts the only demo that never had a call");
    assert.ok(!db.workspaces.has("0".repeat(64)));
    for (const row of db.workspaces.values()) row.hadCall = true;
    const busy = await post("/api/demo/actions", task("callback"), newVisitor(), "198.51.100.3");
    assert.deepEqual([busy.status, (await bodyOf(busy)).error.code], [503, "demo_busy"]);
  });

  it("keeps per-client read and write rate limits", async () => {
    db.rateBoost = 1000;
    const response = await post("/api/demo/actions", task("callback"), newVisitor());
    assert.equal(response.status, 429);
    assert.equal((await bodyOf(response)).error.code, "rate_limited");
  });

  it("books through the action route and treats a retry as the same booking", async () => {
    const visitor = newVisitor();
    const slots = await bodyOf(await post("/api/appointments/availability", { date: nextWeekday(), appointmentType: "Follow-up visit", timezone: "America/Chicago" }, visitor));
    const request = { idempotencyKey: newKey(), action: { type: "book_appointment", patient: "Taylor Reed", appointmentType: "Follow-up visit", startAt: slots.slots[0].startAt, timezone: "America/Chicago" } };
    const first = await bodyOf(await post("/api/demo/actions", request, visitor));
    assert.equal(first.result.changed, true);
    const [id] = workspaceIds();
    const saves = db.savesFor(id);
    const replay = await bodyOf(await post("/api/demo/actions", request, visitor));
    assert.equal(replay.result.changed, false);
    assert.equal(replay.result.appointment.reference, first.result.appointment.reference);
    assert.equal(db.savesFor(id), saves, "a replay does not write");
  });

  it("rejects malformed requests", async () => {
    const visitor = newVisitor();
    assert.equal((await post("/api/demo/actions", { idempotencyKey: newKey(), action: { type: "create_task", requestType: "callback", note: "free text" } }, visitor)).status, 400);
    assert.equal((await post("/api/demo/actions", { action: { type: "create_task", requestType: "callback" } }, visitor)).status, 400);
  });
});

describe("client identity", () => {
  it("uses the full IPv4 address and the /64 prefix of IPv6 addresses", () => {
    assert.equal(clientKey("203.0.113.7"), "203.0.113.7");
    assert.equal(clientKey("2001:db8:85a3:8d3:1319:8a2e:370:7348"), "2001:0db8:85a3:08d3::/64");
    assert.equal(clientKey("2001:DB8:85A3:8D3::1"), "2001:0db8:85a3:08d3::/64");
    assert.equal(clientKey("2001:db8::1"), "2001:0db8:0000:0000::/64");
    assert.equal(clientKey("::1"), "0000:0000:0000:0000::/64");
    assert.equal(clientKey("::ffff:198.51.100.4"), "198.51.100.4");
    assert.equal(clientKey("fe80::1%eth0"), "fe80:0000:0000:0000::/64");
    assert.equal(clientKey(""), "local");
  });
});

describe("retention job", () => {
  it("purges through the scheduled handler: old demos, old events, call links and phone hashes", async () => {
    const [stale, fresh] = [newVisitor(), newVisitor()];
    await post("/api/demo/actions", task("callback"), stale);
    const [staleId] = workspaceIds();
    await post("/api/demo/actions", task("callback"), fresh);
    db.workspace(staleId)!.lastUsedAt = Date.now() - 8 * 86_400_000;
    db.events.set("call_old|call_ended", { callId: "call_old", event: "call_ended", detail: "user_hangup", occurredAt: null, receivedAt: Date.now() - 31 * 86_400_000 });
    db.calls.push({
      id: crypto.randomUUID(), channel: "phone", workspaceId: staleId, phoneHash: "a".repeat(64), ipHash: "b".repeat(64), owner: false, status: "placed",
      retellCallId: "call_x", createdAt: Date.now() - 25 * 3_600_000, suppressedUntil: null, toolLog: [], statusCheckedAt: null,
    });
    const pending: Promise<unknown>[] = [];
    worker.scheduled({ cron: "*/15 * * * *" }, env, { waitUntil: (promise) => { pending.push(promise); } });
    await Promise.all(pending);
    assert.deepEqual([...db.workspaces.keys()].length, 1);
    assert.ok(!db.workspaces.has(staleId));
    assert.equal(db.events.size, 0);
    assert.deepEqual([db.calls[0].workspaceId, db.calls[0].phoneHash], [null, null]);
    assert.ok(!db.rpcLog.some((name) => name.startsWith("healthcare_save_workspace") && db.rpcLog.indexOf(name) > db.rpcLog.indexOf("healthcare_purge_demo_data")), "the cron no longer simulates reminders");
  });

  it("matches the stored size of a seed to what Postgres measures", () => {
    // Verified against octet_length(state::text) in Postgres 16: jsonb prints ", " and ": " separators.
    assert.equal(storedJsonBytes({ a: [1, "x"], b: {} }), JSON.stringify({ a: [1, "x"], b: {} }).length + 4);
    assert.ok(storedJsonBytes(createSeedState()) < 20_000);
  });
});
