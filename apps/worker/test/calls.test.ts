import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fetchHandler } from "../src/app.ts";
import type { Env } from "../src/app.ts";
import { callOutcome } from "../src/calls.ts";
import { beginMessages } from "../src/context.ts";
import { keyedHash } from "../src/store.ts";
import { allowedDemoPatients } from "../../../packages/shared/src/index.ts";
import { FakeSupabase, SUPABASE_URL, installFetch, json, newVisitor, nextWeekday, sign } from "./harness.ts";

// Fakes for Supabase RPCs, Cloudflare Turnstile, and Retell's call APIs. No request leaves the process.
let db: FakeSupabase;
let restore: () => void;
let retellRequests: Array<{ path: string; method: string; body: Record<string, any> | null }>;
let retellMode: "ok" | "timeout" | "unreachable" | number;
let getCallResponse: Record<string, unknown> | null;
let turnstileOk: boolean;
let turnstileIps: Array<string | null>;
const OWNER = "+15125550100";
const AGENT = "agent_bcd0e610f4535270f5642efeb0";
const EVENTS_URL = "https://ai-healthcare-front-desk-api.halo-voice-parshva.workers.dev/webhooks/retell/events";
const env: Env = {
  SUPABASE_URL, SUPABASE_SECRET_KEY: "sb_secret_test", PUBLIC_ORIGINS: "https://demo.example",
  RETELL_API_KEY: "test-retell-key", RETELL_TEST_NUMBERS: OWNER, DEMO_CALLS: "on", DEMO_WEB_CALLS: "on", RETELL_FROM_NUMBER: "+15128231502",
  RETELL_AGENT_ID: AGENT, RETELL_AGENT_VERSION: "0", RETELL_EVENTS_URL: EVENTS_URL, TURNSTILE_SECRET_KEY: "turnstile-secret", TURNSTILE_HOSTNAME: "demo.example",
  MAX_CALLS_PER_DAY: "10", MAX_CALLS_PER_IP_PER_DAY: "3", PHONE_COOLDOWN_MINUTES: "30", MAX_CALL_DURATION_SECONDS: "300",
};

beforeEach(() => {
  db = new FakeSupabase();
  retellRequests = []; retellMode = "ok"; getCallResponse = null; turnstileOk = true; turnstileIps = [];
  restore = installFetch(db, {
    turnstile: (_url, init) => {
      const form = new URLSearchParams(String(init?.body));
      assert.equal(form.get("secret"), "turnstile-secret");
      turnstileIps.push(form.get("remoteip"));
      return json({ success: turnstileOk, hostname: "demo.example", action: "healthcare_demo_call" });
    },
    retell: (url, init) => {
      assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer test-retell-key");
      retellRequests.push({ path: url.pathname, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
      if (url.pathname.startsWith("/v2/get-call/")) return getCallResponse ? json(getCallResponse) : json({ message: "not found" }, 404);
      if (retellMode === "timeout") throw new DOMException("The operation timed out.", "TimeoutError");
      if (retellMode === "unreachable") throw new TypeError("fetch failed");
      if (typeof retellMode === "number") return json({ message: "rejected" }, retellMode);
      const callId = `call_${retellRequests.length}`;
      return url.pathname === "/v3/create-web-call"
        ? json({ call_id: callId, access_token: `token_${callId}`, transport: "livekit", ice_servers: [{ urls: "stun:stun.example" }], agent_id: AGENT }, 201)
        : json({ call_id: callId }, 201);
    },
  });
});
afterEach(() => restore());

interface Options { visitor?: string; ip?: string; overrides?: Partial<Env>; country?: string }

function send(path: string, body: unknown, options: Options = {}) {
  const request = new Request(`https://worker.example${path}`, {
    method: "POST", body: JSON.stringify(body),
    headers: { "Content-Type": "application/json", Origin: "https://demo.example", "CF-Connecting-IP": options.ip ?? "203.0.113.7", "X-Demo-Visitor": options.visitor ?? newVisitor() },
  });
  if (options.country) Object.defineProperty(request, "cf", { value: { country: options.country } });
  return fetchHandler(request, { ...env, ...options.overrides });
}
const phoneCall = (phoneNumber: string, options: Options = {}, extra: Record<string, unknown> = {}) => send("/api/demo-call", { phoneNumber, consent: true, turnstileToken: "token-from-turnstile-widget", ...extra }, options);
const webCall = (options: Options = {}, extra: Record<string, unknown> = {}) => send("/api/demo-web-call", { consent: true, turnstileToken: "token-from-turnstile-widget", ...extra }, options);
const bodyOf = async (response: Response) => await response.json() as Record<string, any>;
const created = () => retellRequests.filter((item) => item.path.startsWith("/v2/create") || item.path.startsWith("/v3/create"));

async function status(ref: string, visitor: string) {
  const response = await fetchHandler(new Request(`https://worker.example/api/demo-call/status?ref=${ref}`, { headers: { Origin: "https://demo.example", "X-Demo-Visitor": visitor } }), env);
  return { status: response.status, body: await bodyOf(response) };
}

async function retellEvent(name: string, call: Record<string, unknown>) {
  const raw = JSON.stringify({ event: name, call });
  const response = await fetchHandler(new Request("https://worker.example/webhooks/retell/events", { method: "POST", headers: { "X-Retell-Signature": await sign(raw, "test-retell-key") }, body: raw }), env);
  assert.equal(response.status, 200);
}

/** Ends the call Retell created for this reference, as Retell's webhook would. */
async function endCall(ref: string, reason = "user_hangup") {
  const row = db.call(ref)!;
  await retellEvent("call_ended", { call_id: row.retellCallId, call_type: row.channel === "web" ? "web_call" : "phone_call", direction: "outbound", agent_id: AGENT, disconnection_reason: reason, metadata: { source: "healthcare-web-demo", request_id: ref } });
}

const names = (text: string) => [...allowedDemoPatients, "Parshva"].filter((name) => text.includes(name));

describe("Call my phone", () => {
  it("places one call with the per-call context, pinned agent version and event webhook", async () => {
    const visitor = newVisitor();
    const response = await phoneCall("+1 (415) 555-0123", { visitor }, { timezone: "America/New_York" });
    assert.equal(response.status, 200);
    const body = await bodyOf(response);
    assert.deepEqual({ ...body, callRef: "ref" }, { status: "calling", callRef: "ref", channel: "phone", country: "US", maskedNumber: "+1 (•••) •••-0123", fromNumber: "+1 (512) 823-1502", maxMinutes: 5 });
    assert.match(body.callRef, /^[0-9a-f-]{36}$/);
    const [request] = created();
    assert.equal(request.path, "/v2/create-phone-call");
    const sent = request.body!;
    const workspaceId = await keyedHash(env, "visitor-workspace", visitor);
    assert.deepEqual(Object.keys(sent).sort(), ["agent_override", "from_number", "idempotency_key", "metadata", "override_agent_id", "override_agent_version", "retell_llm_dynamic_variables", "to_number"]);
    assert.deepEqual([sent.from_number, sent.to_number, sent.override_agent_id, sent.override_agent_version, sent.idempotency_key], ["+15128231502", "+14155550123", AGENT, 0, body.callRef]);
    assert.deepEqual(sent.agent_override, {
      agent: { max_call_duration_ms: 300_000, webhook_url: EVENTS_URL, webhook_events: ["call_started", "call_ended"] },
      retell_llm: { begin_message: beginMessages.phoneNew },
    });
    assert.deepEqual({ ...sent.metadata, placed_at: 0 }, { source: "healthcare-web-demo", request_id: body.callRef, workspace: workspaceId, channel: "phone", caller_timezone: "America/New_York", placed_at: 0, max_seconds: "300" });
    assert.ok(Math.abs(sent.metadata.placed_at - Date.now()) < 5_000);
    const variables = sent.retell_llm_dynamic_variables;
    assert.deepEqual(Object.keys(variables).sort(), ["call_channel", "caller_booking_count", "caller_status", "caller_time_differs", "caller_timezone", "clinic_calendar", "clinic_timezone_label", "clinic_today", "crisis_line", "emergency_number", "max_minutes"]);
    assert.ok(Object.values(variables).every((value) => typeof value === "string"), "dynamic variables are strings");
    assert.deepEqual([variables.caller_status, variables.caller_booking_count, variables.call_channel, variables.caller_timezone, variables.caller_time_differs, variables.emergency_number, variables.crisis_line, variables.max_minutes, variables.clinic_timezone_label],
      ["new", "0", "phone", "America/New_York", "yes", "911", "988", "5", "Central time"]);
    assert.match(variables.clinic_today, /^[A-Z][a-z]+day, [A-Z][a-z]+ \d{1,2}(st|nd|rd|th), \d{4}$/);
    assert.equal(variables.clinic_calendar.split("\n").length, 14);
    assert.deepEqual(names(JSON.stringify(sent)), [], "no names in anything sent to Retell");
    const row = db.call(body.callRef)!;
    assert.deepEqual([row.status, row.channel, row.workspaceId, row.retellCallId], ["placed", "phone", workspaceId, "call_1"]);
    assert.ok(!JSON.stringify(db.calls).includes("4155550123"), "the phone number itself is never stored");
    assert.ok(db.workspace(workspaceId)!.hadCall, "the visitor's demo was created and marked");
  });

  it("uses India's zone and numbers for +91, and the clinic zone for a non-US browser zone on a +1 number", async () => {
    await phoneCall("+91 98765 43210", {}, { timezone: "America/Chicago" });
    await phoneCall("+1 212 555 0199", {}, { timezone: "Europe/London" });
    const [india, us] = created().map((item) => item.body!.retell_llm_dynamic_variables);
    assert.deepEqual([india.caller_timezone, india.emergency_number, india.crisis_line, india.caller_time_differs], ["Asia/Kolkata", "112", "Tele-MANAS on 14416", "yes"]);
    assert.deepEqual([us.caller_timezone, us.caller_time_differs], ["America/Chicago", "no"]);
  });

  it("sends latest_published and no webhook when those settings are unset", async () => {
    assert.equal((await phoneCall("+14155550123", { overrides: { RETELL_AGENT_VERSION: undefined, RETELL_EVENTS_URL: undefined } })).status, 200);
    const [request] = created();
    assert.equal(request.body!.override_agent_version, "latest_published");
    assert.deepEqual(request.body!.agent_override.agent, { max_call_duration_ms: 300_000 });
  });

  it("greets a returning visitor without saying any name", async () => {
    const visitor = newVisitor();
    const first = await bodyOf(await phoneCall("+14155550123", { visitor }));
    // The visitor booked under their own name during that call.
    const workspaceId = await keyedHash(env, "visitor-workspace", visitor);
    const call = { call_id: "call_1", call_type: "phone_call", direction: "outbound", agent_id: AGENT, metadata: { source: "healthcare-web-demo", request_id: first.callRef, workspace: workspaceId } };
    const availability = await fetchHandler(await signedTool("get_availability", { start_date: nextWeekday(), appointment_type: "Consultation" }, call), env);
    const slot = (await bodyOf(availability)).slots[0];
    const booked = await bodyOf(await fetchHandler(await signedTool("create_appointment", { patient_name: "Parshva", appointment_type: "Consultation", start_at: slot.start_at }, call), env));
    assert.equal(booked.success, true);
    await endCall(first.callRef);

    assert.equal((await webCall({ visitor })).status, 200);
    const sent = created()[1].body!;
    assert.equal(sent.agent_override.retell_llm.begin_message, beginMessages.browserReturning);
    assert.deepEqual([sent.retell_llm_dynamic_variables.caller_status, sent.retell_llm_dynamic_variables.caller_booking_count], ["returning", "1"]);
    assert.deepEqual(names(JSON.stringify(sent)), []);
  });

  it("reports health with both call switches and keeps SMS off", async () => {
    const health = await bodyOf(await fetchHandler(new Request("https://worker.example/api/health"), env));
    assert.deepEqual([health.liveCallsEnabled, health.liveSmsEnabled, health.demoCalls.fromNumber, health.demoCalls.maxCallsPerDay, health.demoCalls.web], [true, false, "+1 (512) 823-1502", 10, { enabled: true }]);
    const webOff = await bodyOf(await fetchHandler(new Request("https://worker.example/api/health"), { ...env, DEMO_WEB_CALLS: "off" }));
    assert.deepEqual([webOff.demoCalls.enabled, webOff.demoCalls.web], [true, { enabled: false }]);
    const off = await bodyOf(await fetchHandler(new Request("https://worker.example/api/health"), { ...env, TURNSTILE_SECRET_KEY: "" }));
    assert.deepEqual([off.liveCallsEnabled, off.demoCalls], [false, { enabled: false, web: { enabled: false } }]);
  });

  it("is off unless every setting is present and well formed", async () => {
    for (const overrides of [{ DEMO_CALLS: "off" }, { TURNSTILE_SECRET_KEY: "" }, { RETELL_AGENT_ID: "not-an-agent" }, { RETELL_FROM_NUMBER: "+919876543210" }, { RETELL_AGENT_VERSION: "v2" }, { RETELL_EVENTS_URL: "http://insecure.example/events" }]) {
      const response = await phoneCall("+14155550123", { overrides });
      assert.deepEqual([response.status, (await bodyOf(response)).error.code], [503, "demo_calls_off"], JSON.stringify(overrides));
    }
    assert.equal(created().length, 0);
  });

  it("requires consent, a valid US/India number with country code, and a passed security check", async () => {
    assert.equal((await bodyOf(await phoneCall("+14155550123", {}, { consent: false }))).error.code, "consent_required");
    assert.equal((await phoneCall("4155550123")).status, 400);
    assert.equal((await phoneCall("+44 20 7183 8750")).status, 400);
    assert.equal((await phoneCall("+14155550123", {}, { extra: "x" })).status, 400);
    turnstileOk = false;
    assert.equal((await bodyOf(await phoneCall("+14155550123"))).error.code, "verification_failed");
    assert.equal(created().length, 0);
    assert.equal(db.workspaces.size, 0, "no workspace before the security check passes");
  });

  it("enforces the per-number cooldown and daily cap for visitors, but not for the owner's number", async () => {
    const overrides = { MAX_CALLS_PER_DAY: "2", MAX_CALLS_PER_IP_PER_DAY: "5" };
    assert.equal((await phoneCall("+14155550123", { overrides })).status, 200);
    const again = await phoneCall("+14155550123", { overrides });
    assert.equal(again.status, 429);
    assert.equal((await bodyOf(again)).error.code, "phone_cooldown");
    assert.ok(Number(again.headers.get("Retry-After")) > 0);
    assert.equal((await phoneCall("+919876543210", { overrides })).status, 200);
    const third = await bodyOf(await phoneCall("+12125550199", { overrides }));
    assert.equal(third.error.code, "daily_limit");
    assert.ok(third.retryAfterSeconds > 0);
    // (From other connections: every new browser here also creates a demo, and those are limited to 6 per connection per hour.)
    for (let i = 0; i < 4; i += 1) assert.equal((await phoneCall("+1 512 555 0100", { overrides, ip: `198.51.100.${i + 1}` })).status, 200, `owner call ${i}`);
    assert.equal(created().length, 6);
  });

  it("does not count a call the provider rejected, and counts one whose creation timed out", async () => {
    retellMode = 422;
    const rejected = await phoneCall("+919876543210");
    assert.equal(rejected.status, 422);
    assert.match((await bodyOf(rejected)).error.message, /India/);
    assert.equal(db.calls[0].status, "failed");
    retellMode = "timeout";
    const timedOut = await phoneCall("+919876543210");
    assert.deepEqual([timedOut.status, (await bodyOf(timedOut)).error.code], [503, "calls_unavailable"]);
    assert.equal(db.calls[1].status, "unknown");
    retellMode = "ok";
    assert.equal((await bodyOf(await phoneCall("+919876543210"))).error.code, "phone_cooldown", "an unknown outcome still counts");
  });

  it("blocks a number for 30 days after the person who answered reported a wrong number", async () => {
    const first = await bodyOf(await phoneCall("+14155550123"));
    const row = db.call(first.callRef)!;
    const call = { call_id: row.retellCallId, call_type: "phone_call", direction: "outbound", agent_id: AGENT, metadata: { source: "healthcare-web-demo", request_id: first.callRef, workspace: row.workspaceId } };
    assert.equal((await bodyOf(await fetchHandler(await signedTool("report_wrong_number", {}, call), env))).success, true);
    await endCall(first.callRef);
    row.createdAt -= 31 * 60_000;
    const blocked = await phoneCall("+14155550123", { ip: "198.51.100.9" });
    assert.deepEqual([blocked.status, (await bodyOf(blocked)).error.code], [403, "number_blocked"]);
    assert.ok(Number(blocked.headers.get("Retry-After")) > 29 * 86_400);
    assert.equal((await phoneCall("+1 512 555 0100")).status, 200, "the owner's numbers are never blocked");
  });
});

describe("Talk in browser", () => {
  it("creates a v3 web call with the same context and returns the access token", async () => {
    const visitor = newVisitor();
    const response = await webCall({ visitor, country: "IN" }, { timezone: "Asia/Kolkata" });
    assert.equal(response.status, 200);
    const body = await bodyOf(response);
    assert.deepEqual({ ...body, callRef: "ref", expiresAt: 0 }, { callRef: "ref", channel: "web", callId: "call_1", accessToken: "token_call_1", transport: "livekit", iceServers: [{ urls: "stun:stun.example" }], expiresAt: 0, maxMinutes: 5 });
    assert.ok(body.expiresAt > Date.now() && body.expiresAt <= Date.now() + 31_000);
    const [request] = created();
    assert.equal(request.path, "/v3/create-web-call");
    const sent = request.body!;
    assert.deepEqual(Object.keys(sent).sort(), ["agent_id", "agent_override", "agent_version", "metadata", "retell_llm_dynamic_variables"]);
    assert.deepEqual([sent.agent_id, sent.agent_version], [AGENT, 0]);
    assert.deepEqual(sent.agent_override, {
      agent: { max_call_duration_ms: 300_000, webhook_url: EVENTS_URL, webhook_events: ["call_started", "call_ended"] },
      retell_llm: { begin_message: beginMessages.browserNew },
    });
    assert.deepEqual([sent.metadata.channel, sent.metadata.workspace, sent.metadata.request_id, sent.metadata.caller_timezone], ["web", await keyedHash(env, "visitor-workspace", visitor), body.callRef, "Asia/Kolkata"]);
    const variables = sent.retell_llm_dynamic_variables;
    assert.deepEqual([variables.call_channel, variables.caller_timezone, variables.emergency_number, variables.crisis_line], ["browser", "Asia/Kolkata", "112", "Tele-MANAS on 14416"]);
    assert.deepEqual([db.call(body.callRef)!.channel, db.call(body.callRef)!.phoneHash, db.call(body.callRef)!.owner], ["web", null, false]);
  });

  it("uses generic safety wording when the visitor's country is unknown", async () => {
    await webCall({}, { timezone: "Not/AZone" });
    const variables = created()[0].body!.retell_llm_dynamic_variables;
    assert.deepEqual([variables.caller_timezone, variables.emergency_number, variables.crisis_line, variables.caller_time_differs], ["America/Chicago", "your local emergency number", "a local crisis line", "no"]);
  });

  it("has its own switch, and needs the events webhook", async () => {
    for (const overrides of [{ DEMO_WEB_CALLS: "off" }, { RETELL_EVENTS_URL: "" }]) {
      const response = await webCall({ overrides });
      assert.deepEqual([response.status, (await bodyOf(response)).error.code], [503, "web_calls_off"]);
    }
    assert.deepEqual([(await webCall({ overrides: { DEMO_CALLS: "off" } })).status, created().length], [503, 0]);
    assert.equal((await phoneCall("+14155550123", { overrides: { DEMO_WEB_CALLS: "off" } })).status, 200, "phone calls do not depend on it");
  });

  it("shares one budget with phone calls", async () => {
    assert.equal((await phoneCall("+14155550123")).status, 200);
    assert.equal((await webCall()).status, 200);
    assert.equal((await phoneCall("+14155550124")).status, 200);
    const refused = await webCall();
    assert.deepEqual([refused.status, (await bodyOf(refused)).error.code], [429, "ip_daily_limit"]);
    assert.equal((await webCall({ ip: "198.51.100.20" })).status, 200, "another client still has calls");
    const daily = await webCall({ ip: "198.51.100.21", overrides: { MAX_CALLS_PER_DAY: "4" } });
    assert.equal((await bodyOf(daily)).error.code, "daily_limit");
  });

  it("counts a browser call that never reported call_started (fails closed)", async () => {
    for (let i = 0; i < 3; i += 1) assert.equal((await webCall()).status, 200);
    for (const row of db.calls) row.createdAt -= 10 * 60_000;
    assert.equal((await bodyOf(await webCall())).error.code, "ip_daily_limit", "no evidence that they never connected");
  });

  it("keys client limits by IPv6 /64 but gives Turnstile the real address", async () => {
    assert.equal((await webCall({ ip: "2001:db8:aa:1::1" })).status, 200);
    assert.equal((await webCall({ ip: "2001:db8:aa:1::2" })).status, 200);
    assert.equal((await webCall({ ip: "2001:db8:aa:1:ffff::3" })).status, 200);
    assert.equal((await bodyOf(await webCall({ ip: "2001:db8:aa:1::4" }))).error.code, "ip_daily_limit");
    assert.equal(turnstileIps[0], "2001:db8:aa:1::1");
  });
});

/** Plays Retell's webhooks for a call this test placed. */
async function report(callRef: string, events: Array<["call_started"] | ["call_ended", string]>) {
  const row = db.call(callRef)!;
  const call = { call_id: row.retellCallId, call_type: row.channel === "web" ? "web_call" : "phone_call", direction: "outbound", agent_id: AGENT, metadata: { source: "healthcare-web-demo", request_id: callRef } };
  for (const [name, reason] of events) await retellEvent(name, { ...call, ...(reason ? { disconnection_reason: reason } : {}) });
}

const release = (callRef: string, visitor: string) => fetchHandler(new Request("https://worker.example/api/demo-call/release", {
  method: "POST", headers: { Origin: "https://demo.example", "X-Demo-Visitor": visitor }, body: JSON.stringify({ callRef }),
}), env);

describe("the call budget fails closed (review findings)", () => {
  it("(a) reserve → token → release in a loop cannot exceed the per-connection budget", async () => {
    const visitor = newVisitor();
    for (let i = 0; i < 3; i += 1) {
      const call = await bodyOf(await webCall({ visitor }));
      assert.ok(call.accessToken, `call ${i + 1}`);
      assert.deepEqual(await bodyOf(await release(call.callRef, visitor)), { released: true });
      // Released tokens still block for 45 seconds, so no two are usable at once; let that time pass.
      assert.equal((await bodyOf(await webCall({ visitor }))).error.code, "call_in_progress");
      for (const row of db.calls) row.createdAt -= 46_000;
    }
    for (let i = 0; i < 2; i += 1) {
      const refused = await webCall({ visitor });
      assert.deepEqual([refused.status, (await bodyOf(refused)).error.code], [429, "ip_daily_limit"], "released calls still count");
    }
    assert.equal(created().length, 3, "no fourth access token was issued");
  });

  it("(b) calls that started count, whatever error they ended with", async () => {
    for (let i = 0; i < 3; i += 1) {
      const { callRef } = await bodyOf(await webCall());
      await report(callRef, [["call_started"], ["call_ended", "error_no_audio_received"]]);
    }
    assert.equal(db.calls.filter((row) => db.counts(row)).length, 3);
    assert.equal((await bodyOf(await webCall())).error.code, "ip_daily_limit");
  });

  it("(c) a call_ended with a normal reason counts even without call_started; a never-joined browser does not", async () => {
    const free = await bodyOf(await webCall());
    await report(free.callRef, [["call_ended", "error_user_not_joined"]]);
    for (let i = 0; i < 3; i += 1) {
      const { callRef } = await bodyOf(await webCall());
      await report(callRef, [["call_ended", "user_hangup"]]);
    }
    assert.deepEqual(db.calls.map((row) => db.counts(row)), [false, true, true, true]);
    assert.equal((await bodyOf(await webCall())).error.code, "ip_daily_limit");
  });

  it("(d) a number the provider could not dial neither counts nor starts the cooldown; an unanswered one does", async () => {
    const blocked = await bodyOf(await phoneCall("+919876543210"));
    await report(blocked.callRef, [["call_ended", "telephony_provider_permission_denied"]]);
    assert.equal(db.counts(db.call(blocked.callRef)!), false);
    const retry = await bodyOf(await phoneCall("+919876543210"));
    assert.equal(retry.status, "calling", "no cooldown for a call that never rang");
    await report(retry.callRef, [["call_ended", "dial_no_answer"]]);
    assert.equal((await bodyOf(await phoneCall("+919876543210"))).error.code, "phone_cooldown", "a call that rang does");
  });

  it("(e) a phone call with no events stops blocking the browser after 2 minutes, but still counts", async () => {
    const visitor = newVisitor();
    const phone = await bodyOf(await phoneCall("+14155550123", { visitor }));
    assert.equal((await bodyOf(await webCall({ visitor }))).error.code, "call_in_progress", "within 2 minutes it may still ring");
    db.call(phone.callRef)!.createdAt -= 150_000;
    assert.equal((await status(phone.callRef, visitor)).body.phase, "unknown");
    const web = await bodyOf(await webCall({ visitor }));
    assert.ok(web.accessToken, "\"Phone didn't ring? Talk in browser\" works");
    assert.equal((await webCall()).status, 200, "third call");
    assert.equal((await bodyOf(await webCall())).error.code, "ip_daily_limit", "the silent phone call still counted");
  });

  it("keeps a call stuck in 'unknown' (Retell timed out) active for 2 minutes, then only counted", async () => {
    const visitor = newVisitor();
    retellMode = "timeout";
    assert.equal((await phoneCall("+14155550123", { visitor })).status, 503);
    retellMode = "ok";
    assert.equal((await bodyOf(await webCall({ visitor }))).error.code, "call_in_progress");
    db.calls[0].createdAt -= 150_000;
    assert.equal((await webCall({ visitor })).status, 200);
  });
});

/** A signed custom-function request (used to act inside a call placed by these tests). */
async function signedTool(name: string, args: Record<string, unknown>, call: Record<string, unknown>) {
  const raw = JSON.stringify({ name, args, call });
  return new Request("https://worker.example/webhooks/retell/custom-function", { method: "POST", headers: { "X-Retell-Signature": await sign(raw, "test-retell-key") }, body: raw });
}

describe("one call at a time, status and release", () => {
  it("refuses a second call from the same browser while one may be live", async () => {
    const visitor = newVisitor();
    const first = await bodyOf(await phoneCall("+14155550123", { visitor }));
    const second = await webCall({ visitor });
    assert.deepEqual([second.status, (await bodyOf(second)).error.code], [409, "call_in_progress"]);
    const forget = await fetchHandler(new Request("https://worker.example/api/demo/forget", { method: "POST", headers: { Origin: "https://demo.example", "X-Demo-Visitor": visitor }, body: "{}" }), env);
    assert.equal(forget.status, 409);
    await endCall(first.callRef);
    assert.equal((await webCall({ visitor })).status, 200);
  });

  it("reports ringing → live → ended with the mapped outcome, only to the caller's own browser", async () => {
    const visitor = newVisitor();
    const { callRef } = await bodyOf(await phoneCall("+14155550123", { visitor }));
    const ringing = await status(callRef, visitor);
    assert.deepEqual([ringing.status, ringing.body.phase, ringing.body.channel, ringing.body.maxMinutes, ringing.body.tools], [200, "ringing", "phone", 5, []]);
    assert.equal(typeof ringing.body.placedAt, "number");
    assert.equal((await status(callRef, newVisitor())).status, 404, "another visitor cannot see it");
    assert.equal((await status("not-a-uuid", visitor)).status, 404);

    const call = { call_id: "call_1", call_type: "phone_call", direction: "outbound", agent_id: AGENT, metadata: { source: "healthcare-web-demo", request_id: callRef } };
    await retellEvent("call_started", { ...call, start_timestamp: Date.now() - 2_000 });
    const live = await status(callRef, visitor);
    assert.deepEqual([live.body.phase, live.body.outcome], ["live", undefined]);
    assert.ok(Math.abs(live.body.startedAt - (Date.now() - 2_000)) < 1_000);
    await retellEvent("call_ended", { ...call, end_timestamp: Date.now(), disconnection_reason: "max_duration_reached" });
    const ended = await status(callRef, visitor);
    assert.deepEqual([ended.body.phase, ended.body.outcome], ["ended", "time_limit"]);
    assert.equal(typeof ended.body.endedAt, "number");
    assert.equal(retellRequests.filter((item) => item.path.startsWith("/v2/get-call")).length, 0, "no fallback while events arrive");
  });

  it("maps every documented disconnection reason", () => {
    const cases: Record<string, string> = {
      user_hangup: "completed", agent_hangup: "completed", inactivity: "completed", call_transfer: "completed", max_duration_reached: "time_limit",
      dial_no_answer: "no_answer", dial_busy: "no_answer", user_declined: "no_answer", voicemail_reached: "no_answer", ivr_reached: "no_answer",
      error_user_not_joined: "no_answer", registered_call_timeout: "no_answer", telephony_provider_permission_denied: "blocked",
      invalid_destination: "blocked", dial_failed: "blocked", marked_as_spam: "blocked", network_blocked: "blocked", user_requested_dnc: "blocked",
      scam_detected: "blocked", error_llm_websocket_open: "error", concurrency_limit_reached: "error",
    };
    for (const [reason, outcome] of Object.entries(cases)) assert.equal(callOutcome(reason), outcome, reason);
    assert.equal(callOutcome(undefined), "error");
  });

  it("asks Retell's get-call at most once every 10 seconds when no event arrived, and shows unknown after 90 seconds", async () => {
    const visitor = newVisitor();
    const { callRef } = await bodyOf(await phoneCall("+14155550123", { visitor }));
    db.call(callRef)!.createdAt -= 15_000;
    getCallResponse = { call_id: "call_1", call_status: "registered", metadata: { request_id: callRef } };
    assert.equal((await status(callRef, visitor)).body.phase, "ringing");
    assert.equal((await status(callRef, visitor)).body.phase, "ringing");
    assert.equal(retellRequests.filter((item) => item.path === "/v2/get-call/call_1").length, 1, "throttled");

    db.call(callRef)!.statusCheckedAt! -= 11_000;
    getCallResponse = { call_id: "call_1", call_status: "ongoing", start_timestamp: Date.now() - 3_000, metadata: { request_id: callRef } };
    assert.equal((await status(callRef, visitor)).body.phase, "live");

    db.call(callRef)!.statusCheckedAt! -= 11_000;
    getCallResponse = { call_id: "call_1", call_status: "ended", start_timestamp: Date.now() - 3_000, end_timestamp: Date.now(), disconnection_reason: "dial_no_answer", metadata: { request_id: callRef } };
    const ended = await status(callRef, visitor);
    assert.deepEqual([ended.body.phase, ended.body.outcome], ["ended", "no_answer"]);

    const other = newVisitor();
    const second = await bodyOf(await phoneCall("+14155550124", { visitor: other }));
    db.call(second.callRef)!.createdAt -= 95_000;
    getCallResponse = null;
    assert.equal((await status(second.callRef, other)).body.phase, "unknown");
  });

  it("returns the tool timing log with the status", async () => {
    const visitor = newVisitor();
    const { callRef } = await bodyOf(await webCall({ visitor }));
    const call = { call_id: "call_1", call_type: "web_call", agent_id: AGENT, metadata: { source: "healthcare-web-demo", request_id: callRef, workspace: await keyedHash(env, "visitor-workspace", visitor) } };
    await fetchHandler(await signedTool("lookup_appointment", { booking_reference: "DEMO-4812" }, call), env);
    const tools = (await status(callRef, visitor)).body.tools;
    assert.equal(tools.length, 1);
    assert.deepEqual([tools[0].tool, tools[0].ok], ["lookup_appointment", true]);
  });

  it("releases a browser call that never connected: the browser may retry 45 s after it was created, the call still counts", async () => {
    const visitor = newVisitor();
    const first = await bodyOf(await webCall({ visitor }));
    assert.equal((await bodyOf(await webCall({ visitor }))).error.code, "call_in_progress");
    assert.deepEqual(await bodyOf(await release(first.callRef, newVisitor())), { released: false }, "not someone else's call");
    assert.deepEqual(await bodyOf(await release(first.callRef, visitor)), { released: true });
    assert.deepEqual([(await status(first.callRef, visitor)).body.phase, (await status(first.callRef, visitor)).body.outcome], ["ended", "error"]);
    assert.equal(db.counts(db.call(first.callRef)!), true);
    const immediate = await webCall({ visitor });
    assert.deepEqual([immediate.status, (await bodyOf(immediate)).error.code], [409, "call_in_progress"], "its access token may still be usable");
    assert.ok(Number(immediate.headers.get("Retry-After")) <= 45);
    assert.equal(created().length, 1, "no second token while the first could still join");
    db.call(first.callRef)!.createdAt -= 46_000;
    const second = await bodyOf(await webCall({ visitor }));
    assert.ok(second.callRef, "the released call no longer blocks the browser");
    await report(second.callRef, [["call_started"]]);
    assert.deepEqual(await bodyOf(await release(second.callRef, visitor)), { released: false }, "refused once started");
    const phone = await bodyOf(await phoneCall("+14155550123", { ip: "198.51.100.30" }));
    assert.deepEqual(await bodyOf(await release(phone.callRef, visitor)), { released: false }, "phone calls cannot be released");
    assert.equal((await release("nope", visitor)).status, 400);
  });

  it("says in Retry-After when the one-call-at-a-time block lifts", async () => {
    const retryAfter = async (visitor: string) => {
      const refused = await webCall({ visitor });
      assert.equal((await bodyOf(refused)).error.code, "call_in_progress");
      return Number(refused.headers.get("Retry-After"));
    };
    const ringing = newVisitor();
    const phone = await bodyOf(await phoneCall("+14155550123", { visitor: ringing }));
    db.call(phone.callRef)!.createdAt -= 30_000;
    assert.ok(Math.abs(await retryAfter(ringing) - 90) <= 1, "not started: 120 s after placing");
    await report(phone.callRef, [["call_started"]]);
    assert.ok(Math.abs(await retryAfter(ringing) - 360) <= 1, "started: max duration + 90 s after placing");

    const browser = newVisitor();
    const web = await bodyOf(await webCall({ visitor: browser, ip: "198.51.100.40" }));
    await release(web.callRef, browser);
    db.call(web.callRef)!.createdAt -= 10_000;
    assert.ok(Math.abs(await retryAfter(browser) - 35) <= 1, "released: 45 s after creation");
  });

  it("undoes a release when the call starts after all", async () => {
    const visitor = newVisitor();
    const call = await bodyOf(await webCall({ visitor }));
    await release(call.callRef, visitor);
    await report(call.callRef, [["call_started"]]);
    assert.equal((await status(call.callRef, visitor)).body.phase, "live");
    assert.equal((await bodyOf(await webCall({ visitor }))).error.code, "call_in_progress");
  });

  it("shows unknown for a browser call that did not start within 90 seconds", async () => {
    const visitor = newVisitor();
    const { callRef } = await bodyOf(await webCall({ visitor }));
    assert.equal((await status(callRef, visitor)).body.phase, "connecting");
    db.call(callRef)!.createdAt -= 95_000;
    assert.equal((await status(callRef, visitor)).body.phase, "unknown");
  });
});
