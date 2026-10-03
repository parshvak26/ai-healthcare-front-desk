import type { DemoState, Market } from "../types";

function atHour(hoursFromNow: number) {
  return new Date(Date.now() + hoursFromNow * 60 * 60 * 1000).toISOString();
}

export const initialMarket: Market = "USA";

export function createSeedState(): DemoState {
  return {
    appointments: [
      {
        id: "apt-1001",
        patient: "Maya Patel",
        reference: "DEMO-4812",
        type: "New patient visit",
        provider: "Dr. Avery Chen",
        location: "Main clinic",
        startAt: atHour(5),
        status: "Confirmed",
        documents: "Received",
      },
      {
        id: "apt-1002",
        patient: "Jordan Lee",
        reference: "DEMO-2954",
        type: "Follow-up visit",
        provider: "Dr. Avery Chen",
        location: "Main clinic",
        startAt: atHour(28),
        status: "Confirmed",
        documents: "Needed",
      },
      {
        id: "apt-1003",
        patient: "Samira Khan",
        reference: "DEMO-7730",
        type: "Consultation",
        provider: "Dr. Noah Rivera",
        location: "North clinic",
        startAt: atHour(53),
        status: "Needs confirmation",
        documents: "In review",
      },
      {
        id: "apt-1004",
        patient: "Alex Morgan",
        reference: "DEMO-8162",
        type: "New patient visit",
        provider: "Dr. Noah Rivera",
        location: "North clinic",
        startAt: atHour(76),
        status: "Confirmed",
        documents: "Received",
      },
    ],
    tasks: [
      {
        id: "task-1",
        title: "Call back requested",
        patient: "Samira Khan",
        detail: "Asked for help confirming the appointment location.",
        dueAt: atHour(2),
        priority: "Today",
        status: "Open",
      },
      {
        id: "task-2",
        title: "Referral document missing",
        patient: "Jordan Lee",
        detail: "Follow up on the referral form before the visit.",
        dueAt: atHour(18),
        priority: "Normal",
        status: "Open",
      },
      {
        id: "task-3",
        title: "Billing question",
        patient: "Maya Patel",
        detail: "Asked the front desk to explain the demo billing FAQ.",
        dueAt: atHour(24),
        priority: "Normal",
        status: "In progress",
      },
      {
        id: "task-4",
        title: "Records request",
        patient: "Alex Morgan",
        detail: "Request received; staff follow-up required.",
        dueAt: atHour(30),
        priority: "Normal",
        status: "Open",
      },
    ],
    referrals: [
      {
        id: "doc-1",
        patient: "Jordan Lee",
        reference: "DEMO-2954",
        appointment: "Follow-up visit",
        document: "Referral letter · sample.pdf",
        status: "Needed",
      },
      {
        id: "doc-2",
        patient: "Samira Khan",
        reference: "DEMO-7730",
        appointment: "Consultation",
        document: "Intake form · sample.pdf",
        receivedAt: atHour(-8),
        status: "In review",
      },
      {
        id: "doc-3",
        patient: "Maya Patel",
        reference: "DEMO-4812",
        appointment: "New patient visit",
        document: "Insurance card · sample image",
        receivedAt: atHour(-20),
        status: "Received",
      },
    ],
    messages: [
      {
        id: "msg-1",
        recipient: "Maya Patel · DEMO-4812",
        purpose: "Booking confirmation",
        body: "Your demo appointment is confirmed. Reply STOP to opt out.",
        sentAt: atHour(-2),
        status: "Delivered (demo)",
      },
      {
        id: "msg-2",
        recipient: "Jordan Lee · DEMO-2954",
        purpose: "Document reminder",
        body: "A referral document is still needed for your demo visit.",
        sentAt: atHour(-5),
        status: "Queued (demo)",
      },
      {
        id: "msg-3",
        recipient: "Alex Morgan · DEMO-8162",
        purpose: "Opt-out",
        body: "Text reminders have been turned off for this demo profile.",
        sentAt: atHour(-12),
        status: "Opt-out",
      },
    ],
  };
}

export interface FaqEntry {
  id: string;
  category: string;
  question: string;
  answer: string;
  updated: string;
}

export const faqEntries: FaqEntry[] = [
  {
    id: "hours",
    category: "Visiting the clinic",
    question: "What are your opening hours?",
    answer: "The demo clinic is open Monday to Friday, 8:00 AM to 5:00 PM, in the clinic's selected timezone. Holiday hours need staff confirmation.",
    updated: "Reviewed today",
  },
  {
    id: "parking",
    category: "Visiting the clinic",
    question: "Where are you, and where can I park?",
    answer: "This fictional demo has a Main clinic and a North clinic. Ask the front desk for the demo address and parking instructions before travelling.",
    updated: "Reviewed today",
  },
  {
    id: "insurance",
    category: "Billing and insurance",
    question: "Do you accept my insurance?",
    answer: "The demo cannot confirm coverage. Coverage depends on your plan. The clinic's billing team can help check a real plan.",
    updated: "Reviewed today",
  },
  {
    id: "late",
    category: "Appointments",
    question: "What if I am running late?",
    answer: "Please contact the front desk as soon as you can. Staff will confirm whether your appointment can still go ahead.",
    updated: "Reviewed today",
  },
  {
    id: "reschedule",
    category: "Appointments",
    question: "How do I reschedule or cancel?",
    answer: "The front desk can check the demo appointment using its demo reference and help change it. A change is complete only after the schedule confirms it.",
    updated: "Reviewed today",
  },
  {
    id: "documents",
    category: "Forms and referrals",
    question: "What documents do I need to bring?",
    answer: "The checklist depends on the appointment type. The demo console shows the requested sample documents. Please ask staff about real visit requirements.",
    updated: "Reviewed today",
  },
  {
    id: "referral",
    category: "Forms and referrals",
    question: "How can I send a referral?",
    answer: "The demo can mark a supplied sample referral as received. Do not upload a real referral or any document with personal health information.",
    updated: "Reviewed today",
  },
  {
    id: "records",
    category: "Other requests",
    question: "Can I request my medical records?",
    answer: "The demo can create a staff follow-up task, but it cannot access or release medical records.",
    updated: "Reviewed today",
  },
  {
    id: "refill",
    category: "Other requests",
    question: "Can you refill my prescription?",
    answer: "The demo can pass a refill request to clinic staff. It cannot approve, change, or advise about medication.",
    updated: "Reviewed today",
  },
  {
    id: "clinical",
    category: "Other requests",
    question: "Can you tell me what my symptoms mean?",
    answer: "This assistant only handles front desk tasks and cannot answer medical questions. Please speak with a clinician. For an emergency, contact your local emergency service.",
    updated: "Approved safety response",
  },
];
