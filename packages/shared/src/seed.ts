// Fictional starting data, anchored to the clinic's real opening hours so the demo always looks plausible.
import { allowedDemoPatients, clinicHours, defaultClinicTimezone, requestTemplates, systemTaskTemplates } from "./catalog.ts";
import { DAY, HOUR, documentFollowUpTime, documentTaskDue, iso, messageText, reminderTime } from "./schedule.ts";
import { addDaysToDateKey, localDateKey, weekdayOfDateKey, zonedTimeToUtc } from "./time.ts";
import { messageBodies } from "./validation.ts";
import type { Appointment, DemoState, MessageItem } from "./types.ts";

function openDate(from: string, direction: 1 | -1, skip = 0) {
  let date = from;
  let found = -1;
  while (found < skip) {
    date = addDaysToDateKey(date, direction);
    if ((clinicHours.openWeekdays as readonly number[]).includes(weekdayOfDateKey(date))) found += 1;
  }
  return date;
}

export function createSeedState(now: number = Date.now(), timezone: string = defaultClinicTimezone): DemoState {
  const today = localDateKey(now, timezone);
  const [d1, d2, d3] = [openDate(today, 1, 0), openDate(today, 1, 1), openDate(today, 1, 2)];
  const previous = openDate(today, -1, 0);
  const at = (date: string, time: string) => zonedTimeToUtc(date, time, timezone) as string;
  const ago = (hours: number) => iso(now - hours * HOUR);

  const appointments: Appointment[] = [
    { id: "apt-1001", patient: "Maya Patel", reference: "DEMO-4812", type: "New patient visit", provider: "Dr. Avery Chen", location: "Main clinic", startAt: at(d1, "09:00"), timezone, status: "Confirmed", documents: "Received" },
    { id: "apt-1002", patient: "Jordan Lee", reference: "DEMO-2954", type: "Consultation", provider: "Dr. Avery Chen", location: "Main clinic", startAt: at(d1, "14:30"), timezone, status: "Confirmed", documents: "Needed" },
    { id: "apt-1003", patient: "Samira Khan", reference: "DEMO-7730", type: "Follow-up visit", provider: "Dr. Noah Rivera", location: "North clinic", startAt: at(d2, "11:00"), timezone, status: "Needs confirmation", documents: "In review" },
    { id: "apt-1004", patient: "Alex Morgan", reference: "DEMO-8162", type: "New patient visit", provider: "Dr. Noah Rivera", location: "North clinic", startAt: at(d3, "10:00"), timezone, status: "Confirmed", documents: "Received" },
    { id: "apt-1000", patient: "Taylor Reed", reference: "DEMO-3307", type: "Administrative call", provider: "Dr. Avery Chen", location: "Main clinic", startAt: at(previous, "15:00"), timezone, status: "Confirmed", documents: "Received" },
  ];

  const messages: MessageItem[] = [
    { id: "msg-1", recipient: "Maya Patel · DEMO-4812", purpose: "Booking confirmation", body: messageBodies.seededConfirmation, sentAt: ago(2), appointmentReference: "DEMO-4812", status: "Delivered (demo)" },
    { id: "msg-2", recipient: "Jordan Lee · DEMO-2954", purpose: "Document reminder", body: messageBodies.documentReminder, sentAt: ago(5), appointmentReference: "DEMO-2954", status: "Delivered (demo)" },
    { id: "msg-3", recipient: "Alex Morgan · DEMO-8162", purpose: "Opt-out", body: messageBodies.optOut, sentAt: ago(12), appointmentReference: "DEMO-8162", status: "Opt-out" },
  ];
  // Reminders follow the same rules as live bookings. Alex Morgan has opted out, so none is planned for that visit.
  appointments.filter((item) => item.patient !== "Alex Morgan" && Date.parse(item.startAt) > now).forEach((item, index) => {
    const due = reminderTime(item.startAt, timezone, now);
    if (due) messages.push({ id: `msg-r${index + 1}`, recipient: `${item.patient} · ${item.reference}`, purpose: "24-hour appointment reminder", body: messageText.reminder(item.startAt, timezone), sentAt: ago(1), scheduledFor: iso(due), appointmentReference: item.reference, status: "Scheduled (demo)" });
  });
  const jordan = appointments[1];
  const followUp = documentFollowUpTime(jordan.startAt, timezone, now - 5 * HOUR);
  if (followUp) messages.push({ id: "msg-d1", recipient: "Jordan Lee · DEMO-2954", purpose: "48-hour missing-document follow-up", body: messageBodies.documentFollowUp, sentAt: ago(5), scheduledFor: iso(followUp), appointmentReference: "DEMO-2954", status: "Scheduled (demo)" });

  return {
    appointments,
    tasks: [
      { id: "task-1", title: requestTemplates.callback.title, patient: "Samira Khan", detail: "Asked for help confirming the appointment location.", dueAt: iso(now + 2 * HOUR), priority: "Today", status: "Open", appointmentReference: "DEMO-7730" },
      { id: "task-2", title: systemTaskTemplates.missingDocument.title, patient: "Jordan Lee", detail: systemTaskTemplates.missingDocument.detail, dueAt: iso(documentTaskDue(jordan.startAt, now)), priority: "Normal", status: "Open", appointmentReference: "DEMO-2954" },
      { id: "task-3", title: requestTemplates.billing.title, patient: "Maya Patel", detail: "Asked the front desk to explain the demo billing FAQ.", dueAt: iso(now + DAY), priority: "Normal", status: "In progress" },
      { id: "task-4", title: requestTemplates.records.title, patient: "Alex Morgan", detail: "Request received; staff follow-up required.", dueAt: iso(now + 30 * HOUR), priority: "Normal", status: "Open" },
    ],
    referrals: [
      { id: "doc-1", patient: "Jordan Lee", reference: "DEMO-2954", appointment: "Consultation", document: "Referral letter · sample.pdf", status: "Needed" },
      { id: "doc-2", patient: "Samira Khan", reference: "DEMO-7730", appointment: "Follow-up visit", document: "Intake form · sample.pdf", receivedAt: ago(8), status: "In review" },
      { id: "doc-3", patient: "Maya Patel", reference: "DEMO-4812", appointment: "New patient visit", document: "Insurance card · sample image", receivedAt: ago(20), status: "Received" },
    ],
    messages,
    waitlist: [
      // Matches Samira Khan's visit, so cancelling DEMO-7730 shows the waitlist hand-off.
      { id: "wait-1", patient: "Taylor Reed", appointmentType: "Follow-up visit", preferredDate: d2, timezone, createdAt: ago(4), status: "Waiting" },
      { id: "wait-2", patient: "Maya Patel", appointmentType: "Consultation", preferredDate: d3, timezone, createdAt: ago(1), status: "Waiting" },
    ],
    events: [
      { id: "evt-seed-1", at: ago(1), action: "Waitlist request added", channel: "Staff console", patient: "Maya Patel" },
      { id: "evt-seed-2", at: ago(2), action: "Appointment booked", channel: "Voice assistant", patient: "Maya Patel", reference: "DEMO-4812" },
      { id: "evt-seed-3", at: ago(3), action: "Staff task created", channel: "Voice assistant", patient: "Samira Khan", reference: "DEMO-7730" },
      { id: "evt-seed-4", at: ago(12), action: "Text reminders turned off", channel: "Automation", patient: "Alex Morgan" },
    ],
    smsPreferences: allowedDemoPatients.map((patient) => ({ patient, optedOut: patient === "Alex Morgan", updatedAt: patient === "Alex Morgan" ? ago(12) : ago(7 * 24) })),
  };
}
