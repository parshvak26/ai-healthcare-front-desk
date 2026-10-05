export type Market = "USA" | "UAE" | "Europe" | "India";
export type AppointmentStatus = "Confirmed" | "Needs confirmation" | "Cancelled";
export type TaskStatus = "Open" | "In progress" | "Done";
export type DocumentStatus = "Needed" | "Received" | "In review";

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
  priority: "Normal" | "Today" | "Urgent";
  status: TaskStatus;
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

export interface MessageItem {
  id: string;
  recipient: string;
  purpose: string;
  body: string;
  sentAt: string;
  scheduledFor?: string;
  appointmentReference?: string;
  status: "Delivered (demo)" | "Queued (demo)" | "Scheduled (demo)" | "Cancelled (demo)" | "Opt-out";
}

export interface WaitlistItem {
  id: string;
  patient: string;
  appointmentType: string;
  preferredDate: string;
  timezone: string;
  createdAt: string;
  status: "Waiting" | "Opening found" | "Contacted" | "Booked" | "Cancelled";
}

export interface DemoState {
  appointments: Appointment[];
  tasks: FollowUpTask[];
  referrals: ReferralItem[];
  messages: MessageItem[];
  waitlist: WaitlistItem[];
}
