// Fictional clinic configuration and approved demo content. Nothing here describes a real clinic or person.
import type { Market, RequestType, TaskPriority } from "./types.ts";

export const clinicName = "Harbor Health Demo";
export const defaultClinicTimezone = "America/Chicago";

export const allowedDemoPatients = ["Maya Patel", "Jordan Lee", "Samira Khan", "Alex Morgan", "Taylor Reed"] as const;
export type DemoPatient = (typeof allowedDemoPatients)[number];

export const appointmentTypes = ["New patient visit", "Follow-up visit", "Consultation", "Administrative call"] as const;

export const serviceDurations: Record<string, number> = {
  "New patient visit": 60,
  "Follow-up visit": 30,
  Consultation: 45,
  "Administrative call": 15,
};

/** Appointment types that need a sample referral document before the visit. */
export const typesNeedingDocuments = new Set(["New patient visit", "Consultation"]);

export const providers = [
  { name: "Dr. Avery Chen", location: "Main clinic" },
  { name: "Dr. Noah Rivera", location: "North clinic" },
] as const;

export const clinicHours = { openMinute: 8 * 60, closeMinute: 17 * 60, slotStepMinutes: 30, openWeekdays: [1, 2, 3, 4, 5] } as const;

/** Simulated texts are only "sent" between these local hours; anything else waits for the next window. */
export const quietHours = { startMinute: 9 * 60, endMinute: 20 * 60 } as const;

export const marketTimezones: Record<Market, string[]> = {
  USA: ["America/New_York", "America/Chicago", "America/Los_Angeles"],
  UAE: ["Asia/Dubai"],
  Europe: ["Europe/London", "Europe/Paris", "Europe/Berlin"],
  India: ["Asia/Kolkata"],
};

export const allClinicTimezones = [...new Set(Object.values(marketTimezones).flat())];

export interface TaskTemplate {
  title: string;
  detail: string;
  priority: TaskPriority;
}

/** Anonymous staff tasks. Free text is never stored, so callers cannot leave personal or health details. */
export const requestTemplates: Record<RequestType, TaskTemplate> = {
  callback: { title: "Call back requested", detail: "Caller asked to speak with a member of the front desk.", priority: "Today" },
  refill: { title: "Prescription request", detail: "Request passed to staff. The demo does not approve or advise about medication.", priority: "Normal" },
  records: { title: "Records request", detail: "Request captured for the records team. No records are accessed or released in the demo.", priority: "Normal" },
  billing: { title: "Billing question", detail: "Question routed to the billing team. The demo does not confirm coverage or charges.", priority: "Normal" },
  documents: { title: "Referral document follow-up", detail: "Caller needs help with the sample referral checklist.", priority: "Normal" },
  faq: { title: "FAQ needs review", detail: "An unlisted FAQ needs staff review. The question text is not stored.", priority: "Normal" },
  accessibility: { title: "Accessibility or interpreter request", detail: "Caller asked for accessibility or interpreter support. Staff will confirm the arrangements.", priority: "Today" },
  faq_review: { title: "FAQ needs review", detail: "A published demo FAQ was flagged for staff review. No caller text was stored.", priority: "Normal" },
};

/** Request types the voice assistant may create. FAQ review flags come from the staff console only. */
export const voiceRequestTypes: RequestType[] = ["callback", "refill", "records", "billing", "documents", "faq", "accessibility"];

export const requestTypes = Object.keys(requestTemplates) as RequestType[];

export const systemTaskTemplates = {
  missingDocument: { title: "Referral document missing", detail: "Check whether the sample referral has arrived; the 48-hour text remains simulated.", priority: "Normal" },
  waitlistOpening: { title: "Waitlist follow-up", detail: "A sample opening is available; confirm the waitlist request with the sample patient.", priority: "Today" },
  missedVisit: { title: "Missed appointment follow-up", detail: "The sample patient missed the visit. Offer to rebook; no text was sent.", priority: "Today" },
} satisfies Record<string, TaskTemplate>;

/** Older task wording that may still exist in stored demo data; accepted so old snapshots stay valid. */
export const legacyTaskTitles = ["Medical records request", "FAQ question"];
export const legacyTaskDetails = [
  "Asked for help confirming the appointment location.",
  "Follow up on the referral form before the visit.",
  "Asked the front desk to explain the demo billing FAQ.",
  "Request received; staff follow-up required.",
];

export interface FaqEntry {
  id: string;
  category: string;
  question: string;
  answer: string;
  /** The same approved answer, worded to be spoken by the voice agent in the first person. */
  voiceAnswer: string;
  updated: string;
  keywords: string[];
}

export const faqEntries: FaqEntry[] = [
  {
    id: "hours",
    category: "Visiting the clinic",
    question: "What are your opening hours?",
    answer: "The demo clinic is open Monday to Friday, 8:00 AM to 5:00 PM, in the clinic's selected timezone. Holiday hours need staff confirmation.",
    voiceAnswer: "We're open Monday to Friday, 8 a.m. to 5 p.m. Central time. Holiday hours are confirmed by the front desk team.",
    updated: "Reviewed today",
    keywords: ["hours", "open", "opening", "close", "closing"],
  },
  {
    id: "after-hours",
    category: "Visiting the clinic",
    question: "Are you open on weekends, holidays, or after hours?",
    answer: "The demo clinic is closed on weekends. Holiday closures need staff confirmation. Outside opening hours, the assistant can still take a callback request for the next business day.",
    voiceAnswer: "We're closed on weekends, and holiday closures are confirmed by staff. Outside opening hours I can still book a visit or log a callback for the next business day.",
    updated: "Reviewed today",
    keywords: ["weekend", "saturday", "sunday", "holiday", "after", "evening", "night", "closed"],
  },
  {
    id: "parking",
    category: "Visiting the clinic",
    question: "Where are you, and where can I park?",
    answer: "This fictional demo has a Main clinic and a North clinic. Ask the front desk for the demo address and parking instructions before travelling.",
    voiceAnswer: "We have two locations, the Main clinic and the North clinic. This is a demo clinic, so there's no real address or parking to share. I can log a request for the front desk if you need directions.",
    updated: "Reviewed today",
    keywords: ["park", "parking", "address", "location", "located", "where", "directions", "find"],
  },
  {
    id: "accessibility",
    category: "Visiting the clinic",
    question: "Can you arrange accessibility support or an interpreter?",
    answer: "The front desk can record an accessibility or interpreter request so staff can arrange support before the visit.",
    voiceAnswer: "Yes. I can log an accessibility or interpreter request so the team can arrange support before your visit.",
    updated: "Reviewed today",
    keywords: ["accessib", "wheelchair", "interpret", "translator", "language", "disabilit", "ramp", "elevator", "hearing", "deaf", "blind"],
  },
  {
    id: "contact",
    category: "Visiting the clinic",
    question: "How can I contact the front desk?",
    answer: "This fictional clinic has no real phone line or email. In the demo, ask the assistant to request a staff callback.",
    voiceAnswer: "You're through to the front desk now. I can also log a callback request so a team member follows up.",
    updated: "Reviewed today",
    keywords: ["contact", "email", "phone", "call", "reach", "speak", "person", "human", "staff", "someone"],
  },
  {
    id: "new-patient",
    category: "Appointments",
    question: "How do I book as a new patient?",
    answer: "The front desk can book a sample new patient visit. The demo lists a referral document as the sample paperwork for new patient visits; staff confirm any real registration steps.",
    voiceAnswer: "Happy to help you book as a new patient. A new patient visit takes about an hour, and a referral document is the paperwork we'll ask for.",
    updated: "Reviewed today",
    keywords: ["new", "register", "registration", "first", "join"],
  },
  {
    id: "confirm",
    category: "Appointments",
    question: "Can you confirm my appointment?",
    answer: "The assistant can look up a demo appointment with its DEMO reference and sample name, read back the time in the clinic's timezone, and confirm it if staff marked it as needing confirmation.",
    voiceAnswer: "Sure. Tell me your name or your booking reference, and I'll look it up and confirm it.",
    updated: "Reviewed today",
    keywords: ["confirm", "confirmation", "check", "when", "lookup", "booked"],
  },
  {
    id: "late",
    category: "Appointments",
    question: "What if I am running late?",
    answer: "Please contact the front desk as soon as you can. Staff will confirm whether your appointment can still go ahead.",
    voiceAnswer: "Please let us know as soon as you can. I can log a callback so the team can confirm whether your visit can still go ahead.",
    updated: "Reviewed today",
    keywords: ["late", "delay", "delayed", "running", "traffic"],
  },
  {
    id: "reschedule",
    category: "Appointments",
    question: "How do I reschedule or cancel?",
    answer: "The front desk can check the demo appointment using its demo reference and help change it. A change is complete only after the schedule confirms it.",
    voiceAnswer: "I can move or cancel a visit for you. I just need your name or your booking reference.",
    updated: "Reviewed today",
    keywords: ["reschedule", "cancel", "change", "move", "different"],
  },
  {
    id: "preparation",
    category: "Appointments",
    question: "How should I prepare for my appointment?",
    answer: "Bring the documents listed for your demo appointment. For any other preparation, the front desk will confirm the clinic's instructions.",
    voiceAnswer: "Please bring the documents listed for your visit. For anything else, the front desk team will confirm the instructions.",
    updated: "Reviewed today",
    keywords: ["prepare", "preparation", "bring", "before", "ready"],
  },
  {
    id: "documents",
    category: "Forms and referrals",
    question: "What documents do I need to bring?",
    answer: "The checklist depends on the appointment type. The demo console shows the requested sample documents. Please ask staff about real visit requirements.",
    voiceAnswer: "It depends on the visit. New patient visits and consultations need a referral document, and I can check its status for your booking.",
    updated: "Reviewed today",
    keywords: ["document", "documents", "form", "forms", "paperwork", "checklist"],
  },
  {
    id: "referral",
    category: "Forms and referrals",
    question: "How can I send a referral?",
    answer: "The demo can mark a supplied sample referral as received. Do not upload a real referral or any document with personal health information.",
    voiceAnswer: "This demo can't receive real documents, so please don't send any. I can check whether the sample referral for your visit is marked as received.",
    updated: "Reviewed today",
    keywords: ["referral", "refer", "send", "upload", "fax", "letter"],
  },
  {
    id: "insurance",
    category: "Billing and insurance",
    question: "Do you accept my insurance?",
    answer: "The demo cannot confirm coverage. Coverage depends on your plan. The clinic's billing team can help check a real plan.",
    voiceAnswer: "I can't confirm coverage, because it depends on your plan. I can log a billing question so the billing team can check it for you.",
    updated: "Reviewed today",
    keywords: ["insurance", "insurer", "coverage", "covered", "plan", "accept"],
  },
  {
    id: "billing",
    category: "Billing and insurance",
    question: "I have a question about a bill.",
    answer: "The assistant can pass a billing question to the clinic's billing team. It cannot confirm charges, payments, or coverage.",
    voiceAnswer: "I can pass a billing question to our billing team. I'm not able to confirm prices, charges, or payments myself.",
    updated: "Reviewed today",
    keywords: ["bill", "billing", "invoice", "charge", "cost", "price", "pay", "payment", "fee"],
  },
  {
    id: "records",
    category: "Other requests",
    question: "Can I request my medical records?",
    answer: "The demo can create a staff follow-up task, but it cannot access or release medical records.",
    voiceAnswer: "I can log a records request for the team. I can't access or release records myself.",
    updated: "Reviewed today",
    keywords: ["record", "records", "copy", "chart", "results", "report"],
  },
  {
    id: "refill",
    category: "Other requests",
    question: "Can you refill my prescription?",
    answer: "The demo can pass a refill request to clinic staff. It cannot approve, change, or advise about medication.",
    voiceAnswer: "I can pass a refill request to the clinical team, but I can't approve or advise on any medication.",
    updated: "Reviewed today",
    keywords: ["refill", "renew", "renewal"],
  },
  {
    id: "clinical",
    category: "Other requests",
    question: "Can you tell me what my symptoms mean?",
    answer: "This assistant only handles front desk tasks and cannot answer medical questions. Please speak with a clinician. For an emergency, contact your local emergency service.",
    voiceAnswer: "I can only help with front desk tasks, so I can't advise on symptoms or treatment. I can ask the clinical team to call you back. If it's an emergency, please hang up and call {{emergency_number}} now.",
    updated: "Approved safety response",
    keywords: [],
  },
  {
    id: "emergency",
    category: "Safety",
    question: "What should I do in an emergency?",
    answer: "If someone may be in immediate danger, contact your local emergency number now. This assistant cannot assess medical concerns.",
    voiceAnswer: "If someone may be in immediate danger, please hang up and call {{emergency_number}} now.",
    updated: "Approved safety response",
    keywords: [],
  },
];
