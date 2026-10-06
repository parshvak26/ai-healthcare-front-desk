import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyDemoAction, callerNames, clinicCalendar, createSeedState, findAppointment, findAppointmentsByName, isPatientName,
  matchNames, normalizePersonName, parseBookingReference, parseDemoAction, patientNames, searchAvailability,
  spokenDateTime, spokenReference, spokenTime, validateDemoState, voiceFaqPromptBlock, zonedTimeToUtc, faqEntries,
} from "../src/index.ts";
import type { ActionContext, DemoAction, DemoState } from "../src/index.ts";

const tz = "America/Chicago";
const NOW = Date.parse("2026-10-07T15:00:00.000Z"); // Wednesday 10:00 in Chicago
let counter = 0;
const voice = (overrides: Partial<ActionContext> = {}): ActionContext => ({ now: NOW, channel: "Voice assistant", key: `names-${(counter += 1)}`, random: () => 0.37, ...overrides });
const run = (state: DemoState, action: DemoAction, overrides: Partial<ActionContext> = {}) => applyDemoAction(state, action, voice(overrides));
const book = (state: DemoState, patient: string, date: string, time: string, type = "Follow-up visit") =>
  run(state, { type: "book_appointment", patient, appointmentType: type, startAt: zonedTimeToUtc(date, time, tz)!, timezone: tz });

describe("person names", () => {
  it("normalizes spoken and typed names", () => {
    assert.equal(normalizePersonName("  parshva   karani "), "Parshva Karani");
    assert.equal(normalizePersonName("O’BRIEN"), "O'Brien");
    assert.equal(normalizePersonName("Mary - Jane"), "Mary-Jane");
    assert.equal(normalizePersonName("José Álvarez"), "José Álvarez");
    assert.equal(normalizePersonName("पार्श्व"), "पार्श्व");
    assert.equal(normalizePersonName("McDonald"), "McDonald", "mixed case is kept");
    assert.equal(normalizePersonName("maya patel"), "Maya Patel");
    assert.equal(normalizePersonName("İLKER"), "İlker", "case mapping is re-composed");
    assert.equal(isPatientName(normalizePersonName("İLKER")), true);
  });

  it("rejects things that are not names", () => {
    for (const value of ["", "   ", "555 0100", "R2D2", "john@example.com", "Front desk", "a·b", "one two three four five six", "--", "Ann--Marie", "x".repeat(61), 42, null]) {
      assert.equal(normalizePersonName(value), null, String(value));
    }
    assert.equal(isPatientName("Parshva"), true);
    assert.equal(isPatientName("parshva"), false, "only canonical names are stored");
  });

  it("matches in tiers so close names never override an exact one", () => {
    const names = ["Anna Lee", "Anne Lee", "Maya Patel", "Parshva Karani"];
    assert.deepEqual(matchNames("anna lee", names), { tier: "exact", names: ["Anna Lee"] });
    assert.deepEqual(matchNames("Maya", names), { tier: "first-name", names: ["Maya Patel"] });
    assert.deepEqual(matchNames("Parsva", names), { tier: "fuzzy", names: ["Parshva Karani"] });
    assert.deepEqual(matchNames("Bob", names), { tier: null, names: [] });
    assert.deepEqual(matchNames("Jose", ["José"]).names, ["José"], "accents are ignored");
  });
});

describe("caller names in the demo", () => {
  it("reuses the stored spelling and keeps one person per name", () => {
    let state = book(createSeedState(NOW), "Parshva", "2026-10-12", "09:00").state;
    state = book(state, "parshva", "2026-10-13", "09:00").state;
    state = book(state, "Parsva", "2026-10-14", "09:00").state;
    assert.deepEqual(callerNames(state), ["Parshva"]);
    assert.equal(state.appointments.filter((item) => item.patient === "Parshva").length, 3);
    // Short names are never merged by spelling: "Ann" and "Anna" stay two people.
    state = book(state, "Anna", "2026-10-15", "09:00").state;
    state = book(state, "Ann", "2026-10-15", "10:00").state;
    assert.deepEqual(callerNames(state), ["Parshva", "Anna", "Ann"]);
    state = book(state, "John Smith", "2026-10-16", "09:00").state;
    state = book(state, "Joan Smith", "2026-10-16", "10:00").state;
    assert.deepEqual(callerNames(state).slice(-2), ["John Smith", "Joan Smith"], "one short differing word is a different person");
    assert.ok(patientNames(state).slice(0, 5).includes("Maya Patel"));
  });

  it("treats a double booking for the same person as busy, whatever the spelling", () => {
    const state = book(createSeedState(NOW), "Parshva", "2026-10-12", "09:00").state;
    assert.throws(() => book(state, "PARSHVA", "2026-10-12", "09:00"), { code: "patient_busy" });
  });

  it("caps caller names per demo", () => {
    let state = createSeedState(NOW);
    const letters = "ABCDEFGHIJKLMNOPQRST";
    for (let i = 0; i < 20; i += 1) state = run(state, { type: "join_waitlist", patient: `Caller ${letters[i]}${letters[i]}`, appointmentType: "Consultation", preferredDate: "2026-10-20", timezone: tz }).state;
    assert.equal(callerNames(state).length, 20);
    assert.throws(() => run(state, { type: "join_waitlist", patient: "One More", appointmentType: "Consultation", preferredDate: "2026-10-20", timezone: tz }), { code: "too_many_names" });
    assert.equal(validateDemoState(state), true);
  });

  it("finds bookings by reference with a tolerant name, or by name alone", () => {
    const booked = book(createSeedState(NOW), "Parshva Karani", "2026-10-12", "09:00");
    const reference = booked.appointment!.reference;
    assert.equal(findAppointment(booked.state, reference, "parshva").reference, reference);
    assert.equal(findAppointment(booked.state, reference, "Parsva Karani").reference, reference);
    assert.throws(() => findAppointment(booked.state, reference, "Someone Else"), { code: "sample_booking_not_found" });
    const found = findAppointmentsByName(booked.state, "Parshva", NOW);
    assert.deepEqual(found.appointments.map((item) => item.reference), [reference]);
    assert.equal(findAppointmentsByName(booked.state, "Maya", NOW).appointments[0].patient, "Maya Patel");
  });

  it("lets a voice staff task carry the caller's name and records the task on the event", () => {
    const outcome = run(createSeedState(NOW), { type: "create_task", requestType: "billing", patient: "Parshva" });
    assert.equal(outcome.task!.patient, "Parshva");
    assert.equal(outcome.state.events[0].taskId, outcome.task!.id);
    assert.deepEqual(parseDemoAction({ type: "create_task", requestType: "billing", patient: "Parshva" }), { type: "create_task", requestType: "billing", patient: "Parshva" });
  });
});

describe("spoken output", () => {
  it("says dates, times and references naturally", () => {
    assert.equal(spokenDateTime(zonedTimeToUtc("2026-10-08", "09:30", tz)!, tz), "Thursday, October 8th at 9:30 a.m.");
    assert.equal(spokenTime(zonedTimeToUtc("2026-10-08", "14:00", tz)!, tz), "2 p.m.");
    assert.equal(spokenTime(zonedTimeToUtc("2026-10-08", "12:30", tz)!, tz), "12:30 p.m.");
    assert.equal(spokenReference("DEMO-4812"), "demo four eight one two");
    for (const input of ["DEMO-4812", "demo 4812", "4812", "4 8 1 2", "Demo-4812."]) assert.equal(parseBookingReference(input), "DEMO-4812", input);
    for (const input of ["812", "DEMO-48120", "four eight one two", ""]) assert.equal(parseBookingReference(input), null, input);
  });

  it("builds a 14-day clinic calendar", () => {
    const lines = clinicCalendar(NOW, tz).split("\n");
    assert.equal(lines.length, 14);
    assert.equal(lines[0], "today, Wed Oct 7 = 2026-10-07 (open 8 a.m. to 5 p.m.)");
    assert.equal(lines[3], "Sat Oct 10 = 2026-10-10 (closed)");
  });

  it("has a spoken answer for every approved FAQ", () => {
    for (const entry of faqEntries) assert.ok(entry.voiceAnswer.length > 20 && !/the assistant|demo console/i.test(entry.voiceAnswer), entry.id);
    assert.equal(voiceFaqPromptBlock().split("\n").length, faqEntries.length);
  });
});

describe("availability search", () => {
  const seed = createSeedState(NOW);
  it("offers a spread of times across the requested days", () => {
    const result = searchAvailability(seed, { startDate: "2026-10-12", days: 5, appointmentType: "Follow-up visit", timezone: tz, now: NOW });
    assert.equal(result.slots.length, 3);
    assert.equal(result.moreAvailable, true);
    const [first, second, third] = result.slots.map((slot) => Date.parse(slot.startAt));
    assert.ok(second - first >= 60 * 60_000 && third - second >= 60 * 60_000, "offers are genuinely different");
  });

  it("filters by part of day, earliest time and provider, and skips closed days", () => {
    const afternoon = searchAvailability(seed, { startDate: "2026-10-10", days: 3, appointmentType: "Consultation", timezone: tz, now: NOW, partOfDay: "afternoon", provider: "Dr. Noah Rivera" });
    assert.ok(afternoon.slots.length > 0);
    for (const slot of afternoon.slots) {
      assert.equal(slot.provider, "Dr. Noah Rivera");
      assert.ok(slot.startAt.startsWith("2026-10-12"), "the weekend has no slots");
      assert.ok(Number(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone: tz }).format(new Date(slot.startAt))) >= 12);
    }
    const late = searchAvailability(seed, { startDate: "2026-10-12", days: 1, appointmentType: "Follow-up visit", timezone: tz, now: NOW, earliestTime: "15:45" });
    assert.ok(late.slots.length >= 1 && late.slots.every((slot) => slot.localTime.includes("4:")));
    assert.throws(() => searchAvailability(seed, { startDate: "2026-10-12", days: 15, appointmentType: "Follow-up visit", timezone: tz, now: NOW }), { code: "invalid_range" });
    assert.throws(() => searchAvailability(seed, { startDate: "2026-10-12", days: 1, appointmentType: "Follow-up visit", timezone: tz, now: NOW, earliestTime: "25:00" }), { code: "invalid_time" });
  });
});
