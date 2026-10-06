import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { apiVersion, fetchHandler, processDemoReminders } from "../src/app.ts";
import type { Env } from "../src/app.ts";
import { verifyRetellSignature } from "../src/retell.ts";
import { createSeedState } from "../../../packages/shared/src/index.ts";
import type { DemoState } from "../../../packages/shared/src/index.ts";

// In-memory stand-in for the five Supabase RPC functions in supabase/migrations.
interface FakeDb { row: { state: unknown; revision: number } | null; saves: number; rateCount: number; callEvents: Set<string> }
let db: FakeDb;
const realFetch = globalThis.fetch;
const SUPABASE_URL = "https://example-project.supabase.co";
const API_KEY = "test-retell-key";
const TEST_NUMBER = "+15550100";
const env: Env = { SUPABASE_URL, SUPABASE_SECRET_KEY: "sb_secret_test", PUBLIC_ORIGINS: "https://demo.example", RETELL_API_KEY: API_KEY, RETELL_TEST_NUMBERS: TEST_NUMBER };

function fakeSupabase(input: RequestInfo | URL, init?: RequestInit) {
  const url = new URL(String(input instanceof Request ? input.url : input));
  assert.equal(url.origin, SUPABASE_URL, "only Supabase is called");
  const name = url.pathname.replace("/rest/v1/rpc/", "");
  const body = JSON.parse(String(init?.body ?? "{}"));
  const json = (value: unknown) => Promise.resolve(new Response(JSON.stringify(value), { status: 200 }));
  switch (name) {
    case "healthcare_read_demo_state": return json(db.row ? [db.row] : []);
    case "healthcare_initialize_demo_state": if (!db.row) db.row = { state: body.p_state, revision: 1 }; return json(true);
    case "healthcare_save_demo_state":
      if (!db.row || db.row.revision !== body.p_expected_revision) return json([{ saved: false, revision: body.p_expected_revision }]);
      db.row = { state: body.p_state, revision: db.row.revision + 1 };
      db.saves += 1;
      return json([{ saved: true, revision: db.row.revision }]);
    case "healthcare_consume_demo_rate_limit": db.rateCount += 1; return json(db.rateCount);
    case "healthcare_record_retell_call_event": db.callEvents.add(`${body.p_call_id}:${body.p_event}`); return json(true);
    default: return Promise.resolve(new Response("{}", { status: 404 }));
  }
}

beforeEach(() => {
  db = { row: null, saves: 0, rateCount: 0, callEvents: new Set() };
  globalThis.fetch = fakeSupabase as typeof fetch;
});
afterEach(() => { globalThis.fetch = realFetch; });

const origin = { Origin: "https://demo.example" };
const call = (path: string, init: RequestInit = {}) => fetchHandler(new Request(`https://worker.example${path}`, init), env);
const post = (path: string, body: unknown, headers: Record<string, string> = origin) => call(path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
const state = () => (db.row!.state as DemoState);
let keyCounter = 0;
const newKey = () => `test-${Date.now()}-${(keyCounter += 1)}`;

async function sign(raw: string, timestamp = Date.now()) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(API_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw + timestamp)));
  return `v=${timestamp},d=${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function retell(name: string, args: Record<string, unknown>, options: { callId?: string; from?: string; signed?: boolean } = {}) {
  const raw = JSON.stringify({ name, args, call: { call_id: options.callId ?? "call_test_1", from_number: options.from ?? TEST_NUMBER, transcript: "Caller: (sample)" } });
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (options.signed !== false) headers["X-Retell-Signature"] = await sign(raw);
  const response = await call("/webhooks/retell/custom-function", { method: "POST", headers, body: raw });
  return { status: response.status, body: await response.json() as Record<string, any> };
}

function nextWeekday() {
  const date = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  while ([0, 6].includes(date.getUTCDay())) date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

describe("public API", () => {
  it("reports health without enabling live channels", async () => {
    const body = await (await call("/api/health")).json() as Record<string, unknown>;
    assert.deepEqual({ ok: body.ok, apiVersion: body.apiVersion, db: body.databaseConnected, calls: body.liveCallsEnabled, sms: body.liveSmsEnabled }, { ok: true, apiVersion, db: true, calls: false, sms: false });
  });

  it("seeds once and does not write on plain reads", async () => {
    const first = await (await call("/api/demo/state", { headers: origin })).json() as { revision: number };
    const second = await (await call("/api/demo/state", { headers: origin })).json() as { revision: number };
    assert.equal(first.revision, 1);
    assert.equal(second.revision, 1);
    assert.equal(db.saves, 0);
  });

  it("books through the action route and treats a retry as the same booking", async () => {
    const date = nextWeekday();
    const slots = await (await post("/api/appointments/availability", { date, appointmentType: "Follow-up visit", timezone: "America/Chicago" })).json() as { slots: Array<{ startAt: string }> };
    assert.ok(slots.slots.length > 0);
    const request = { idempotencyKey: newKey(), action: { type: "book_appointment", patient: "Taylor Reed", appointmentType: "Follow-up visit", startAt: slots.slots[0].startAt, timezone: "America/Chicago" } };
    const first = await (await post("/api/demo/actions", request)).json() as Record<string, any>;
    assert.equal(first.result.changed, true);
    const savesAfterFirst = db.saves;
    const replay = await (await post("/api/demo/actions", request)).json() as Record<string, any>;
    assert.equal(replay.result.changed, false);
    assert.equal(replay.result.appointment.reference, first.result.appointment.reference);
    assert.equal(db.saves, savesAfterFirst, "a replay does not write");
  });

  it("returns a clear conflict instead of a false confirmation", async () => {
    await call("/api/demo/state", { headers: origin });
    const taken = state().appointments.find((item) => item.reference === "DEMO-4812")!;
    const response = await post("/api/demo/actions", { idempotencyKey: newKey(), action: { type: "book_appointment", patient: "Jordan Lee", appointmentType: "New patient visit", startAt: taken.startAt, timezone: "America/Chicago" } });
    // The other provider is still free at that time, so book the second provider first, then expect a refusal.
    if (response.status === 200) {
      const again = await post("/api/demo/actions", { idempotencyKey: newKey(), action: { type: "book_appointment", patient: "Samira Khan", appointmentType: "New patient visit", startAt: taken.startAt, timezone: "America/Chicago" } });
      assert.equal(again.status, 409);
      assert.equal((await again.json() as Record<string, any>).error.code, "slot_unavailable");
    } else {
      assert.equal(response.status, 409);
    }
  });

  it("rejects malformed, unauthorised, and retired requests", async () => {
    assert.equal((await post("/api/demo/actions", { idempotencyKey: newKey(), action: { type: "create_task", requestType: "callback", note: "free text" } })).status, 400);
    assert.equal((await post("/api/demo/actions", { action: { type: "create_task", requestType: "callback" } })).status, 400);
    assert.equal((await post("/api/demo/actions", { idempotencyKey: newKey(), action: { type: "create_task", requestType: "callback" } }, { Origin: "https://evil.example" })).status, 403);
    assert.equal((await call("/api/demo/state", { method: "PUT", headers: origin, body: "{}" })).status, 410);
    db.rateCount = 1000;
    assert.equal((await post("/api/demo/actions", { idempotencyKey: newKey(), action: { type: "create_task", requestType: "callback" } })).status, 429);
  });

  it("upgrades a snapshot stored by the previous Worker exactly once", async () => {
    const legacy = createSeedState() as Partial<DemoState>;
    delete legacy.events;
    delete legacy.smsPreferences;
    db.row = { state: legacy, revision: 7 };
    const body = await (await call("/api/demo/state", { headers: origin })).json() as { revision: number; state: DemoState };
    assert.equal(body.revision, 8);
    assert.ok(Array.isArray(body.state.events) && body.state.smsPreferences.length === 5);
    await call("/api/demo/state", { headers: origin });
    assert.equal(db.saves, 1);
  });
});

describe("stored data recovery", () => {
  it("replaces an unreadable snapshot with fresh sample data instead of failing", async () => {
    db.row = { state: { appointments: [{ patient: "Real Person" }], tasks: [], referrals: [], messages: [] }, revision: 3 };
    const response = await call("/api/demo/state", { headers: origin });
    assert.equal(response.status, 200);
    const body = await response.json() as { revision: number; state: DemoState };
    assert.equal(body.revision, 4);
    assert.ok(body.state.appointments.every((item) => item.patient !== "Real Person"));
  });
});

describe("Retell custom functions", () => {
  it("verifies signatures exactly like the Retell SDK", async () => {
    const raw = "{\"a\":1}";
    assert.equal(await verifyRetellSignature(raw, await sign(raw), API_KEY), true);
    assert.equal(await verifyRetellSignature(raw + " ", await sign(raw), API_KEY), false);
    assert.equal(await verifyRetellSignature(raw, await sign(raw, Date.now() - 10 * 60 * 1000), API_KEY), false);
  });

  it("rejects unsigned requests and callers outside the allowlist", async () => {
    assert.equal((await retell("get_availability", { date: nextWeekday(), appointment_type: "Consultation" }, { signed: false })).status, 401);
    assert.equal((await retell("get_availability", { date: nextWeekday(), appointment_type: "Consultation" }, { from: "+15550199" })).status, 403);
    const closed = await fetchHandler(new Request("https://worker.example/webhooks/retell/custom-function", { method: "POST", body: "{}" }), { ...env, RETELL_TEST_NUMBERS: "" });
    assert.equal(closed.status, 401);
  });

  it("runs a full booking conversation without duplicates", async () => {
    const date = nextWeekday();
    const availability = await retell("get_availability", { date, appointment_type: "Consultation" });
    assert.equal(availability.status, 200);
    assert.equal(availability.body.timezone, "America/Chicago", "defaults to the clinic timezone");
    const slot = availability.body.slots[0];
    assert.match(slot.local_time, /\d{1,2}:\d{2} (AM|PM)$/);

    const args = { patient_name: "Jordan Lee", appointment_type: "Consultation", start_at: slot.start_at, timezone: "America/Chicago" };
    const booked = await retell("create_appointment", args, { callId: "call_booking" });
    assert.equal(booked.body.success, true);
    const repeated = await retell("create_appointment", args, { callId: "call_booking" });
    assert.equal(repeated.body.reference, booked.body.reference);
    assert.equal(state().appointments.filter((item) => item.reference === booked.body.reference).length, 1);

    const lookup = await retell("lookup_appointment", { booking_reference: booked.body.reference, verification_name: "Jordan Lee" });
    assert.equal(lookup.body.appointment.local_time, slot.local_time);
    const docs = await retell("check_document_status", { booking_reference: booked.body.reference, sample_patient_name: "Jordan Lee" });
    assert.equal(docs.body.documents[0].status, "Needed");
    const cancelled = await retell("cancel_appointment", { booking_reference: booked.body.reference, verification_name: "Jordan Lee" }, { callId: "call_booking" });
    assert.equal(cancelled.body.appointment.status, "Cancelled");
  });

  it("treats differently formatted repeats as one booking, and a rebook after cancelling as new", async () => {
    const availability = await retell("get_availability", { date: nextWeekday(), appointment_type: "Follow-up visit" });
    const slot = availability.body.slots[1];
    const first = await retell("create_appointment", { patient_name: "Samira Khan", appointment_type: "Follow-up visit", start_at: slot.start_at }, { callId: "call_format" });
    const reformatted = await retell("create_appointment", { patient_name: "Samira Khan", appointment_type: "Follow-up visit", start_at: slot.start_at.replace(".000Z", "Z"), timezone: "America/Chicago" }, { callId: "call_format" });
    assert.equal(reformatted.body.reference, first.body.reference);
    await retell("cancel_appointment", { booking_reference: first.body.reference, verification_name: "Samira Khan" }, { callId: "call_format" });
    const rebooked = await retell("create_appointment", { patient_name: "Samira Khan", appointment_type: "Follow-up visit", start_at: slot.start_at }, { callId: "call_format" });
    assert.equal(rebooked.body.success, true);
    assert.notEqual(rebooked.body.reference, first.body.reference);
    assert.equal(rebooked.body.appointment.status, "Confirmed");
  });

  it("returns business failures as success=false so the agent can respond", async () => {
    const wrongName = await retell("lookup_appointment", { booking_reference: "DEMO-4812", verification_name: "Jordan Lee" });
    assert.deepEqual([wrongName.status, wrongName.body.success, wrongName.body.error], [200, false, "sample_booking_not_found"]);
    const offGrid = await retell("create_appointment", { patient_name: "Maya Patel", appointment_type: "Consultation", start_at: `${nextWeekday()}T03:07:00.000Z` });
    assert.deepEqual([offGrid.status, offGrid.body.success, offGrid.body.error], [200, false, "slot_unavailable"]);
    const unknown = await retell("delete_everything", {});
    assert.equal(unknown.body.error, "unknown_function");
  });

  it("creates one anonymous staff task per request type per call", async () => {
    await retell("request_staff_followup", { request_type: "accessibility" }, { callId: "call_tasks" });
    await retell("request_staff_followup", { request_type: "accessibility" }, { callId: "call_tasks" });
    const tasks = state().tasks.filter((item) => item.title === "Accessibility or interpreter request");
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].patient, "Front desk");
    assert.equal((await retell("request_staff_followup", { request_type: "faq_review" })).body.error, "invalid_request_type");
  });

  it("routes refill questions to staff and medical questions to the safety answer", async () => {
    const refill = await retell("search_approved_faq", { question: "Can you refill my prescription?" });
    assert.deepEqual([refill.body.handoff, refill.body.suggested_request_type], [true, "refill"]);
    const clinical = await retell("search_approved_faq", { question: "Is this rash serious?" });
    assert.match(clinical.body.answer, /cannot answer medical questions/);
  });

  it("trusts outbound demo calls this Worker started, and nothing else from other numbers", async () => {
    const agentEnv = { ...env, RETELL_AGENT_ID: "agent_bcd0e610f4535270f5642efeb0" };
    const send = async (callFields: Record<string, unknown>) => {
      const raw = JSON.stringify({ name: "search_approved_faq", args: { question: "Is there parking?" }, call: { call_id: "call_out", from_number: "+15128231502", to_number: "+919876543210", ...callFields } });
      return (await fetchHandler(new Request("https://worker.example/webhooks/retell/custom-function", { method: "POST", headers: { "X-Retell-Signature": await sign(raw) }, body: raw }), agentEnv)).status;
    };
    assert.equal(await send({ direction: "outbound", agent_id: "agent_bcd0e610f4535270f5642efeb0", metadata: { source: "healthcare-web-demo" } }), 200);
    assert.equal(await send({ direction: "outbound", agent_id: "agent_bcd0e610f4535270f5642efeb0" }), 403, "no marker");
    assert.equal(await send({ direction: "outbound", agent_id: "agent_other", metadata: { source: "healthcare-web-demo" } }), 403, "another agent (for example HVAC)");
    assert.equal(await send({ direction: "inbound", agent_id: "agent_bcd0e610f4535270f5642efeb0", metadata: { source: "healthcare-web-demo" } }), 403, "inbound from a stranger");
  });

  it("records only opaque call events", async () => {
    const raw = JSON.stringify({ event: "call_ended", call: { call_id: "call_evt", from_number: TEST_NUMBER, transcript: "secret words" } });
    const response = await call("/webhooks/retell/events", { method: "POST", headers: { "X-Retell-Signature": await sign(raw) }, body: raw });
    assert.equal(response.status, 200);
    assert.deepEqual([...db.callEvents], ["call_evt:call_ended"]);
  });
});

describe("reminder job", () => {
  it("writes only when a simulated text is due", async () => {
    await call("/api/demo/state", { headers: origin });
    assert.deepEqual(await processDemoReminders(env, Date.now() - 24 * 60 * 60 * 1000), { changed: false });
    assert.equal(db.saves, 0);
    assert.deepEqual(await processDemoReminders(env, Date.now() + 10 * 24 * 60 * 60 * 1000), { changed: true });
    assert.equal(db.saves, 1);
  });
});
