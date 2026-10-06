import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fetchHandler } from "../src/app.ts";
import type { Env } from "../src/app.ts";

// Fakes for Supabase RPCs, Cloudflare Turnstile, and Retell's create-phone-call API.
interface Reservation { owner: boolean; phone: string; ip: string; status: string; at: number }
let reservations: Reservation[];
let retellCalls: Array<Record<string, any>>;
let turnstileOk: boolean;
let retellStatus: number;
const realFetch = globalThis.fetch;
const OWNER = "+15125550100";
const env: Env = {
  SUPABASE_URL: "https://example-project.supabase.co", SUPABASE_SECRET_KEY: "sb_secret_test", PUBLIC_ORIGINS: "https://demo.example",
  RETELL_API_KEY: "test-retell-key", RETELL_TEST_NUMBERS: OWNER, DEMO_CALLS: "on", RETELL_FROM_NUMBER: "+15128231502",
  RETELL_AGENT_ID: "agent_bcd0e610f4535270f5642efeb0", TURNSTILE_SECRET_KEY: "turnstile-secret", TURNSTILE_HOSTNAME: "demo.example",
  MAX_CALLS_PER_DAY: "2", MAX_CALLS_PER_IP_PER_DAY: "5", PHONE_COOLDOWN_MINUTES: "30", MAX_CALL_DURATION_SECONDS: "300",
};

function fakeFetch(input: RequestInfo | URL, init?: RequestInit) {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const json = (value: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(value), { status }));
  if (url.host === "challenges.cloudflare.com") {
    const form = new URLSearchParams(String(init?.body));
    assert.equal(form.get("secret"), "turnstile-secret");
    return json({ success: turnstileOk, hostname: "demo.example", action: "healthcare_demo_call" });
  }
  if (url.host === "api.retellai.com") {
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer test-retell-key");
    retellCalls.push(JSON.parse(String(init?.body)));
    return retellStatus === 201 ? json({ call_id: `call_${retellCalls.length}` }, 201) : json({ message: "rejected" }, retellStatus);
  }
  const name = url.pathname.replace("/rest/v1/rpc/", "");
  const body = JSON.parse(String(init?.body ?? "{}"));
  if (name === "healthcare_consume_demo_rate_limit") return json(1);
  if (name === "healthcare_reserve_demo_call") {
    const active = reservations.filter((item) => item.status !== "failed");
    if (!body.p_owner) {
      if (active.some((item) => item.phone === body.p_phone_hash)) return json([{ allowed: false, reason: "phone_cooldown", retry_after_seconds: 1800 }]);
      if (active.filter((item) => !item.owner).length >= body.p_max_calls_per_day) return json([{ allowed: false, reason: "daily_limit", retry_after_seconds: 3600 }]);
    }
    reservations.push({ owner: body.p_owner, phone: body.p_phone_hash, ip: body.p_ip_hash, status: "reserved", at: Date.now() });
    return json([{ allowed: true, reason: null, retry_after_seconds: 0 }]);
  }
  if (name === "healthcare_finish_demo_call") { reservations[reservations.length - 1].status = body.p_status; return json(true); }
  return json({}, 404);
}

beforeEach(() => {
  reservations = []; retellCalls = []; turnstileOk = true; retellStatus = 201;
  globalThis.fetch = fakeFetch as typeof fetch;
});
afterEach(() => { globalThis.fetch = realFetch; });

const request = (body: unknown, overrides: Partial<Env> = {}) => fetchHandler(new Request("https://worker.example/api/demo-call", {
  method: "POST", headers: { "Content-Type": "application/json", Origin: "https://demo.example", "CF-Connecting-IP": "203.0.113.7" }, body: JSON.stringify(body),
}), { ...env, ...overrides });
const valid = (phoneNumber: string) => ({ phoneNumber, consent: true, turnstileToken: "token-from-turnstile-widget" });

describe("Call me demo calls", () => {
  it("places one call from the shared number with the Healthcare agent as a one-time override", async () => {
    const response = await request(valid("+1 (415) 555-0123"));
    assert.equal(response.status, 200);
    const body = await response.json() as Record<string, unknown>;
    assert.equal(body.status, "calling");
    assert.equal(body.maskedNumber, "+1 (•••) •••-0123");
    const [created] = retellCalls;
    assert.equal(created.from_number, "+15128231502");
    assert.equal(created.to_number, "+14155550123");
    assert.equal(created.override_agent_id, "agent_bcd0e610f4535270f5642efeb0");
    assert.equal(created.override_agent_version, "latest_published");
    assert.equal(created.agent_override.agent.max_call_duration_ms, 300_000);
    assert.equal(created.metadata.source, "healthcare-web-demo");
    assert.equal(reservations[0].status, "placed");
    assert.ok(!JSON.stringify(reservations).includes("4155550123"), "the phone number itself is never stored");
  });

  it("reports health with the call settings and keeps SMS off", async () => {
    const health = await (await fetchHandler(new Request("https://worker.example/api/health"), env)).json() as Record<string, any>;
    assert.deepEqual([health.liveCallsEnabled, health.liveSmsEnabled, health.demoCalls.fromNumber, health.demoCalls.maxCallsPerDay], [true, false, "+1 (512) 823-1502", 2]);
    const off = await (await fetchHandler(new Request("https://worker.example/api/health"), { ...env, TURNSTILE_SECRET_KEY: "" })).json() as Record<string, any>;
    assert.deepEqual([off.liveCallsEnabled, off.demoCalls.enabled], [false, false]);
  });

  it("is off unless every setting is present", async () => {
    for (const overrides of [{ DEMO_CALLS: "off" }, { TURNSTILE_SECRET_KEY: "" }, { RETELL_AGENT_ID: "not-an-agent" }, { RETELL_FROM_NUMBER: "+919876543210" }]) {
      assert.equal((await request(valid("+14155550123"), overrides)).status, 503, JSON.stringify(overrides));
    }
    assert.equal(retellCalls.length, 0);
  });

  it("requires consent, a valid US/India number with country code, and a passed security check", async () => {
    assert.equal((await request({ ...valid("+14155550123"), consent: false })).status, 400);
    assert.equal((await request(valid("4155550123"))).status, 400);
    assert.equal((await request(valid("+44 20 7183 8750"))).status, 400);
    assert.equal((await request({ ...valid("+14155550123"), extra: "x" })).status, 400);
    turnstileOk = false;
    assert.equal((await request(valid("+14155550123"))).status, 403);
    assert.equal(retellCalls.length, 0);
  });

  it("enforces the daily cap and per-number cooldown for visitors, but not for the owner's number", async () => {
    assert.equal((await request(valid("+14155550123"))).status, 200);
    const again = await request(valid("+14155550123"));
    assert.equal(again.status, 429);
    assert.ok(Number(again.headers.get("Retry-After")) > 0);
    assert.equal((await request(valid("+919876543210"))).status, 200);
    const third = await request(valid("+12125550199"));
    assert.equal(((await third.json()) as Record<string, any>).error.code, "daily_limit");
    for (let i = 0; i < 4; i += 1) assert.equal((await request(valid("+1 512 555 0100"))).status, 200, "owner call " + i);
    assert.equal(retellCalls.length, 6);
  });

  it("does not count a call the provider rejected", async () => {
    retellStatus = 422;
    const response = await request(valid("+919876543210"));
    assert.equal(response.status, 422);
    assert.match(((await response.json()) as Record<string, any>).error.message, /India/);
    assert.equal(reservations[0].status, "failed");
  });
});
