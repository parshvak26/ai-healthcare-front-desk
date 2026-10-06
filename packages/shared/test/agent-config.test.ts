import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { appointmentTypes, providers, voiceFaqPromptBlock, voiceRequestTypes } from "../src/index.ts";

const root = new URL("../../../", import.meta.url);
const promptFile = readFileSync(new URL("retell/AGENT_PROMPT.md", root), "utf8");
const prompt = /```text\n([\s\S]*?)\n```/.exec(promptFile)?.[1] ?? "";
const tools = JSON.parse(readFileSync(new URL("retell/tools.json", root), "utf8")) as {
  functions: { name: string; parameters: { properties: Record<string, { enum?: string[] }>; required?: string[] } }[];
};
// Variables the Worker sends with every call (apps/worker/src/context.ts).
const workerVariables = ["clinic_today", "clinic_calendar", "clinic_timezone_label", "caller_status", "caller_booking_count", "call_channel", "caller_timezone", "caller_time_differs", "emergency_number", "crisis_line", "max_minutes"];

describe("Retell agent configuration", () => {
  it("embeds the approved spoken FAQ answers exactly", () => {
    assert.ok(prompt.length > 0, "prompt block found");
    assert.ok(prompt.includes(voiceFaqPromptBlock()), "regenerate the FAQ block from catalog.ts");
  });

  it("uses only variables the Worker provides", () => {
    const used = new Set([...prompt.matchAll(/\{\{([a-z_]+)\}\}/g)].map((match) => match[1]));
    for (const name of used) assert.ok(workerVariables.includes(name), `unknown variable {{${name}}}`);
    for (const name of workerVariables) assert.ok(used.has(name), `variable {{${name}}} is sent but unused`);
  });

  it("matches the Worker's tool names and enums", () => {
    const names = tools.functions.map((item) => item.name).sort();
    assert.deepEqual(names, ["cancel_appointment", "check_document_status", "confirm_appointment", "create_appointment", "get_availability", "join_waitlist", "lookup_appointment", "report_wrong_number", "request_staff_followup", "reschedule_appointment"]);
    for (const fn of tools.functions) {
      for (const [key, schema] of Object.entries(fn.parameters.properties)) {
        assert.ok(!["timezone", "verification_name", "sample_patient_name"].includes(key), `${fn.name}.${key} is legacy`);
        if (key === "appointment_type") assert.deepEqual(schema.enum, [...appointmentTypes]);
        if (key === "provider") assert.deepEqual(schema.enum, providers.map((item) => item.name));
        if (key === "patient_name") assert.equal(schema.enum, undefined, "names are free text");
        if (key === "request_type") assert.deepEqual(schema.enum, voiceRequestTypes);
      }
      for (const required of fn.parameters.required ?? []) assert.ok(required in fn.parameters.properties, `${fn.name} requires ${required}`);
      assert.ok(prompt.includes(fn.name), `the prompt explains when to use ${fn.name}`);
    }
  });

  it("stays short enough for low latency", () => {
    assert.ok(prompt.split(/\s+/).length < 2200, `prompt has ${prompt.split(/\s+/).length} words`);
  });
});
