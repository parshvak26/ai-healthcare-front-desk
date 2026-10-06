import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fetchHandler } from "../src/app.ts";
import type { Env, ExecutionContextLike } from "../src/app.ts";
import { verifyRetellSignature } from "../src/retell.ts";
import { keyedHash } from "../src/store.ts";
import type { DemoState } from "../../../packages/shared/src/index.ts";
import { FakeSupabase, SUPABASE_URL, installFetch, newVisitor, nextWeekday, sign } from "./harness.ts";

let db: FakeSupabase;
let restore: () => void;
const API_KEY = "test-retell-key";
const OWNER = "+15550100";
const AGENT = "agent_bcd0e610f4535270f5642efeb0";
const env: Env = {
  SUPABASE_URL, SUPABASE_SECRET_KEY: "sb_secret_test", PUBLIC_ORIGINS: "https://demo.example", RETELL_API_KEY: API_KEY,
  RETELL_TEST_NUMBERS: OWNER, RETELL_AGENT_ID: AGENT,
};

beforeEach(() => { db = new FakeSupabase(); restore = installFetch(db); });
afterEach(() => restore());

type Call = Record<string, unknown>;
let callCounter = 0;

/** A call the Worker placed for this visitor: the reservation row exists and Retell signs the metadata. */
async function demoCall(visitor: string, options: { channel?: "phone" | "web"; placedAgo?: number; startedAgo?: number; callerTimezone?: string; stored?: boolean } = {}) {
  const channel = options.channel ?? "web";
  const workspaceId = await keyedHash(env, "visitor-workspace", visitor);
  const requestId = crypto.randomUUID();
  const callId = `call_demo_${(callCounter += 1)}`;
  const placedAt = Date.now() - (options.placedAgo ?? 5_000);
  if (options.stored !== false) {
    db.calls.push({
      id: requestId, channel, workspaceId, phoneHash: channel === "phone" ? "c".repeat(64) : null, ipHash: "d".repeat(64), owner: false,
      status: "placed", retellCallId: callId, createdAt: placedAt, suppressedUntil: null, toolLog: [], statusCheckedAt: null,
    });
  }
  const call: Call = {
    call_id: callId, call_type: channel === "web" ? "web_call" : "phone_call", agent_id: AGENT,
    ...(channel === "phone" ? { direction: "outbound", from_number: "+15128231502", to_number: "+14155550123" } : {}),
    ...(options.startedAgo !== undefined ? { start_timestamp: Date.now() - options.startedAgo } : {}),
    metadata: { source: "healthcare-web-demo", request_id: requestId, workspace: workspaceId, channel, caller_timezone: options.callerTimezone ?? "America/Chicago", placed_at: placedAt, max_seconds: "300" },
  };
  return { call, requestId, workspaceId, callId };
}

const ownerCall = (callId = "call_owner_1"): Call => ({ call_id: callId, call_type: "phone_call", direction: "inbound", from_number: OWNER, agent_id: AGENT });

async function retell(name: string, args: Record<string, unknown>, call: Call, options: { signed?: boolean; context?: ExecutionContextLike; overrides?: Partial<Env> } = {}) {
  const raw = JSON.stringify({ name, args, call: { ...call, transcript: "Caller: (sample)" } });
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (options.signed !== false) headers["X-Retell-Signature"] = await sign(raw, API_KEY);
  const response = await fetchHandler(new Request("https://worker.example/webhooks/retell/custom-function", { method: "POST", headers, body: raw }), { ...env, ...options.overrides }, options.context);
  return { status: response.status, body: await response.json() as Record<string, any> };
}

async function event(name: string, call: Call, extra: Record<string, unknown> = {}) {
  const raw = JSON.stringify({ event: name, call: { ...call, transcript: "secret words", ...extra } });
  const response = await fetchHandler(new Request("https://worker.example/webhooks/retell/events", { method: "POST", headers: { "X-Retell-Signature": await sign(raw, API_KEY) }, body: raw }), env);
  return { status: response.status, body: await response.json() as Record<string, any> };
}

async function visitorState(visitor: string) {
  const response = await fetchHandler(new Request("https://worker.example/api/demo/state", { headers: { Origin: "https://demo.example", "X-Demo-Visitor": visitor } }), env);
  return await response.json() as { state: DemoState; persisted: boolean };
}

async function firstSlot(call: Call, appointmentType = "Consultation", index = 0) {
  const availability = await retell("get_availability", { start_date: nextWeekday(), appointment_type: appointmentType }, call);
  assert.equal(availability.body.success, true, JSON.stringify(availability.body));
  return availability.body.slots[index] as Record<string, string>;
}

describe("Retell signatures and trust", () => {
  it("verifies signatures exactly like the Retell SDK", async () => {
    const raw = "{\"a\":1}";
    assert.equal(await verifyRetellSignature(raw, await sign(raw, API_KEY), API_KEY), true);
    assert.equal(await verifyRetellSignature(raw + " ", await sign(raw, API_KEY), API_KEY), false);
    assert.equal(await verifyRetellSignature(raw, await sign(raw, API_KEY, Date.now() - 10 * 60 * 1000), API_KEY), false);
  });

  it("rejects unsigned requests and callers outside the allowlist", async () => {
    assert.equal((await retell("get_availability", { date: nextWeekday(), appointment_type: "Consultation" }, ownerCall(), { signed: false })).status, 401);
    assert.equal((await retell("get_availability", { date: nextWeekday(), appointment_type: "Consultation" }, { ...ownerCall(), from_number: "+15550199" })).status, 403);
    const closed = await fetchHandler(new Request("https://worker.example/webhooks/retell/custom-function", { method: "POST", body: "{}" }), { ...env, RETELL_TEST_NUMBERS: "" });
    assert.equal(closed.status, 401);
  });

  it("trusts browser calls and outbound phone calls this Worker started, by call type", async () => {
    const { call } = await demoCall(newVisitor());
    const faq = (fields: Call) => retell("search_approved_faq", { question: "Is there parking?" }, { ...call, ...fields });
    assert.equal((await faq({})).status, 200, "web_call with the marker");
    assert.equal((await faq({ call_type: "phone_call", direction: "outbound" })).status, 200, "outbound phone call");
    assert.equal((await faq({ call_type: "phone_call", direction: "inbound" })).status, 403, "inbound from a stranger");
    assert.equal((await faq({ call_type: "phone_call" })).status, 403, "phone call without a direction");
    assert.equal((await faq({ metadata: { source: "other" } })).status, 403, "no marker");
    assert.equal((await faq({ agent_id: "agent_other" })).status, 403, "another agent (for example HVAC)");
  });
});

describe("Retell tools on the visitor's private demo", () => {
  it("writes to the workspace named in the signed call metadata, and only there", async () => {
    const [visitor, other] = [newVisitor(), newVisitor()];
    const { call, workspaceId } = await demoCall(visitor);
    const slot = await firstSlot(call);
    const booked = await retell("create_appointment", { patient_name: "parshva karani", appointment_type: "Consultation", start_at: slot.start_at, provider: slot.provider }, call);
    assert.equal(booked.body.success, true, JSON.stringify(booked.body));
    assert.equal(booked.body.patient_name, "Parshva Karani", "stored in canonical spelling");
    assert.match(booked.body.reference_spoken, /^demo (zero|one|two|three|four|five|six|seven|eight|nine)( (zero|one|two|three|four|five|six|seven|eight|nine)){3}$/);
    assert.match(booked.body.appointment.spoken_time, /^[A-Z][a-z]+day, [A-Z][a-z]+ \d{1,2}(st|nd|rd|th) at \d{1,2}(:\d{2})? (a|p)\.m\.$/);
    const mine = await visitorState(visitor);
    assert.ok(mine.state.appointments.some((item) => item.reference === booked.body.reference && item.patient === "Parshva Karani"));
    assert.ok(mine.state.events.some((item) => item.channel === "Voice assistant" && item.reference === booked.body.reference));
    const theirs = await visitorState(other);
    assert.equal(theirs.persisted, false);
    assert.ok(db.workspace(workspaceId)!.hadCall, "a workspace created by a call is never evicted");
  });

  it("treats a repeated booking as one even when the name's capitalisation differs", async () => {
    const { call } = await demoCall(newVisitor());
    const slot = await firstSlot(call);
    const first = await retell("create_appointment", { patient_name: "Parshva", appointment_type: "Consultation", start_at: slot.start_at }, call);
    const again = await retell("create_appointment", { patient_name: "parshva", appointment_type: "Consultation", start_at: slot.start_at.replace(".000Z", "Z"), timezone: "Asia/Dubai" }, call);
    assert.equal(first.body.success, true);
    assert.equal(again.body.reference, first.body.reference);
    const workspace = [...db.workspaces.values()][0];
    assert.equal((workspace.state as DemoState).appointments.filter((item) => item.patient === "Parshva").length, 1);
  });

  it("rebooks after a cancellation instead of returning the cancelled booking", async () => {
    const { call } = await demoCall(newVisitor());
    const slot = await firstSlot(call, "Follow-up visit", 1);
    const first = await retell("create_appointment", { patient_name: "Samira Khan", appointment_type: "Follow-up visit", start_at: slot.start_at }, call);
    await retell("cancel_appointment", { booking_reference: first.body.reference, patient_name: "Samira Khan" }, call);
    const rebooked = await retell("create_appointment", { patient_name: "Samira Khan", appointment_type: "Follow-up visit", start_at: slot.start_at }, call);
    assert.equal(rebooked.body.success, true);
    assert.notEqual(rebooked.body.reference, first.body.reference);
    assert.equal(rebooked.body.appointment.status, "Confirmed");
  });

  it("keeps the previously published agent working: legacy arguments on the owner's test line", async () => {
    const call = ownerCall("call_booking");
    const availability = await retell("get_availability", { date: nextWeekday(), appointment_type: "Consultation", timezone: "Asia/Dubai" }, call);
    assert.equal(availability.status, 200);
    const slot = availability.body.slots[0];
    assert.match(slot.local_time, /\d{1,2}:\d{2} (AM|PM)$/, "local_time is kept for the old prompt");
    assert.match(slot.spoken, / (a|p)\.m\.$/);
    assert.ok(availability.body.slots.length <= 3);

    const args = { patient_name: "Jordan Lee", appointment_type: "Consultation", start_at: slot.start_at, timezone: "America/Chicago" };
    const booked = await retell("create_appointment", args, call);
    assert.equal(booked.body.success, true);
    assert.equal((await retell("create_appointment", args, call)).body.reference, booked.body.reference);

    const lookup = await retell("lookup_appointment", { booking_reference: booked.body.reference, verification_name: "Jordan Lee" }, call);
    assert.deepEqual([lookup.body.match, lookup.body.appointments[0].local_time], ["reference", slot.local_time]);
    const docs = await retell("check_document_status", { booking_reference: booked.body.reference, sample_patient_name: "Jordan Lee" }, call);
    assert.equal(docs.body.documents[0].status, "Needed");
    const later = await retell("get_availability", { date: nextWeekday(9), appointment_type: "Consultation" }, call);
    const moved = await retell("reschedule_appointment", { booking_reference: booked.body.reference, verification_name: "Jordan Lee", new_start_at: later.body.slots[0].start_at, timezone: "America/Chicago" }, call);
    assert.equal(moved.body.success, true, JSON.stringify(moved.body));
    const cancelled = await retell("cancel_appointment", { booking_reference: booked.body.reference, verification_name: "Jordan Lee" }, call);
    assert.equal(cancelled.body.appointment.status, "Cancelled");
    const waitlist = await retell("join_waitlist", { patient_name: "Jordan Lee", appointment_type: "Consultation", preferred_date: nextWeekday(), timezone: "America/Chicago" }, call);
    assert.equal(waitlist.body.success, true);
    assert.equal(db.workspaces.size, 1, "the owner's test calls share one fixed workspace");
  });

  it("finds bookings by name or by a spoken reference, and asks which one when several match", async () => {
    const { call } = await demoCall(newVisitor(), { callerTimezone: "Asia/Kolkata" });
    const byNumber = await retell("lookup_appointment", { booking_reference: "4812" }, call);
    assert.deepEqual([byNumber.body.success, byNumber.body.match, byNumber.body.appointments[0].reference_spoken], [true, "reference", "demo four eight one two"]);
    assert.match(byNumber.body.appointments[0].caller_time, /your time$/, "the caller is in another zone");
    assert.equal((await retell("lookup_appointment", { booking_reference: "demo 4812", patient_name: "maya" }, call)).body.success, true);
    assert.equal((await retell("lookup_appointment", { booking_reference: "DEMO-4812", patient_name: "Jordan Lee" }, call)).body.error, "sample_booking_not_found");
    assert.equal((await retell("lookup_appointment", { booking_reference: "48" }, call)).body.error, "invalid_reference");
    const byName = await retell("lookup_appointment", { patient_name: "Samira Khan" }, call);
    assert.deepEqual([byName.body.match, byName.body.appointments.length], ["exact", 1]);

    const slot = await firstSlot(call);
    await retell("create_appointment", { patient_name: "Anna Smith", appointment_type: "Consultation", start_at: slot.start_at }, call);
    const other = await firstSlot(call, "Follow-up visit", 2);
    await retell("create_appointment", { patient_name: "Anna Jones", appointment_type: "Follow-up visit", start_at: other.start_at }, call);
    const both = await retell("lookup_appointment", { patient_name: "anna" }, call);
    assert.deepEqual([both.body.match, both.body.appointments.length], ["first-name", 2]);
    assert.match(both.body.message, /Ask which one/);
    assert.equal((await retell("lookup_appointment", {}, call)).body.success, false);
  });

  it("searches several days for a part of the day and offers at most three spread-out times", async () => {
    const { call } = await demoCall(newVisitor());
    const result = await retell("get_availability", { start_date: nextWeekday(), search_days: 5, time_of_day: "morning", appointment_type: "Follow-up visit", provider: "Doctor Chen" }, call);
    assert.equal(result.body.success, true);
    assert.equal(result.body.slots.length, 3);
    assert.equal(result.body.more_available, true);
    assert.ok(result.body.slots.every((slot: Record<string, string>) => /a\.m\.$/.test(slot.spoken) && slot.provider === "Dr. Avery Chen"));
    assert.equal(result.body.searched_from, nextWeekday());
    assert.equal((await retell("get_availability", { start_date: "next friday", appointment_type: "Consultation" }, call)).body.error, "invalid_date");
    assert.equal((await retell("get_availability", { start_date: nextWeekday(), search_days: 30, appointment_type: "Consultation" }, call)).body.error, "invalid_range");
  });

  it("adds seconds_left from the call start, or from when the call was placed", async () => {
    const placed = await demoCall(newVisitor(), { placedAgo: 60_000 });
    const fromPlaced = await retell("search_approved_faq", { question: "What are your hours?" }, placed.call);
    assert.ok(fromPlaced.body.seconds_left >= 238 && fromPlaced.body.seconds_left <= 240, String(fromPlaced.body.seconds_left));
    const started = await demoCall(newVisitor(), { placedAgo: 120_000, startedAgo: 100_000 });
    const fromStart = await retell("lookup_appointment", { booking_reference: "DEMO-9999" }, started.call);
    assert.equal(fromStart.body.success, false);
    assert.ok(fromStart.body.seconds_left >= 198 && fromStart.body.seconds_left <= 200, "failures carry it too");
    const late = await demoCall(newVisitor(), { placedAgo: 400_000 });
    assert.equal((await retell("search_approved_faq", { question: "hours?" }, late.call)).body.seconds_left, 0);
    assert.equal((await retell("search_approved_faq", { question: "hours?" }, ownerCall())).body.seconds_left, undefined);
  });

  it("returns business failures as success=false so the agent can respond", async () => {
    const { call } = await demoCall(newVisitor());
    const offGrid = await retell("create_appointment", { patient_name: "Maya Patel", appointment_type: "Consultation", start_at: `${nextWeekday()}T03:07:00.000Z` }, call);
    assert.deepEqual([offGrid.status, offGrid.body.success, offGrid.body.error], [200, false, "slot_unavailable"]);
    assert.equal((await retell("create_appointment", { patient_name: "R2-D2", appointment_type: "Consultation", start_at: `${nextWeekday()}T15:00:00.000Z` }, call)).body.error, "invalid_name");
    assert.equal((await retell("delete_everything", {}, call)).body.error, "unknown_function");
    assert.equal(db.workspaces.size, 0, "failed requests never create a workspace");
  });

  it("answers service_unavailable (and asks for one identical retry) when the database fails", async () => {
    const { call } = await demoCall(newVisitor());
    const slot = await firstSlot(call);
    db.failing.add("healthcare_save_workspace");
    const failed = await retell("create_appointment", { patient_name: "Maya Patel", appointment_type: "Consultation", start_at: slot.start_at }, call);
    assert.deepEqual([failed.status, failed.body.success, failed.body.error], [200, false, "service_unavailable"]);
    assert.match(failed.body.message, /once more with exactly the same details/);
  });

  it("creates one staff task per request type per call, optionally under the caller's name", async () => {
    const visitor = newVisitor();
    const { call } = await demoCall(visitor);
    await retell("request_staff_followup", { request_type: "accessibility", patient_name: "Priya" }, call);
    await retell("request_staff_followup", { request_type: "accessibility", patient_name: "priya" }, call);
    const tasks = (await visitorState(visitor)).state.tasks.filter((item) => item.title === "Accessibility or interpreter request");
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].patient, "Priya");
    assert.equal((await retell("request_staff_followup", { request_type: "faq_review" }, call)).body.error, "invalid_request_type");
  });

  it("routes refill questions to staff and medical questions to the safety answer", async () => {
    const call = ownerCall();
    const refill = await retell("search_approved_faq", { question: "Can you refill my prescription?" }, call);
    assert.deepEqual([refill.body.handoff, refill.body.suggested_request_type], [true, "refill"]);
    const clinical = await retell("search_approved_faq", { question: "Is this rash serious?" }, call);
    assert.match(clinical.body.answer, /cannot answer medical questions/);
  });
});

describe("Retell tools and the workspace lifecycle", () => {
  it("serves a linked call from a seed until its first change, then creates the workspace", async () => {
    const visitor = newVisitor();
    const { call, workspaceId } = await demoCall(visitor);
    assert.equal((await retell("lookup_appointment", { booking_reference: "DEMO-4812" }, call)).body.success, true);
    assert.equal(db.workspaces.size, 0, "reads do not write");
    await retell("request_staff_followup", { request_type: "callback" }, call);
    assert.ok(db.workspace(workspaceId));
  });

  it("refuses tool calls once the visitor deleted their demo", async () => {
    const visitor = newVisitor();
    const { call, callId, requestId } = await demoCall(visitor);
    await retell("request_staff_followup", { request_type: "callback" }, call);
    await event("call_ended", call, { disconnection_reason: "user_hangup" });
    const forget = await fetchHandler(new Request("https://worker.example/api/demo/forget", { method: "POST", headers: { Origin: "https://demo.example", "X-Demo-Visitor": visitor }, body: "{}" }), env);
    assert.equal(forget.status, 200);
    assert.equal(db.call(requestId)!.workspaceId, null, "the call request is detached");
    for (const [name, args] of [["lookup_appointment", { booking_reference: "DEMO-4812" }], ["request_staff_followup", { request_type: "billing" }]] as const) {
      const result = await retell(name, args, call);
      assert.deepEqual([result.body.success, result.body.error], [false, "session_cleared"], name);
    }
    assert.equal(db.workspaces.size, 0, "a late tool call does not bring the demo back");
    assert.ok(callId);
  });

  it("refuses forget while the call may still be live", async () => {
    const visitor = newVisitor();
    await demoCall(visitor);
    const response = await fetchHandler(new Request("https://worker.example/api/demo/forget", { method: "POST", headers: { Origin: "https://demo.example", "X-Demo-Visitor": visitor }, body: "{}" }), env);
    assert.equal(response.status, 409);
    assert.equal((await response.json() as Record<string, any>).error.code, "call_in_progress");
  });

  it("refuses demo calls whose metadata names no linked workspace", async () => {
    const unlinked = await demoCall(newVisitor(), { stored: false });
    assert.equal((await retell("lookup_appointment", { booking_reference: "DEMO-4812" }, unlinked.call)).body.error, "session_cleared");
    const { call } = await demoCall(newVisitor());
    const noWorkspace = { ...call, metadata: { source: "healthcare-web-demo", request_id: crypto.randomUUID() } };
    assert.equal((await retell("lookup_appointment", { booking_reference: "DEMO-4812" }, noWorkspace)).body.error, "session_cleared");
    const badWorkspace = { ...call, metadata: { ...(call.metadata as Call), workspace: "not-a-workspace" } };
    assert.equal((await retell("lookup_appointment", { booking_reference: "DEMO-4812" }, badWorkspace)).body.error, "session_cleared");
  });

  it("blocks the dialled number after report_wrong_number, and does nothing for browser calls", async () => {
    const phone = await demoCall(newVisitor(), { channel: "phone" });
    const reported = await retell("report_wrong_number", {}, phone.call);
    assert.deepEqual(reported.body, { success: true, message: "Apologise in one sentence and end the call.", seconds_left: reported.body.seconds_left });
    assert.ok(db.call(phone.requestId)!.suppressedUntil! > Date.now() + 29 * 86_400_000);
    const web = await demoCall(newVisitor());
    assert.equal((await retell("report_wrong_number", {}, web.call)).body.success, true);
    assert.equal(db.call(web.requestId)!.suppressedUntil, null);
  });

  it("logs each tool's timing after the response, through waitUntil", async () => {
    const { call, requestId } = await demoCall(newVisitor());
    const pending: Promise<unknown>[] = [];
    const result = await retell("get_availability", { start_date: nextWeekday(), appointment_type: "Consultation" }, call, { context: { waitUntil: (promise) => { pending.push(promise); } } });
    assert.equal(result.body.success, true);
    assert.equal(pending.length, 1);
    await Promise.all(pending);
    const [entry] = db.call(requestId)!.toolLog;
    assert.deepEqual([entry.tool, entry.ok, typeof entry.ms], ["get_availability", true, "number"]);
    await retell("lookup_appointment", { booking_reference: "DEMO-0000" }, call);
    assert.deepEqual(db.call(requestId)!.toolLog.map((item) => item.ok), [true, false]);
  });
});

describe("Retell call events", () => {
  it("stores call_started / call_ended with the disconnection reason, linking by request_id", async () => {
    const visitor = newVisitor();
    const { call, requestId, workspaceId } = await demoCall(visitor);
    db.call(requestId)!.retellCallId = null;
    await fetchHandler(new Request("https://worker.example/api/demo/actions", { method: "POST", headers: { Origin: "https://demo.example", "X-Demo-Visitor": visitor }, body: JSON.stringify({ idempotencyKey: "events-key-1", action: { type: "create_task", requestType: "callback" } }) }), env);
    db.workspace(workspaceId)!.lastUsedAt = 0;

    assert.equal((await event("call_started", call, { start_timestamp: Date.now() - 1000 })).status, 200);
    assert.equal(db.call(requestId)!.retellCallId, call.call_id, "the call ID is filled in from the event");
    assert.equal((await event("call_ended", call, { end_timestamp: Date.now(), disconnection_reason: "user_hangup" })).status, 200);
    assert.equal(db.events.get(`${call.call_id}|call_ended`)!.detail, "user_hangup");
    assert.ok(db.workspace(workspaceId)!.lastUsedAt > 0, "the call's end counts as a use of the demo");
    assert.ok(!JSON.stringify([...db.events.values()]).includes("secret"), "no transcript is stored");

    assert.equal((await event("call_analyzed", call)).status, 200);
    assert.ok(!db.events.has(`${call.call_id}|call_analyzed`), "other events are acknowledged and dropped");
    assert.equal((await event("call_ended", { ...call, agent_id: "agent_other" })).status, 403);
    assert.equal((await event("call_ended", { ...call, call_id: "call_odd" }, { disconnection_reason: "Not A Code!" })).status, 200);
    assert.equal(db.events.get("call_odd|call_ended")!.detail, null, "unexpected reasons are not stored");
  });

  it("accepts event bodies up to 1 MB and refuses larger ones", async () => {
    const { call } = await demoCall(newVisitor());
    const big = JSON.stringify({ event: "call_ended", call: { ...call, transcript: "x".repeat(900_000) } });
    const ok = await fetchHandler(new Request("https://worker.example/webhooks/retell/events", { method: "POST", headers: { "X-Retell-Signature": await sign(big, API_KEY) }, body: big }), env);
    assert.equal(ok.status, 200);
    const tooBig = JSON.stringify({ event: "call_ended", call: { ...call, transcript: "x".repeat(1_100_000) } });
    const refused = await fetchHandler(new Request("https://worker.example/webhooks/retell/events", { method: "POST", headers: { "X-Retell-Signature": await sign(tooBig, API_KEY) }, body: tooBig }), env);
    assert.equal(refused.status, 413);
  });
});
