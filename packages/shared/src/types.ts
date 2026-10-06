export type Market = "USA" | "UAE" | "Europe" | "India";
export type AppointmentStatus = "Confirmed" | "Needs confirmation" | "Cancelled" | "Completed" | "Missed";
export type TaskStatus = "Open" | "In progress" | "Done";
export type TaskPriority = "Normal" | "Today" | "Urgent";
export type DocumentStatus = "Needed" | "Received" | "In review";
export type Channel = "Staff console" | "Voice assistant" | "Automation";

export interface Appointment {
  id: string;
  patient: string;
  reference: string;
  type: string;
  provider: string;
  location: string;
  startAt: string;
  timezone?: string;
  status: AppointmentStatus;
  documents: DocumentStatus;
}

export interface FollowUpTask {
  id: string;
  title: string;
  patient: string;
  detail: string;
  dueAt: string;
  priority: TaskPriority;
  status: TaskStatus;
  appointmentReference?: string;
}

export interface ReferralItem {
  id: string;
  patient: string;
  reference: string;
  appointment: string;
  document: string;
  receivedAt?: string;
  status: DocumentStatus;
}

export type MessageStatus =
  | "Delivered (demo)"
  | "Queued (demo)"
  | "Scheduled (demo)"
  | "Cancelled (demo)"
  | "Suppressed (opt-out)"
  | "Opt-out";

export interface MessageItem {
  id: string;
  recipient: string;
  purpose: string;
  body: string;
  sentAt: string;
  scheduledFor?: string;
  appointmentReference?: string;
  status: MessageStatus;
}

export type WaitlistStatus = "Waiting" | "Opening found" | "Contacted" | "Booked" | "Cancelled";

export interface WaitlistItem {
  id: string;
  patient: string;
  appointmentType: string;
  preferredDate: string;
  timezone: string;
  createdAt: string;
  status: WaitlistStatus;
}

export type ActivityAction =
  | "Appointment booked"
  | "Appointment rescheduled"
  | "Appointment cancelled"
  | "Appointment confirmed"
  | "Visit marked attended"
  | "Visit marked missed"
  | "Waitlist request added"
  | "Waitlist request cancelled"
  | "Waitlist opening found"
  | "Document received"
  | "Staff task created"
  | "Staff task updated"
  | "Text reminders turned off"
  | "Text reminders turned on"
  | "Sample data reset";

export interface ActivityEvent {
  id: string;
  at: string;
  action: ActivityAction;
  channel: Channel;
  patient?: string;
  reference?: string;
  /** The staff task this event created, so a call summary can name it. */
  taskId?: string;
}

export interface SmsPreference {
  patient: string;
  optedOut: boolean;
  updatedAt: string;
}

export interface DemoState {
  appointments: Appointment[];
  tasks: FollowUpTask[];
  referrals: ReferralItem[];
  messages: MessageItem[];
  waitlist: WaitlistItem[];
  events: ActivityEvent[];
  smsPreferences: SmsPreference[];
}

export interface DemoSnapshot {
  state: DemoState;
  revision: number;
}

export interface AvailabilitySlot {
  startAt: string;
  timezone: string;
  provider: string;
  location: string;
  /** Human-readable clinic-local time, for voice read-back and the console. */
  localTime: string;
}

export type RequestType = "callback" | "refill" | "records" | "billing" | "documents" | "faq" | "accessibility" | "faq_review";

export type DemoAction =
  | { type: "book_appointment"; patient: string; appointmentType: string; startAt: string; timezone: string; provider?: string }
  | { type: "reschedule_appointment"; reference: string; patient: string; newStartAt: string; timezone: string; provider?: string }
  | { type: "cancel_appointment"; reference: string; patient: string }
  | { type: "confirm_appointment"; reference: string; patient: string }
  | { type: "record_attendance"; reference: string; outcome: "attended" | "missed" }
  | { type: "join_waitlist"; patient: string; appointmentType: string; preferredDate: string; timezone: string }
  | { type: "cancel_waitlist"; waitlistId: string }
  | { type: "mark_document_received"; documentId: string }
  | { type: "create_task"; requestType: RequestType; patient?: string }
  | { type: "update_task"; taskId: string; status: TaskStatus }
  | { type: "set_sms_preference"; patient: string; optedOut: boolean }
  | { type: "reset_demo" };

export type DemoActionType = DemoAction["type"];

export interface ActionContext {
  /** Milliseconds since epoch. Injected so the rules are deterministic and testable. */
  now: number;
  channel: Channel;
  /** Idempotency key: the same key always produces the same record IDs, so retries cannot duplicate work. */
  key: string;
  random: () => number;
  /** Clinic timezone used when the demo is reset. Defaults to the catalog clinic timezone. */
  seedTimezone?: string;
}

export interface ActionOutcome {
  state: DemoState;
  /** False when the action was already applied (an idempotent replay) or changed nothing. */
  changed: boolean;
  message: string;
  appointment?: Appointment;
  waitlistItem?: WaitlistItem;
  task?: FollowUpTask;
}
