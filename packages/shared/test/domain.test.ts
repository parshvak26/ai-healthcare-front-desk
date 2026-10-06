import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  addDaysToDateKey, applyDemoAction, buildAvailability, createSeedState, isTimezone, localParts, normalizeDemoState,
  outsideQuietHours, overlapping, parseDemoAction, processDueMessages, searchApprovedFaq, validateDemoState,
  weekdayOfDateKey, zonedTimeToUtc,
} from "../src/index.ts";
import type { ActionContext, DemoAction, DemoState } from "../src/index.ts";

const tz = "America/Chicago";
// Wednesday 7 October 2026, 10:00 in Chicago.
const NOW = Date.parse("2026-10-07T15:00:00.000Z");
let counter = 0;
const ctx = (overrides: Partial<ActionContext> = {}): ActionContext => ({
  now: NOW, channel: "Staff console", key: `test-key-${(counter += 1)}`, random: () => 0.5, ...overrides,
});
const run = (state: DemoState, action: DemoAction, overrides: Partial<ActionContext> = {}) => applyDemoAction(state, action, ctx(overrides));
const local = (iso: string) => { const p = localParts(Date.parse(iso), tz); return `${p.hour}:${String(p.minute).padStart(2, "0")}`; };

describe("seed data", () => {
  it("is valid, conflict-free, and inside clinic hours", () => {
    const seed = createSeedState(NOW);
    assert.equal(validateDemoState(seed), true);
    assert.equal(overlapping(seed), false);
    for (const item of seed.appointments) {
      const p = localParts(Date.parse(item.startAt), tz);
      assert.ok(p.weekday >= 1 && p.weekday <= 5, `${item.reference} is on a weekday`);
      assert.ok(p.hour >= 8 && p.hour < 17, `${item.reference} is in opening hours`);
    }
    assert.ok(seed.appointments.some((item) => Date.parse(item.startAt) < NOW), "a past visit exists for the attendance flow");
  });

  it("skips weekends when the demo is reset on a Friday evening", () => {
    const friday = Date.parse("2026-10-10T01:00:00.000Z"); // Friday 9 Oct, 20:00 Chicago
    const seed = createSeedState(friday);
    const first = seed.appointments.find((item) => item.id === "apt-1001");
    assert.equal(localParts(Date.parse(first!.startAt), tz).weekday, 1);
  });
});

describe("availability", () => {
  const seed = createSeedState(NOW);
  it("returns no slots on weekends or past dates", () => {
    assert.deepEqual(buildAvailability(seed, { date: "2026-10-10", appointmentType: "Consultation", timezone: tz, now: NOW }), []);
    assert.deepEqual(buildAvailability(seed, { date: "2026-10-06", appointmentType: "Consultation", timezone: tz, now: NOW }), []);
  });

  it("offers future 30-minute slots that end by closing time", () => {
    const slots = buildAvailability(seed, { date: "2026-10-07", appointmentType: "New patient visit", timezone: tz, now: NOW });
    assert.ok(slots.length > 0);
    for (const slot of slots) {
      assert.ok(Date.parse(slot.startAt) > NOW);
      const p = localParts(Date.parse(slot.startAt), tz);
      assert.equal(p.minute % 30, 0);
      assert.ok(p.hour * 60 + p.minute + 60 <= 17 * 60);
      assert.match(slot.localTime, /^Wednesday, October 7/);
    }
  });

  it("rejects invalid input", () => {
    assert.throws(() => buildAvailability(seed, { date: "2026-13-01", appointmentType: "Consultation", timezone: tz, now: NOW }), { code: "invalid_date" });
    assert.throws(() => buildAvailability(seed, { date: "2026-10-08", appointmentType: "Surgery", timezone: tz, now: NOW }), { code: "invalid_appointment_type" });
    assert.throws(() => buildAvailability(seed, { date: "2026-10-08", appointmentType: "Consultation", timezone: "Mars/Base", now: NOW }), { code: "invalid_timezone" });
  });

  it("handles a daylight-saving gap", () => {
    assert.equal(zonedTimeToUtc("2027-03-14", "02:30", tz), null);
    assert.equal(zonedTimeToUtc("2027-03-14", "08:00", tz), "2027-03-14T13:00:00.000Z");
  });
});

describe("booking", () => {
  it("books a free slot with confirmation, reminder, and document follow-up", () => {
    const seed = createSeedState(NOW);
    const [slot] = buildAvailability(seed, { date: "2026-10-12", appointmentType: "New patient visit", timezone: tz, now: NOW });
    const outcome = run(seed, { type: "book_appointment", patient: "Taylor Reed", appointmentType: "New patient visit", startAt: slot.startAt, timezone: tz });
    assert.equal(outcome.changed, true);
    const booked = outcome.appointment!;
    assert.match(booked.reference, /^DEMO-\d{4}$/);
    assert.equal(booked.documents, "Needed");
    const messages = outcome.state.messages.filter((item) => item.appointmentReference === booked.reference);
    assert.deepEqual(messages.map((item) => item.purpose).sort(), ["24-hour appointment reminder", "48-hour missing-document follow-up", "Booking confirmation"]);
    assert.ok(outcome.state.tasks.some((item) => item.appointmentReference === booked.reference && item.title === "Referral document missing"));
    assert.ok(outcome.state.events.some((item) => item.action === "Appointment booked" && item.reference === booked.reference));
    assert.equal(validateDemoState(outcome.state), true);
  });

  it("is idempotent for a retried request", () => {
    const seed = createSeedState(NOW);
    const [slot] = buildAvailability(seed, { date: "2026-10-12", appointmentType: "Follow-up visit", timezone: tz, now: NOW });
    const action: DemoAction = { type: "book_appointment", patient: "Jordan Lee", appointmentType: "Follow-up visit", startAt: slot.startAt, timezone: tz };
    const first = run(seed, action, { key: "same-key" });
    const replay = run(first.state, action, { key: "same-key" });
    assert.equal(replay.changed, false);
    assert.equal(replay.appointment!.id, first.appointment!.id);
    assert.equal(replay.state.appointments.length, first.state.appointments.length);
  });

  it("never double-books: a taken slot is refused", () => {
    let state = createSeedState(NOW);
    const startAt = zonedTimeToUtc("2026-10-12", "09:00", tz)!;
    const book = (patient: string) => run(state, { type: "book_appointment", patient, appointmentType: "Consultation", startAt, timezone: tz });
    state = book("Maya Patel").state; // first provider
    state = book("Jordan Lee").state; // second provider
    assert.throws(() => book("Samira Khan"), { code: "slot_unavailable", status: 409 });
  });

  it("refuses non-sample names and off-grid times", () => {
    const seed = createSeedState(NOW);
    assert.throws(() => run(seed, { type: "book_appointment", patient: "Real Person", appointmentType: "Consultation", startAt: zonedTimeToUtc("2026-10-12", "09:00", tz)!, timezone: tz }), { code: "sample_name_only" });
    assert.throws(() => run(seed, { type: "book_appointment", patient: "Maya Patel", appointmentType: "Consultation", startAt: zonedTimeToUtc("2026-10-12", "09:10", tz)!, timezone: tz }), { code: "slot_unavailable" });
  });

  it("keeps texts out of quiet hours and suppresses them after opt-out", () => {
    const lateNight = Date.parse("2026-10-08T03:30:00.000Z"); // 22:30 Chicago
    const seed = createSeedState(lateNight);
    const startAt = zonedTimeToUtc("2026-10-13", "10:00", tz)!;
    const outcome = run(seed, { type: "book_appointment", patient: "Maya Patel", appointmentType: "Follow-up visit", startAt, timezone: tz }, { now: lateNight });
    const confirmation = outcome.state.messages.find((item) => item.appointmentReference === outcome.appointment!.reference && item.purpose === "Booking confirmation")!;
    assert.equal(local(confirmation.scheduledFor!), "9:00");
    assert.equal(outsideQuietHours(Date.parse("2026-10-07T15:00:00.000Z"), tz), Date.parse("2026-10-07T15:00:00.000Z"));

    const optedOut = run(seed, { type: "book_appointment", patient: "Alex Morgan", appointmentType: "Follow-up visit", startAt, timezone: tz }, { now: lateNight });
    const texts = optedOut.state.messages.filter((item) => item.appointmentReference === optedOut.appointment!.reference);
    assert.ok(texts.length > 0 && texts.every((item) => item.status === "Suppressed (opt-out)"));
  });
});

describe("booking edge cases found in review", () => {
  it("treats the same request after a cancellation as a new booking, not the cancelled one", () => {
    let state = createSeedState(NOW);
    const startAt = zonedTimeToUtc("2026-10-12", "10:00", tz)!;
    const action: DemoAction = { type: "book_appointment", patient: "Taylor Reed", appointmentType: "Follow-up visit", startAt, timezone: tz };
    const first = run(state, action, { key: "voice-call|create" });
    state = run(first.state, { type: "cancel_appointment", reference: first.appointment!.reference, patient: "Taylor Reed" }).state;
    const again = run(state, action, { key: "voice-call|create" });
    assert.equal(again.changed, true);
    assert.equal(again.appointment!.status, "Confirmed");
    assert.notEqual(again.appointment!.id, first.appointment!.id);
    assert.equal(run(again.state, action, { key: "voice-call|create" }).changed, false, "a replay of the rebook is still idempotent");
  });

  it("does not return an earlier booking when the same key is reused for a different time", () => {
    const seed = createSeedState(NOW);
    const first = run(seed, { type: "book_appointment", patient: "Jordan Lee", appointmentType: "Follow-up visit", startAt: zonedTimeToUtc("2026-10-12", "10:00", tz)!, timezone: tz }, { key: "dialog-key" });
    const second = run(first.state, { type: "book_appointment", patient: "Jordan Lee", appointmentType: "Follow-up visit", startAt: zonedTimeToUtc("2026-10-12", "13:00", tz)!, timezone: tz }, { key: "dialog-key" });
    assert.equal(second.changed, true);
    assert.equal(second.appointment!.startAt, zonedTimeToUtc("2026-10-12", "13:00", tz));
  });

  it("books the provider that was shown, or refuses", () => {
    let state = createSeedState(NOW);
    const startAt = zonedTimeToUtc("2026-10-12", "09:00", tz)!;
    state = run(state, { type: "book_appointment", patient: "Maya Patel", appointmentType: "Consultation", startAt, timezone: tz, provider: "Dr. Avery Chen" }).state;
    assert.throws(() => run(state, { type: "book_appointment", patient: "Jordan Lee", appointmentType: "Consultation", startAt, timezone: tz, provider: "Dr. Avery Chen" }), { code: "slot_unavailable" });
    const other = run(state, { type: "book_appointment", patient: "Jordan Lee", appointmentType: "Consultation", startAt, timezone: tz, provider: "Dr. Noah Rivera" });
    assert.equal(other.appointment!.location, "North clinic");
  });

  it("will not double-book one patient at the same time", () => {
    const startAt = zonedTimeToUtc("2026-10-12", "09:00", tz)!;
    const state = run(createSeedState(NOW), { type: "book_appointment", patient: "Maya Patel", appointmentType: "Consultation", startAt, timezone: tz }).state;
    assert.throws(() => run(state, { type: "book_appointment", patient: "Maya Patel", appointmentType: "Consultation", startAt, timezone: tz }), { code: "patient_busy" });
  });

  it("refuses a booking when the schedule is full instead of deleting active visits", () => {
    let state = createSeedState(NOW);
    let date = "2026-10-12";
    const patients = ["Maya Patel", "Jordan Lee", "Samira Khan", "Alex Morgan", "Taylor Reed"];
    let n = 0;
    while (state.appointments.length < 100) {
      for (const slot of buildAvailability(state, { date, appointmentType: "Follow-up visit", timezone: tz, now: NOW })) {
        if (state.appointments.length >= 100) break;
        try { state = run(state, { type: "book_appointment", patient: patients[n % 5], appointmentType: "Follow-up visit", startAt: slot.startAt, timezone: tz, provider: slot.provider }).state; } catch { /* patient busy: try the next slot */ }
        n += 1;
      }
      do { date = addDaysToDateKey(date, 1); } while ([0, 6].includes(weekdayOfDateKey(date)));
    }
    const before = state.appointments.filter((item) => item.status === "Confirmed").length;
    const [slot] = buildAvailability(state, { date, appointmentType: "Follow-up visit", timezone: tz, now: NOW });
    assert.throws(() => run(state, { type: "book_appointment", patient: "Maya Patel", appointmentType: "Follow-up visit", startAt: slot.startAt, timezone: tz }), (error: { code: string }) => ["schedule_full", "demo_full"].includes(error.code));
    assert.equal(state.appointments.filter((item) => item.status === "Confirmed").length, before);
  });

  it("refuses new staff tasks when the queue is full of open work", () => {
    let state = createSeedState(NOW);
    while (state.tasks.length < 100) state = run(state, { type: "create_task", requestType: "callback" }).state;
    assert.throws(() => run(state, { type: "create_task", requestType: "callback" }), { code: "demo_full" });
  });

  it("keeps the cancellation confirmation itself deliverable", () => {
    const cancelled = run(createSeedState(NOW), { type: "cancel_appointment", reference: "DEMO-4812", patient: "Maya Patel" }).state;
    const processed = processDueMessages(cancelled, NOW + 60_000).state;
    assert.equal(processed.messages.find((item) => item.appointmentReference === "DEMO-4812" && item.purpose === "Cancellation confirmation")!.status, "Delivered (demo)");
  });

  it("accepts IANA timezone names only", () => {
    assert.equal(isTimezone("Asia/Kolkata"), true);
    assert.equal(isTimezone("America/Argentina/Buenos_Aires"), true);
    assert.equal(isTimezone("+05:00"), false);
    assert.equal(isTimezone("Etc/GMT+5"), false);
  });
});

describe("changes to an existing booking", () => {
  it("reschedules, moves the reminder, and refuses a taken slot", () => {
    const seed = createSeedState(NOW);
    const maya = seed.appointments.find((item) => item.reference === "DEMO-4812")!;
    const newStartAt = zonedTimeToUtc("2026-10-14", "13:00", tz)!;
    const outcome = run(seed, { type: "reschedule_appointment", reference: "DEMO-4812", patient: "Maya Patel", newStartAt, timezone: tz });
    assert.equal(outcome.appointment!.startAt, newStartAt);
    const reminder = outcome.state.messages.find((item) => item.appointmentReference === maya.reference && item.purpose === "24-hour appointment reminder" && item.status === "Scheduled (demo)");
    assert.equal(reminder?.scheduledFor, zonedTimeToUtc("2026-10-13", "13:00", tz));
    assert.ok(outcome.state.messages.some((item) => item.appointmentReference === maya.reference && item.purpose === "Reschedule confirmation"));

    const sameAgain = run(outcome.state, { type: "reschedule_appointment", reference: "DEMO-4812", patient: "Maya Patel", newStartAt, timezone: tz });
    assert.equal(sameAgain.changed, false);
    assert.throws(() => run(seed, { type: "reschedule_appointment", reference: "DEMO-4812", patient: "Jordan Lee", newStartAt, timezone: tz }), { code: "sample_booking_not_found" });
  });

  it("cancels, stops pending texts, and hands the opening to the waitlist", () => {
    const seed = createSeedState(NOW);
    const outcome = run(seed, { type: "cancel_appointment", reference: "DEMO-7730", patient: "Samira Khan" });
    assert.equal(outcome.appointment!.status, "Cancelled");
    assert.ok(outcome.state.messages.filter((item) => item.appointmentReference === "DEMO-7730" && item.purpose !== "Cancellation confirmation").every((item) => item.status !== "Scheduled (demo)" && item.status !== "Queued (demo)"));
    assert.equal(outcome.state.waitlist.find((item) => item.id === "wait-1")!.status, "Opening found");
    assert.ok(outcome.state.tasks.some((item) => item.title === "Waitlist follow-up" && item.patient === "Taylor Reed"));
    assert.equal(run(outcome.state, { type: "cancel_appointment", reference: "DEMO-7730", patient: "Samira Khan" }).changed, false);
  });

  it("refuses to cancel a visit whose time has passed", () => {
    assert.throws(() => run(createSeedState(NOW), { type: "cancel_appointment", reference: "DEMO-3307", patient: "Taylor Reed" }), { code: "appointment_closed" });
  });

  it("confirms a booking that needs confirmation", () => {
    const outcome = run(createSeedState(NOW), { type: "confirm_appointment", reference: "DEMO-7730", patient: "Samira Khan" });
    assert.equal(outcome.appointment!.status, "Confirmed");
  });

  it("records a missed visit with a staff follow-up, but only after the start time", () => {
    const seed = createSeedState(NOW);
    const missed = run(seed, { type: "record_attendance", reference: "DEMO-3307", outcome: "missed" });
    assert.equal(missed.appointment!.status, "Missed");
    assert.ok(missed.state.tasks.some((item) => item.title === "Missed appointment follow-up" && item.appointmentReference === "DEMO-3307"));
    assert.throws(() => run(seed, { type: "record_attendance", reference: "DEMO-4812", outcome: "attended" }), { code: "visit_not_started" });
  });
});

describe("documents, tasks, waitlist, and texts", () => {
  it("closes the document loop when the sample arrives", () => {
    const outcome = run(createSeedState(NOW), { type: "mark_document_received", documentId: "doc-1" });
    assert.equal(outcome.state.appointments.find((item) => item.reference === "DEMO-2954")!.documents, "Received");
    assert.equal(outcome.state.tasks.find((item) => item.id === "task-2")!.status, "Done");
    assert.ok(outcome.state.messages.filter((item) => item.purpose === "48-hour missing-document follow-up" && item.appointmentReference === "DEMO-2954").every((item) => item.status === "Cancelled (demo)"));
  });

  it("creates anonymous staff tasks once per idempotency key", () => {
    const seed = createSeedState(NOW);
    const first = run(seed, { type: "create_task", requestType: "accessibility" }, { key: "call-1|accessibility" });
    assert.equal(first.task!.patient, "Front desk");
    assert.equal(run(first.state, { type: "create_task", requestType: "accessibility" }, { key: "call-1|accessibility" }).changed, false);
    const done = run(first.state, { type: "update_task", taskId: first.task!.id, status: "Done" });
    assert.equal(done.task!.status, "Done");
  });

  it("deduplicates waitlist requests and refuses past dates", () => {
    const seed = createSeedState(NOW);
    const action: DemoAction = { type: "join_waitlist", patient: "Jordan Lee", appointmentType: "Consultation", preferredDate: "2026-10-15", timezone: tz };
    const first = run(seed, action);
    assert.equal(run(first.state, action).changed, false);
    assert.throws(() => run(seed, { ...action, preferredDate: "2026-10-01" }), { code: "invalid_date" });
  });

  it("suppresses pending texts after a simulated STOP and allows START again", () => {
    const seed = createSeedState(NOW);
    const stop = run(seed, { type: "set_sms_preference", patient: "Jordan Lee", optedOut: true });
    const jordanPending = stop.state.messages.filter((item) => item.recipient.startsWith("Jordan Lee") && (item.status === "Scheduled (demo)" || item.status === "Queued (demo)"));
    assert.equal(jordanPending.length, 0);
    const start = run(stop.state, { type: "set_sms_preference", patient: "Jordan Lee", optedOut: false });
    assert.equal(start.state.smsPreferences.find((item) => item.patient === "Jordan Lee")!.optedOut, false);
  });

  it("delivers only due texts and reports when nothing changed", () => {
    const seed = createSeedState(NOW);
    const later = NOW + 3 * 24 * 60 * 60 * 1000;
    const processed = processDueMessages(seed, later);
    assert.equal(processed.changed, true);
    assert.ok(processed.state.messages.every((item) => item.status !== "Queued (demo)"));
    assert.equal(processDueMessages(processed.state, later).changed, false);
  });

  it("resets to fresh sample data", () => {
    const outcome = run(createSeedState(NOW - 10 * 24 * 60 * 60 * 1000), { type: "reset_demo" });
    assert.ok(outcome.state.events.some((item) => item.action === "Sample data reset"));
    assert.ok(outcome.state.appointments.some((item) => Date.parse(item.startAt) > NOW));
  });
});

describe("stored data and request validation", () => {
  it("upgrades a snapshot written by the previous version", () => {
    const legacy = {
      appointments: [{ id: "apt-1", patient: "Maya Patel", reference: "DEMO-4812", type: "New patient visit", provider: "Dr. Avery Chen", location: "Main clinic", startAt: "2026-10-03T22:49:19.487Z", status: "Confirmed", documents: "Received" }],
      tasks: [{ id: "task-1", title: "Medical records request", patient: "Jordan Lee", detail: "Request captured for the records team. No records are accessed or released in the demo.", dueAt: "2026-10-04T10:00:00.000Z", priority: "Normal", status: "Open" }],
      referrals: [],
      messages: [
        { id: "msg-1", recipient: "Alex Morgan · DEMO-8162", purpose: "Opt-out", body: "Text reminders have been turned off for this demo profile.", sentAt: "2026-10-03T05:49:19.487Z", status: "Opt-out" },
        { id: "msg-1", recipient: "Maya Patel", purpose: "Cancellation confirmation", body: "Your sample appointment has been cancelled. This is a demo message; nothing was sent.", sentAt: "2026-10-04T05:49:19.487Z", status: "Queued (demo)" },
      ],
      waitlist: [],
    };
    const result = normalizeDemoState(legacy);
    assert.ok(result);
    assert.equal(result.migrated, true);
    assert.equal(result.state.smsPreferences.find((item) => item.patient === "Alex Morgan")!.optedOut, true);
    assert.deepEqual(result.state.messages.map((item) => item.id), ["msg-1", "msg-1-2"]);
    assert.equal(normalizeDemoState({ appointments: "nope" }), null);
  });

  it("rejects free text and unknown people in a snapshot", () => {
    const seed = createSeedState(NOW);
    assert.equal(validateDemoState({ ...seed, tasks: [{ ...seed.tasks[0], detail: "Patient reports chest pain" }] }), false);
    assert.equal(validateDemoState({ ...seed, appointments: [{ ...seed.appointments[0], patient: "John Smith" }] }), false);
    assert.equal(validateDemoState({ ...seed, extra: [] }), false);
  });

  it("parses only well-formed actions", () => {
    assert.deepEqual(parseDemoAction({ type: "create_task", requestType: "billing" }), { type: "create_task", requestType: "billing" });
    assert.throws(() => parseDemoAction({ type: "create_task", requestType: "billing", note: "free text" }), { code: "invalid_action" });
    assert.throws(() => parseDemoAction({ type: "update_task", taskId: "task-1", status: "Deleted" }), { code: "invalid_action" });
    assert.throws(() => parseDemoAction({ type: "drop_tables" }), { code: "invalid_action" });
    assert.throws(() => parseDemoAction({ type: "set_sms_preference", patient: "Maya Patel", optedOut: "yes" }), { code: "invalid_action" });
  });
});

describe("approved FAQ search", () => {
  const cases: Array<[string, string | undefined, boolean]> = [
    ["Can you refill my prescription?", "refill", true],
    ["I'm running out of my blood pressure pills, can I get a refill", "refill", true],
    ["Should I take ibuprofen before my visit?", "clinical", true],
    ["What does this rash mean?", "clinical", true],
    ["Someone is unconscious, what do I do", "emergency", true],
    ["Is there parking?", "parking", false],
    ["What time do you open?", "hours", false],
    ["Are you open on Saturday?", "after-hours", false],
    ["Do you take my insurance plan?", "insurance", false],
    ["Can I get a wheelchair at the clinic?", "accessibility", false],
    ["How do I register as a new patient?", "new-patient", false],
    ["Do you sell gift cards for the cafe?", undefined, true],
  ];
  for (const [question, expected, handoff] of cases) {
    it(`routes "${question}"`, () => {
      const result = searchApprovedFaq(question);
      assert.equal(result.faqId, expected);
      assert.equal(result.handoff, handoff);
    });
  }
});
