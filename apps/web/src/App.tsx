import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import {
  appointmentTypes, faqEntries, isOptedOut, patientNames, processDueMessages, requestTemplates, searchApprovedFaq,
} from "../../../packages/shared/src/index.ts";
import type { FaqSearchResult } from "../../../packages/shared/src/index.ts";
import { CallStatusBar } from "./CallStatusBar";
import { ApiRequestError, newIdempotencyKey, viewerTimezone } from "./lib/api";
import type { DemoBackend, DemoCallsInfo } from "./lib/api";
import { useCall } from "./lib/callController";
import { useDemo } from "./lib/demoContext";
import type { Connection } from "./lib/demoContext";
import { routeHref, takeHeadingFocus } from "./lib/routes";
import {
  allTimezones, formatDate, formatDateKey, formatDateTime, formatTime, isClinicOpen, marketTimezones, nextOpenDateKey, timezoneLabel, todayKey,
} from "./lib/timezone";
import type {
  ActivityEvent, Appointment, AvailabilitySlot, DemoAction, DemoState, FollowUpTask, Market, RequestType,
} from "./types";
import "./styles.css";

type Page = "Overview" | "Appointments" | "Waitlist" | "Referrals" | "Follow-ups" | "Messages" | "FAQs" | "Settings";
type Perform = (action: DemoAction, key?: string) => Promise<boolean>;
interface Toast { tone: "success" | "error"; text: string }

const pages: { name: Page; icon: string; group?: string }[] = [
  { name: "Overview", icon: "◈" },
  { name: "Appointments", icon: "▦", group: "FRONT DESK" },
  { name: "Waitlist", icon: "↗" },
  { name: "Referrals", icon: "▤" },
  { name: "Follow-ups", icon: "◷" },
  { name: "Messages", icon: "◌" },
  { name: "FAQs", icon: "?", group: "KNOWLEDGE" },
  { name: "Settings", icon: "⚙", group: "WORKSPACE" },
];

const marketNames: Market[] = ["USA", "UAE", "Europe", "India"];
const activeStatuses = new Set(["Confirmed", "Needs confirmation"]);
/** Voice-assistant changes this recent are tagged "From your call" (only this visitor's calls write to their demo). */
const fromCallWindowMs = 30 * 60_000;

const pageDescriptions: Record<Page, string> = {
  Overview: "Here’s what needs your attention today.",
  Appointments: "Manage the sample schedule and appointment requests.",
  Waitlist: "Track sample requests and follow up when a matching opening appears.",
  Referrals: "Track sample documents and referral follow-ups.",
  "Follow-ups": "Keep staff requests moving and close the loop.",
  Messages: "Review simulated confirmations, reminders, and opt-outs.",
  FAQs: "Approved answers for common front desk questions.",
  Settings: "Choose a market and review the demo service controls.",
};

function StatusPill({ children, tone = "neutral" }: { children: string; tone?: "neutral" | "green" | "amber" | "blue" | "red" }) {
  return <span className={`pill pill-${tone}`}><span className="pill-dot" />{children}</span>;
}

function Avatar({ name, size = "normal" }: { name: string; size?: "normal" | "small" }) {
  const initials = name.split(" ").map((part) => part[0]).slice(0, 2).join("");
  return <span className={`avatar avatar-${size}`}>{initials}</span>;
}

function formatShort(value: string, zone: string) {
  return formatDateTime(value, zone, { year: undefined });
}

function appointmentTone(status: Appointment["status"]): "green" | "amber" | "red" | "neutral" | "blue" {
  if (status === "Confirmed") return "green";
  if (status === "Completed") return "blue";
  if (status === "Cancelled" || status === "Missed") return "red";
  return "amber";
}

function taskTone(priority: FollowUpTask["priority"]): "amber" | "red" | "neutral" {
  if (priority === "Urgent") return "red";
  if (priority === "Today") return "amber";
  return "neutral";
}

const isPast = (appointment: Appointment, now: number) => Date.parse(appointment.startAt) <= now;
const needsOutcome = (appointment: Appointment, now: number) => activeStatuses.has(appointment.status) && isPast(appointment, now);
const fromRecentCall = (event: ActivityEvent, now: number) => event.channel === "Voice assistant" && now - Date.parse(event.at) < fromCallWindowMs;

function useNow(intervalMs = 60_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** The viewer's own zone first, then the market zones. */
function displayZones(viewer: string) {
  return allTimezones.includes(viewer) ? allTimezones : [viewer, ...allTimezones];
}

function App() {
  const demo = useDemo();
  const { busy: callBusy, dismiss: dismissCall } = useCall();
  const { connection, fallbackReason, backend } = demo;
  const viewerZone = useMemo(viewerTimezone, []);
  const [busy, setBusy] = useState(false);
  const [page, setPage] = useState<Page>("Overview");
  const [market, setMarket] = useState<Market>("USA");
  const [clinicTimezone, setClinicTimezone] = useState("America/Chicago");
  const [displayTimezone, setDisplayTimezone] = useState(viewerZone);
  const [showBooking, setShowBooking] = useState(false);
  const [showWaitlist, setShowWaitlist] = useState(false);
  const [moving, setMoving] = useState<Appointment | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [search, setSearch] = useState("");
  const now = useNow(30_000);
  // The server runs the simulated reminder job when it reads; running it again on this clock keeps the message log
  // current between polls (and "unchanged" conditional reads correct).
  const state = useMemo(() => (demo.state ? processDueMessages(demo.state, now).state : null), [demo.state, now]);
  const names = useMemo(() => (state ? patientNames(state) : []), [state]);

  // Arriving from the call page: the heading takes focus once this (lazily loaded) screen is on the page.
  useEffect(() => { takeHeadingFocus(); }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), toast.tone === "error" ? 6000 : 3500);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const performAction = demo.perform;
  const perform: Perform = useCallback(async (action, key = newIdempotencyKey()) => {
    setBusy(true);
    try {
      const response = await performAction(action, key);
      setToast({ tone: "success", text: response.result.appointment && action.type === "book_appointment"
        ? `Appointment confirmed · ${response.result.appointment.reference}`
        : response.result.message });
      return true;
    } catch (error) {
      const message = error instanceof ApiRequestError ? error.message : "The demo could not complete that request. Nothing was changed.";
      setToast({ tone: "error", text: message });
      return false;
    } finally {
      setBusy(false);
    }
  }, [performAction]);

  const openTasks = useMemo(() => state?.tasks.filter((task) => task.status !== "Done") ?? [], [state]);

  function changeMarket(nextMarket: Market) {
    setMarket(nextMarket);
    setClinicTimezone(marketTimezones[nextMarket][0]);
    setDisplayTimezone(marketTimezones[nextMarket][0]);
  }

  async function changeAppointment(appointment: Appointment, action: "cancel" | "confirm" | "attended" | "missed") {
    if (action === "cancel" && !window.confirm(`Cancel ${appointment.patient}'s sample appointment (${appointment.reference})? This only changes demo data and sends no text.`)) return;
    if (action === "cancel") await perform({ type: "cancel_appointment", reference: appointment.reference, patient: appointment.patient });
    if (action === "confirm") await perform({ type: "confirm_appointment", reference: appointment.reference, patient: appointment.patient });
    if (action === "attended" || action === "missed") await perform({ type: "record_attendance", reference: appointment.reference, outcome: action });
  }

  async function resetDemo() {
    const scope = connection === "cloud" ? "Your private demo goes back to the sample clinic; names and bookings from your calls are removed." : "This resets the copy kept in this browser.";
    if (!window.confirm(`Reset your demo to the original sample data? ${scope}`)) return;
    if (await perform({ type: "reset_demo" })) setPage("Overview");
  }

  async function deleteData() {
    if (callBusy) { setToast({ tone: "error", text: "A call is still running. End it first, then delete your demo data." }); return; }
    if (!window.confirm(connection === "cloud" ? "Delete your private demo now? Names and bookings from your calls are removed and a fresh sample clinic starts." : "Delete the demo copy kept in this browser?")) return;
    setBusy(true);
    try {
      await demo.forget();
      dismissCall();
      setToast({ tone: "success", text: "Your demo data was deleted. A fresh sample clinic is ready." });
      setPage("Overview");
    } catch (error) {
      setToast({ tone: "error", text: error instanceof ApiRequestError && error.code === "call_in_progress" ? "A call is still running for your demo. Try again once it has ended." : "Your demo data couldn't be deleted just now. Please try again." });
    } finally {
      setBusy(false);
    }
  }

  const pageTitle = page === "Overview" ? greeting(clinicTimezone, now) : page;
  const callsOn = connection === "cloud" && Boolean(demo.demoCalls?.enabled);
  const indicator = connection === "connecting" ? "CONNECTING…" : connection === "cloud" ? "PRIVATE DEMO · ONLY YOU SEE THIS" : "BROWSER-ONLY COPY";
  const assistantNote = connection === "cloud"
    ? (callsOn ? "Call Ava by phone or in your browser. Her changes show up here." : "Live calls are off right now. Texts are always simulated.")
    : connection === "connecting" ? "Connecting to the demo…" : "Browser-only copy. Calls are off; texts are simulated.";

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-lockup">
          <div className="brand-symbol"><span>+</span></div>
          <div><div className="brand-name">caredesk</div><div className="brand-caption">FRONT DESK OS</div></div>
        </div>
        <div className="clinic-switcher">
          <span className="clinic-avatar">HC</span>
          <span className="clinic-name"><strong>Harbor Health</strong><small>Demo clinic</small></span>
          <span className="switch-chevron">⌄</span>
        </div>
        <nav className="side-nav" aria-label="Main navigation">
          {pages.map((item) => (
            <div key={item.name}>
              {item.group && <div className="nav-group-label">{item.group}</div>}
              <button className={`nav-item ${page === item.name ? "nav-item-active" : ""}`} onClick={() => setPage(item.name)} aria-current={page === item.name ? "page" : undefined} aria-label={item.name}>
                <span className="nav-icon" aria-hidden="true">{item.icon}</span><span>{item.name}</span>
                {item.name === "Follow-ups" && openTasks.length > 0 && <span className="nav-count">{openTasks.length}</span>}
              </button>
            </div>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="assistant-card">
            <div className="assistant-card-top"><span className="online-dot" />AI receptionist <span className="mock-tag">{callsOn ? "LIVE" : "OFF"}</span></div>
            <p>{assistantNote}</p>
            <a className="assistant-link" href={routeHref.call}>Talk to the AI <span>↗</span></a>
          </div>
          <div className="user-profile"><Avatar name="Owner" /><span><strong>Your private demo</strong><small>Front desk view</small></span><button className="more-button" aria-label="Demo settings" onClick={() => setPage("Settings")}>···</button></div>
        </div>
      </aside>

      <main className="main-area">
        <CallStatusBar />
        <header className="topbar">
          <div className="breadcrumb"><a className="crumb-home" href={routeHref.call}>CareDesk demo</a><span className="crumb-divider">/</span><span>Harbor Health</span><span className="crumb-divider">/</span><strong>{page}</strong></div>
          <div className="topbar-actions">
            <span className={`demo-indicator ${connection === "fallback" ? "demo-indicator-warning" : ""}`} role="status"><span className="online-dot" />{busy ? "SAVING…" : indicator}</span>
            <Avatar name="Owner" size="small" />
          </div>
        </header>

        <div className="page-content">
          <div className="page-heading-row">
            <div>
              <div className="eyebrow">{new Intl.DateTimeFormat("en", { weekday: "long", month: "long", day: "numeric", timeZone: clinicTimezone }).format(new Date(now)).toUpperCase()} <span>·</span> {timezoneLabel(clinicTimezone)} <span>·</span> {isClinicOpen(clinicTimezone, now) ? "OPEN NOW" : "CLOSED NOW"}</div>
              <h1 id="page-heading" tabIndex={-1}>{pageTitle}</h1>
              <p className="page-subtitle">{pageDescriptions[page]}</p>
            </div>
            <div className="heading-actions">
              <a className="button button-secondary" href={routeHref.call}><span className="button-icon">◉</span> Talk to the AI</a>
              {page === "Waitlist" && <button className="button button-secondary" onClick={() => setShowWaitlist(true)} disabled={!state}><span className="button-icon">↗</span> Join waitlist</button>}
              <button className="button button-primary" onClick={() => setShowBooking(true)} disabled={!state}><span className="button-icon">＋</span> New appointment</button>
            </div>
          </div>

          {connection === "fallback" && <div className="banner banner-safety connection-banner"><span className="banner-icon">!</span><div><strong>Using a browser-only copy</strong><span>{fallbackReason} Changes stay in this browser, and calls are off.</span></div></div>}

          <section className="timezone-strip" aria-label="Market and timezone controls">
            <div className="market-control"><span className="control-icon">◎</span><label htmlFor="market-select">Market</label>
              <select id="market-select" value={market} onChange={(event) => changeMarket(event.target.value as Market)}>
                {marketNames.map((name) => <option key={name}>{name}</option>)}
              </select>
            </div>
            <div className="control-divider" />
            <div className="market-control"><span className="control-icon">◷</span><label htmlFor="clinic-timezone">Clinic schedule</label>
              <select id="clinic-timezone" value={clinicTimezone} onChange={(event) => setClinicTimezone(event.target.value)} title="New bookings and availability use this clinic timezone. Existing appointments keep their stored time.">
                {marketTimezones[market].map((zone) => <option key={zone} value={zone}>{timezoneLabel(zone)}</option>)}
              </select>
            </div>
            <div className="control-divider" />
            <div className="market-control"><span className="control-icon">◉</span><label htmlFor="display-timezone">My display time</label>
              <select id="display-timezone" value={displayTimezone} onChange={(event) => setDisplayTimezone(event.target.value)}>
                {displayZones(viewerZone).map((zone) => <option key={zone} value={zone}>{timezoneLabel(zone)}</option>)}
              </select>
            </div>
            <span className="english-tag">ENGLISH</span>
          </section>

          {!state && <section className="card loading-card" aria-busy="true"><div className="empty-state"><span>◌</span><strong>Loading your demo clinic…</strong><p>Fetching fictional appointments, tasks, and messages.</p></div></section>}
          {state && <>
            {page === "Overview" && <Overview state={state} now={now} clinicTimezone={clinicTimezone} displayTimezone={displayTimezone} callsOn={callsOn} onPage={setPage} onTask={(id) => void perform({ type: "update_task", taskId: id, status: "Done" })} busy={busy} />}
            {page === "Appointments" && <Appointments state={state} now={now} clinicTimezone={clinicTimezone} displayTimezone={displayTimezone} busy={busy} onChange={changeAppointment} onMove={setMoving} onBook={() => setShowBooking(true)} />}
            {page === "Waitlist" && <Waitlist entries={state.waitlist} busy={busy} onCancel={(id) => void perform({ type: "cancel_waitlist", waitlistId: id })} />}
            {page === "Referrals" && <Referrals state={state} clinicTimezone={clinicTimezone} busy={busy} onMark={(id) => void perform({ type: "mark_document_received", documentId: id })} />}
            {page === "Follow-ups" && <FollowUps tasks={state.tasks} clinicTimezone={clinicTimezone} busy={busy} onUpdate={(id, status) => void perform({ type: "update_task", taskId: id, status })} />}
            {page === "Messages" && <Messages state={state} names={names} clinicTimezone={clinicTimezone} busy={busy} onPreference={(patient, optedOut) => void perform({ type: "set_sms_preference", patient, optedOut })} />}
            {page === "FAQs" && <Faqs search={search} onSearch={setSearch} busy={busy} onAskStaff={() => void perform({ type: "create_task", requestType: "faq_review" })} onCreateTask={(requestType) => void perform({ type: "create_task", requestType })} />}
            {page === "Settings" && <Settings market={market} clinicTimezone={clinicTimezone} displayTimezone={displayTimezone} connection={connection} demoCalls={callsOn ? demo.demoCalls : undefined} retentionDays={demo.retentionDays} memoryOnly={demo.memoryOnly} busy={busy} onReset={resetDemo} onDelete={deleteData} />}
          </>}

          <div className="footer-note"><span className="shield-icon">◇</span><span>Fictional demo · Use made-up details only · Not for medical advice or real patient information</span><button onClick={() => setPage("Settings")}>Demo settings</button></div>
        </div>
      </main>

      {showBooking && backend && <SlotModal mode="book" names={names} backend={backend} clinicTimezone={clinicTimezone} onClose={() => setShowBooking(false)}
        onSubmit={async ({ patient, appointmentType, slot, key }) => {
          const ok = await perform({ type: "book_appointment", patient, appointmentType, startAt: slot.startAt, timezone: slot.timezone, provider: slot.provider }, key);
          if (ok) { setShowBooking(false); setPage("Appointments"); }
          return ok;
        }} />}
      {moving && backend && <SlotModal mode="move" names={names} appointment={moving} backend={backend} clinicTimezone={moving.timezone || clinicTimezone} onClose={() => setMoving(null)}
        onSubmit={async ({ slot, key }) => {
          const ok = await perform({ type: "reschedule_appointment", reference: moving.reference, patient: moving.patient, newStartAt: slot.startAt, timezone: slot.timezone, provider: slot.provider }, key);
          if (ok) setMoving(null);
          return ok;
        }} />}
      {showWaitlist && <WaitlistModal names={names} clinicTimezone={clinicTimezone} busy={busy} onClose={() => setShowWaitlist(false)}
        onSubmit={async (action, key) => {
          const ok = await perform(action, key);
          if (ok) { setShowWaitlist(false); setPage("Waitlist"); }
        }} />}
      {toast && <div className={`toast ${toast.tone === "error" ? "toast-error" : ""}`} role={toast.tone === "error" ? "alert" : "status"}><span>{toast.tone === "error" ? "!" : "✓"}</span>{toast.text}</div>}
    </div>
  );
}

function greeting(timeZone: string, now: number) {
  const hour = Number(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone }).format(new Date(now)));
  return hour < 12 ? "Good morning, team" : hour < 17 ? "Good afternoon, team" : "Good evening, team";
}

const activityIcons: Partial<Record<ActivityEvent["action"], [string, string]>> = {
  "Appointment booked": ["✓", "green"], "Appointment confirmed": ["✓", "green"], "Visit marked attended": ["✓", "green"],
  "Appointment rescheduled": ["↻", "blue"], "Appointment cancelled": ["×", "orange"], "Visit marked missed": ["!", "orange"],
  "Document received": ["▤", "green"], "Waitlist opening found": ["↗", "blue"], "Waitlist request added": ["↗", "blue"],
  "Text reminders turned off": ["⊘", "orange"], "Text reminders turned on": ["◌", "green"], "Sample data reset": ["↺", "blue"],
};

function Overview({ state, now, clinicTimezone, displayTimezone, callsOn, onPage, onTask, busy }: {
  state: DemoState; now: number; clinicTimezone: string; displayTimezone: string; callsOn: boolean; onPage: (page: Page) => void;
  onTask: (id: string) => void; busy: boolean;
}) {
  const today = todayKey(clinicTimezone, now);
  const todays = state.appointments.filter((item) => item.status !== "Cancelled" && todayKey(clinicTimezone, Date.parse(item.startAt)) === today);
  const upcoming = state.appointments.filter((item) => activeStatuses.has(item.status) && !isPast(item, now)).sort((a, b) => a.startAt.localeCompare(b.startAt)).slice(0, 4);
  const open = state.tasks.filter((item) => item.status !== "Done").sort((a, b) => a.dueAt.localeCompare(b.dueAt)).slice(0, 3);
  const pendingDocs = state.referrals.filter((item) => item.status !== "Received").length;
  const plannedTexts = state.messages.filter((item) => item.status === "Queued (demo)" || item.status === "Scheduled (demo)").length;
  const awaitingOutcome = state.appointments.filter((item) => needsOutcome(item, now)).length;
  const events = state.events.slice(0, 5);

  return <>
    <div className="stats-grid">
      <StatCard label="Appointments today" value={String(todays.length)} note={`Clinic date · ${formatDateKey(today)}`} icon="▦" color="blue" />
      <StatCard label="Needs follow-up" value={String(state.tasks.filter((item) => item.status !== "Done").length)} note="Requests from callers and staff" icon="◷" color="purple" />
      <StatCard label="Documents pending" value={String(pendingDocs)} note="Sample referrals and forms" icon="▤" color="orange" />
      <StatCard label="Texts planned" value={String(plannedTexts)} note="Simulation only · not sent" icon="◌" color="green" />
    </div>

    {awaitingOutcome > 0 && <button className="banner banner-demo banner-button" onClick={() => onPage("Appointments")}><span className="banner-icon">!</span><div><strong>{awaitingOutcome === 1 ? "1 past visit needs an outcome" : `${awaitingOutcome} past visits need an outcome`}</strong><span>Mark each one attended or missed. A missed visit creates a rebooking follow-up.</span></div><span className="text-button">Review →</span></button>}

    <div className="content-grid overview-grid">
      <section className="card appointments-card">
        <div className="card-heading"><div><h2>Upcoming appointments</h2><p>Next visits on the demo schedule</p></div><button className="text-button" onClick={() => onPage("Appointments")}>View schedule <span>→</span></button></div>
        <div className="appointment-list">
          {upcoming.map((appointment) => <AppointmentRow key={appointment.id} appointment={appointment} clinicTimezone={clinicTimezone} displayTimezone={displayTimezone} compact />)}
          {upcoming.length === 0 && <EmptyState title="No upcoming appointments" text="Book a sample appointment to fill the schedule." />}
        </div>
        <button className="list-footer-button" onClick={() => onPage("Appointments")}>Open appointment list <span>→</span></button>
      </section>

      <section className="card tasks-card">
        <div className="card-heading"><div><h2>Needs attention</h2><p>Front desk follow-ups</p></div><button className="small-circle-button" onClick={() => onPage("Follow-ups")} aria-label="View all follow-ups">↗</button></div>
        <div className="attention-list">
          {open.map((task) => <div className="attention-item" key={task.id}><span className={`attention-mark mark-${taskTone(task.priority)}`}>{task.priority === "Today" ? "!" : "·"}</span><div className="attention-copy"><div className="attention-title">{task.title}</div><div className="attention-detail">{task.patient} · {Date.parse(task.dueAt) < now ? "overdue since" : "due"} {formatShort(task.dueAt, clinicTimezone)}</div></div><button className="check-button" disabled={busy} onClick={() => onTask(task.id)} aria-label={`Complete ${task.title}`}>✓</button></div>)}
          {open.length === 0 && <EmptyState title="All caught up" text="New staff requests will appear here." />}
        </div>
        <button className="list-footer-button" onClick={() => onPage("Follow-ups")}>View follow-up queue <span>→</span></button>
      </section>
    </div>

    <div className="content-grid lower-grid">
      <section className="card activity-card">
        <div className="card-heading"><div><h2>Recent front desk activity</h2><p>Changes from the console, the voice assistant, and automation</p></div><button className="text-button" onClick={() => onPage("Messages")}>Message log <span>→</span></button></div>
        <div className="activity-list">
          {events.map((event) => {
            const [icon, color] = activityIcons[event.action] ?? ["•", "blue"];
            return <Activity key={event.id} icon={icon} color={color} title={event.action} detail={[event.patient, event.reference, event.channel].filter(Boolean).join(" · ")} time={formatShort(event.at, displayTimezone)} fromCall={fromRecentCall(event, now)} />;
          })}
          {events.length === 0 && <EmptyState title="No activity yet" text="Bookings, changes, and staff requests will appear here." />}
        </div>
      </section>
      <section className="card assistant-summary-card">
        <div className="summary-top"><div className="summary-icon">✦</div><div><span className="summary-overline">AI FRONT DESK</span><h2>Ava answers the phone.</h2></div><StatusPill tone={callsOn ? "green" : "blue"}>{callsOn ? "Live calls on" : "Calls off"}</StatusPill></div>
        <p>Call Ava, the AI receptionist, by phone or in your browser. She answers approved admin questions, books and changes visits, and routes requests to staff — and her changes appear here.</p>
        <div className="summary-safety"><span>✓</span><span>Clinical questions go to a person. Calls happen only when you ask for one; texts are always simulated.</span></div>
        <a className="button button-secondary full-button" href={routeHref.call}>Talk to the AI <span>→</span></a>
      </section>
    </div>
  </>;
}

function StatCard({ label, value, note, icon, color }: { label: string; value: string; note: string; icon: string; color: string }) {
  return <div className="stat-card"><div className={`stat-icon stat-${color}`}>{icon}</div><div className="stat-label">{label}</div><div className="stat-value">{value}</div><div className="stat-note">{note}</div></div>;
}

function Activity({ icon, color, title, detail, time, fromCall = false }: { icon: string; color: string; title: string; detail: string; time: string; fromCall?: boolean }) {
  return <div className="activity-item"><span className={`activity-icon activity-${color}`}>{icon}</span><div className="activity-copy"><strong>{title}{fromCall && <span className="from-call-tag">From your call</span>}</strong><span>{detail}</span></div><span className="activity-time">{time}</span></div>;
}

function AppointmentRow({ appointment, clinicTimezone, displayTimezone, compact = false }: { appointment: Appointment; clinicTimezone: string; displayTimezone: string; compact?: boolean }) {
  return <div className={`appointment-row ${compact ? "appointment-row-compact" : ""}`}>
    <div className="appointment-date"><div className="date-badge"><span>{formatDate(appointment.startAt, clinicTimezone).split(" ")[0].toUpperCase()}</span><strong>{new Intl.DateTimeFormat("en", { day: "2-digit", timeZone: clinicTimezone }).format(new Date(appointment.startAt))}</strong></div></div>
    <Avatar name={appointment.patient} size="small" />
    <div className="appointment-person"><strong>{appointment.patient}</strong><span>{appointment.type} · {appointment.reference}</span></div>
    <div className="appointment-when"><strong>{formatTime(appointment.startAt, clinicTimezone)} <small>clinic</small></strong><span>{formatTime(appointment.startAt, displayTimezone)} your time</span></div>
    {!compact && <><div className="appointment-provider"><strong>{appointment.provider}</strong><span>{appointment.location}</span></div><StatusPill tone={appointmentTone(appointment.status)}>{appointment.status}</StatusPill></>}
  </div>;
}

function Appointments({ state, now, clinicTimezone, displayTimezone, busy, onChange, onMove, onBook }: {
  state: DemoState; now: number; clinicTimezone: string; displayTimezone: string; busy: boolean;
  onChange: (appointment: Appointment, action: "cancel" | "confirm" | "attended" | "missed") => void; onMove: (appointment: Appointment) => void; onBook: () => void;
}) {
  const [filter, setFilter] = useState("Upcoming");
  const [query, setQuery] = useState("");
  const appointments = useMemo(() => [...state.appointments].sort((a, b) => a.startAt.localeCompare(b.startAt)), [state.appointments]);
  const needle = query.trim().toLowerCase();
  const visible = appointments.filter((item) => {
    if (needle && !`${item.patient} ${item.reference} ${item.type}`.toLowerCase().includes(needle)) return false;
    if (filter === "Upcoming") return activeStatuses.has(item.status) && !isPast(item, now);
    if (filter === "Needs outcome") return needsOutcome(item, now);
    return filter === "All appointments" || item.status === filter;
  });
  const history = state.events.filter((event) => event.reference && ["Appointment booked", "Appointment rescheduled", "Appointment cancelled", "Appointment confirmed", "Visit marked attended", "Visit marked missed"].includes(event.action)).slice(0, 8);
  return <div className="stack-layout"><section className="card full-card">
    <div className="card-heading card-heading-wide"><div><h2>Appointment schedule</h2><p>Bookings use real-time sample availability in the clinic timezone.</p></div><div className="inline-actions">
      <div className="search-wrap search-compact"><span>⌕</span><input aria-label="Search appointments" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Name or DEMO reference" /></div>
      <select className="filter-select" aria-label="Filter appointments" value={filter} onChange={(event) => setFilter(event.target.value)}><option>Upcoming</option><option>Needs outcome</option><option>All appointments</option><option>Confirmed</option><option>Needs confirmation</option><option>Completed</option><option>Missed</option><option>Cancelled</option></select>
      <button className="button button-primary button-small" onClick={onBook}>＋ Book appointment</button></div></div>
    <div className="table-head appointment-table-head"><span>DATE</span><span>PATIENT</span><span>CLINIC TIME / YOUR TIME</span><span>PROVIDER</span><span>STATUS</span><span>ACTIONS</span></div>
    <div className="table-list">{visible.map((appointment) => {
      const zone = appointment.timezone || clinicTimezone;
      const future = !isPast(appointment, now);
      return <div className="table-row appointment-table-row" key={appointment.id}>
        <div className="date-stack"><strong>{formatDate(appointment.startAt, zone)}</strong><span>{formatTime(appointment.startAt, zone)} clinic</span></div>
        <div className="patient-cell"><Avatar name={appointment.patient} size="small" /><div><strong>{appointment.patient}</strong><span>{appointment.reference} · {appointment.type}</span></div></div>
        <div className="dual-time"><strong>{formatTime(appointment.startAt, zone)}</strong><span>{formatTime(appointment.startAt, displayTimezone)} viewer</span></div>
        <div className="provider-cell"><strong>{appointment.provider}</strong><span>{appointment.location}</span></div>
        <StatusPill tone={appointmentTone(appointment.status)}>{appointment.status}</StatusPill>
        <div className="row-actions">
          {future && appointment.status === "Needs confirmation" && <button disabled={busy} onClick={() => onChange(appointment, "confirm")}>Confirm</button>}
          {future && activeStatuses.has(appointment.status) && <><button disabled={busy} onClick={() => onMove(appointment)}>Move</button><button className="action-danger" disabled={busy} onClick={() => onChange(appointment, "cancel")}>Cancel</button></>}
          {needsOutcome(appointment, now) && <><button disabled={busy} onClick={() => onChange(appointment, "attended")}>Attended</button><button className="action-danger" disabled={busy} onClick={() => onChange(appointment, "missed")}>No-show</button></>}
        </div>
      </div>;
    })}{visible.length === 0 && <EmptyState title="No appointments here" text="Try a different filter or book a sample appointment." />}</div>
    <div className="table-foot"><span>{visible.length} of {appointments.length} sample appointments</span><span>Stored as UTC · shown in clinic and viewer time</span></div>
  </section>
  <section className="card full-card"><div className="card-heading"><div><h2>Change history</h2><p>Who changed which sample booking, and through which channel.</p></div></div>
    <div className="activity-list history-list">{history.map((event) => <Activity key={event.id} icon={activityIcons[event.action]?.[0] ?? "•"} color={activityIcons[event.action]?.[1] ?? "blue"} title={`${event.action} · ${event.reference}`} detail={`${event.patient ?? ""} · ${event.channel}`} time={formatShort(event.at, displayTimezone)} fromCall={fromRecentCall(event, now)} />)}
      {history.length === 0 && <EmptyState title="No changes recorded yet" text="Bookings, moves, cancellations, and visit outcomes appear here." />}</div>
  </section></div>;
}

function Waitlist({ entries, busy, onCancel }: { entries: DemoState["waitlist"]; busy: boolean; onCancel: (id: string) => void }) {
  const active = entries.filter((item) => item.status === "Waiting" || item.status === "Opening found");
  return <div className="stack-layout">
    <div className="banner banner-demo"><span className="banner-icon">↗</span><div><strong>Sample waitlist</strong><span>When a matching appointment is cancelled or moved, the front desk gets a follow-up task. The demo never books or texts someone automatically.</span></div><StatusPill tone="blue">No messages sent</StatusPill></div>
    <section className="card full-card"><div className="card-heading"><div><h2>Waitlist requests</h2><p>Requests use fictional patients and a preferred clinic date.</p></div><StatusPill tone="amber">{`${active.length} active`}</StatusPill></div>
      <div className="waitlist-list">{entries.map((item) => <article className="waitlist-entry" key={item.id}>
        <Avatar name={item.patient} size="small" />
        <div className="waitlist-person"><strong>{item.patient}</strong><span>{item.appointmentType}</span></div>
        <div className="waitlist-date"><span>Preferred date</span><strong>{formatDateKey(item.preferredDate)}</strong><small>{timezoneLabel(item.timezone)}</small></div>
        <StatusPill tone={item.status === "Opening found" || item.status === "Booked" ? "green" : item.status === "Cancelled" ? "neutral" : "amber"}>{item.status}</StatusPill>
        {item.status === "Waiting" || item.status === "Opening found" ? <button className="row-text-action" disabled={busy} onClick={() => onCancel(item.id)}>Cancel request</button> : <span className="waitlist-date">Added {formatDateTime(item.createdAt, item.timezone)}</span>}
      </article>)}{entries.length === 0 && <EmptyState title="No waitlist requests" text="Add a fictional request to try the cancellation workflow." />}</div>
      <div className="storage-note"><span>i</span><p>The demo stores no phone numbers or contact details. Staff must confirm a matching opening with the fictional sample patient.</p></div>
    </section>
  </div>;
}

function Referrals({ state, clinicTimezone, busy, onMark }: { state: DemoState; clinicTimezone: string; busy: boolean; onMark: (id: string) => void }) {
  const next = state.referrals.find((item) => item.status !== "Received");
  return <div className="stack-layout">
    <div className="banner banner-safety"><span className="banner-icon">◇</span><div><strong>Sample files only</strong><span>Document uploads are simulated here. Never add a real referral or medical record to this demo.</span></div></div>
    <section className="card full-card"><div className="card-heading"><div><h2>Referral & document checklist</h2><p>Track what's needed before each sample visit.</p></div><button className="button button-secondary button-small" disabled={!next || busy} onClick={() => { if (next) onMark(next.id); }}>＋ Mark next sample received</button></div>
      <div className="document-list">{state.referrals.map((item) => <div className="document-row" key={item.id}><div className="file-icon">▤</div><div className="document-main"><strong>{item.document}</strong><span>{item.patient} · {item.reference} · {item.appointment}</span></div><div className="document-date">{item.receivedAt ? `Received ${formatDateTime(item.receivedAt, clinicTimezone)}` : "Waiting for sample"}</div><StatusPill tone={item.status === "Received" ? "green" : item.status === "In review" ? "blue" : "amber"}>{item.status}</StatusPill><button className="row-text-action" disabled={item.status === "Received" || busy} onClick={() => onMark(item.id)}>{item.status === "Received" ? "Complete" : item.status === "In review" ? "Mark reviewed" : "Mark sample received"}</button></div>)}
        {state.referrals.length === 0 && <EmptyState title="No sample documents" text="Booking a new patient visit or consultation adds a referral checklist item." />}</div>
      <div className="storage-note"><span>i</span><p>The demo stores sample document names and statuses with its demo data. It never uploads file contents.</p></div>
    </section>
    <section className="card followup-banner-card"><div className="calendar-illustration">◷</div><div><h3>Automatic follow-up, without the chasing</h3><p>New patient visits and consultations get one sample follow-up 48 hours after booking while the referral is missing, inside quiet hours and only if the visit hasn't happened yet. Marking the sample received cancels it. No text is sent.</p></div><StatusPill tone="blue">Planned</StatusPill></section>
  </div>;
}

function FollowUps({ tasks, clinicTimezone, busy, onUpdate }: { tasks: FollowUpTask[]; clinicTimezone: string; busy: boolean; onUpdate: (id: string, status: FollowUpTask["status"]) => void }) {
  const sorted = [...tasks].sort((a, b) => (a.status === "Done" ? 1 : 0) - (b.status === "Done" ? 1 : 0) || a.dueAt.localeCompare(b.dueAt));
  return <section className="card full-card"><div className="card-heading"><div><h2>Staff follow-up queue</h2><p>Requests that need a person to close the loop. Caller wording is never stored.</p></div><StatusPill tone="amber">{`${tasks.filter((task) => task.status !== "Done").length} open`}</StatusPill></div>
    <div className="task-list">{sorted.map((task) => <div className={`task-row ${task.status === "Done" ? "task-complete" : ""}`} key={task.id}><span className={`task-priority priority-${taskTone(task.priority)}`}>{task.priority === "Urgent" ? "!" : "◷"}</span><div className="task-body"><div className="task-title-line"><strong>{task.title}</strong><StatusPill tone={task.status === "Done" ? "green" : taskTone(task.priority)}>{task.status === "Done" ? "Done" : task.priority}</StatusPill></div><span>{task.patient}{task.appointmentReference ? ` · ${task.appointmentReference}` : ""} · {task.detail}</span></div><div className="task-due">Due <strong>{formatDateTime(task.dueAt, clinicTimezone)}</strong></div><select aria-label={`Update ${task.title}`} value={task.status} disabled={busy} onChange={(event) => onUpdate(task.id, event.target.value as FollowUpTask["status"])}><option>Open</option><option>In progress</option><option>Done</option></select></div>)}
      {tasks.length === 0 && <EmptyState title="No follow-ups" text="Call the AI and ask for a callback to add a staff request." />}</div>
  </section>;
}

function messageTone(status: string): "green" | "neutral" | "amber" | "red" {
  if (status === "Delivered (demo)") return "green";
  if (status === "Suppressed (opt-out)") return "red";
  if (status === "Opt-out" || status === "Cancelled (demo)") return "neutral";
  return "amber";
}

function Messages({ state, names, clinicTimezone, busy, onPreference }: { state: DemoState; names: string[]; clinicTimezone: string; busy: boolean; onPreference: (patient: string, optedOut: boolean) => void }) {
  return <div className="stack-layout"><div className="banner banner-demo"><span className="banner-icon">◌</span><div><strong>SMS simulation only</strong><span>These are sample messages saved with demo data. The app does not send real texts. Simulated texts wait for 9 AM–8 PM clinic time.</span></div><StatusPill tone="blue">Live texting off</StatusPill></div>
    <section className="card full-card"><div className="card-heading"><div><h2>Text preferences</h2><p>Simulate a patient replying STOP or START. Opted-out patients get no reminders.</p></div></div>
      <div className="preference-list">{names.map((patient) => {
        const optedOut = isOptedOut(state, patient);
        return <div className="preference-row" key={patient}><Avatar name={patient} size="small" /><strong>{patient}</strong><StatusPill tone={optedOut ? "red" : "green"}>{optedOut ? "Opted out" : "Texts allowed"}</StatusPill><button className="row-text-action" disabled={busy} onClick={() => onPreference(patient, !optedOut)}>{optedOut ? "Simulate START" : "Simulate STOP"}</button></div>;
      })}</div>
    </section>
    <section className="card full-card"><div className="card-heading"><div><h2>Message activity</h2><p>Booking confirmations, reminders, follow-ups, and opt-outs.</p></div><span className="subtle-label">{state.messages.length} records</span></div>
      <div className="message-list">{state.messages.map((message) => {
        const muted = message.status === "Opt-out" || message.status === "Cancelled (demo)" || message.status === "Suppressed (opt-out)";
        return <article className="message-row" key={message.id}><div className="message-leading"><span className={`message-icon ${muted ? "message-muted" : ""}`}>{muted ? "⊘" : "↗"}</span></div><div className="message-content"><div className="message-title"><strong>{message.purpose}</strong><span>{message.recipient}</span></div><p>{message.body}</p><small>{message.scheduledFor ? `${message.status === "Delivered (demo)" ? "Due" : "Scheduled for"} ${formatDateTime(message.scheduledFor, clinicTimezone)}` : `Created ${formatDateTime(message.sentAt, clinicTimezone)}`} · {message.status}</small></div><StatusPill tone={messageTone(message.status)}>{message.status}</StatusPill></article>;
      })}{state.messages.length === 0 && <EmptyState title="No messages" text="Booking a sample appointment creates simulated texts." />}</div>
    </section></div>;
}

function Faqs({ search, onSearch, busy, onAskStaff, onCreateTask }: { search: string; onSearch: (value: string) => void; busy: boolean; onAskStaff: () => void; onCreateTask: (requestType: RequestType) => void }) {
  const categories = [...new Set(faqEntries.map((entry) => entry.category))];
  const [category, setCategory] = useState("All topics");
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<FaqSearchResult | null>(null);
  const needle = search.toLowerCase();
  const visible = faqEntries.filter((entry) => (category === "All topics" || entry.category === category) && `${entry.question} ${entry.answer} ${entry.category}`.toLowerCase().includes(needle));
  return <div className="stack-layout">
    <section className="card full-card faq-tester"><div className="card-heading"><div><h2>Test a caller question</h2><p>Runs the same approved-answer lookup the voice assistant uses. Nothing you type is saved.</p></div><StatusPill tone="blue">Same rules as voice</StatusPill></div>
      <form className="faq-tester-form" onSubmit={(event: FormEvent) => { event.preventDefault(); if (question.trim()) setAnswer(searchApprovedFaq(question)); }}>
        <div className="search-wrap"><span>?</span><input aria-label="Caller question" value={question} maxLength={200} onChange={(event) => { setQuestion(event.target.value); setAnswer(null); }} placeholder="For example: Is there parking? or Can you refill my prescription?" /></div>
        <button className="button button-primary button-small" type="submit" disabled={!question.trim()}>Check answer</button>
      </form>
      {answer && <div className={`faq-result ${answer.emergency ? "faq-result-alert" : answer.handoff ? "faq-result-handoff" : ""}`} role="status">
        <StatusPill tone={answer.emergency ? "red" : answer.approved && !answer.handoff ? "green" : "amber"}>{answer.emergency ? "Emergency message" : !answer.approved ? "No approved answer" : answer.handoff ? "Approved answer + staff hand-off" : "Approved answer"}</StatusPill>
        <p>{answer.answer}</p>
        {answer.suggestedRequest && answer.suggestedRequest !== "faq_review" && <button className="text-button" disabled={busy} onClick={() => onCreateTask(answer.suggestedRequest!)}>Create “{requestTemplates[answer.suggestedRequest].title}” task <span>→</span></button>}
      </div>}
    </section>
    <div className="faq-tools"><div className="search-wrap"><span>⌕</span><input aria-label="Search FAQs" value={search} onChange={(event) => onSearch(event.target.value)} placeholder="Search common questions..." /></div><select aria-label="FAQ topic" value={category} onChange={(event) => setCategory(event.target.value)}><option>All topics</option>{categories.map((item) => <option key={item}>{item}</option>)}</select><StatusPill tone="green">English · reviewed</StatusPill></div>
    <div className="faq-grid">{visible.map((entry) => <article className="card faq-card" key={entry.id}><div className="faq-card-top"><span className="faq-category">{entry.category}</span><span className="faq-status">✓ Approved</span></div><h3>{entry.question}</h3><p>{entry.answer}</p><div className="faq-card-footer"><span>{entry.updated}</span><button disabled={busy} onClick={onAskStaff}>Ask staff to review ↗</button></div></article>)}{visible.length === 0 && <EmptyState title="No matching questions" text="Try another search term." />}</div>
    <div className="banner banner-safety"><span className="banner-icon">◇</span><div><strong>Answers stay in their lane</strong><span>Medical, symptom, and medication questions are handed to clinic staff. Refill requests are routed to staff without advice. The assistant does not guess when an approved answer is missing.</span></div></div>
  </div>;
}

function Settings({ market, clinicTimezone, displayTimezone, connection, demoCalls, retentionDays, memoryOnly, busy, onReset, onDelete }: {
  market: Market; clinicTimezone: string; displayTimezone: string; connection: Connection; demoCalls?: DemoCallsInfo; retentionDays: number; memoryOnly: boolean;
  busy: boolean; onReset: () => void; onDelete: () => void;
}) {
  const [showBoundaries, setShowBoundaries] = useState(false);
  const cloud = connection === "cloud";
  const callsOn = Boolean(demoCalls?.enabled);
  const webOn = callsOn && demoCalls?.web?.enabled !== false;
  const dataLine = cloud
    ? (memoryOnly ? "Your private demo · ends when this tab closes" : `Your private demo · deleted ${retentionDays} days after last use`)
    : "This browser only";
  return <div className="settings-grid"><section className="card settings-card"><div className="card-heading"><div><h2>Clinic profile</h2><p>Fictional settings for this demo.</p></div><StatusPill tone="blue">Demo only</StatusPill></div><div className="setting-line"><span>Market</span><strong>{market}</strong></div><div className="setting-line"><span>Clinic scheduling timezone</span><strong>{timezoneLabel(clinicTimezone)}</strong></div><div className="setting-line"><span>My display timezone</span><strong>{timezoneLabel(displayTimezone)}</strong></div><div className="setting-line"><span>Language</span><strong>English</strong></div><div className="setting-line"><span>Opening hours</span><strong>Mon–Fri · 8 AM–5 PM</strong></div><div className="setting-line"><span>Reminder plan</span><strong>Confirmation · 24h · 48h docs follow-up</strong></div><div className="setting-line"><span>Text quiet hours</span><strong>Outside 9 AM–8 PM clinic time</strong></div><div className="setting-line"><span>Data</span><strong>{dataLine}</strong></div></section>
      <section className="card settings-card"><div className="card-heading"><div><h2>Phone & messaging</h2><p>{callsOn ? "Visitors can call Ava, the AI receptionist, by phone or in the browser. Texts stay simulated." : "Live calls are off for this demo right now. Texts are always simulated."}</p></div><span className="mock-tag">{callsOn ? "LIVE CALLS" : "CALLS OFF"}</span></div><div className="integration-item"><span className="integration-logo retell-logo">R</span><div><strong>Phone calls</strong><small>{callsOn ? `Retell · calls from ${demoCalls?.fromNumber} · up to ${demoCalls?.maxMinutes} min · US & India` : "Retell agent · calls are not switched on"}</small></div><StatusPill tone={callsOn ? "green" : "blue"}>{callsOn ? "On" : "Off"}</StatusPill></div><div className="integration-item"><span className="integration-logo retell-logo">◉</span><div><strong>Browser calls</strong><small>{webOn ? "Talk to Ava with your microphone, from any country" : "Switched off"}</small></div><StatusPill tone={webOn ? "green" : "blue"}>{webOn ? "On" : "Off"}</StatusPill></div><div className="integration-item"><span className="integration-logo sms-logo">↗</span><div><strong>SMS reminders</strong><small>Provider chosen after the first market pilot</small></div><StatusPill tone="blue">Not connected</StatusPill></div><div className="allowlist-box"><span>◉</span><div><strong>Call limits</strong><small>{callsOn ? `At most ${demoCalls?.maxCallsPerDay} demo calls a day across all visitors (phone and browser together), 3 per connection in any 24 hours, with a cooldown per phone number, after consent and a security check.` : "No calls are placed and no texts are sent."}</small></div></div><a className="text-button settings-call-link" href={routeHref.call}>Talk to the AI <span>→</span></a></section>
      <section className="card settings-card privacy-card"><div className="privacy-icon">◇</div><div><h2>Keep the demo safe</h2><p>Use made-up names and details only. Do not enter real health details or upload patient records. Clinical requests go to a person.</p><button className="text-button" onClick={() => setShowBoundaries((value) => !value)} aria-expanded={showBoundaries}>{showBoundaries ? "Hide demo boundaries" : "View demo boundaries"} <span>→</span></button>{showBoundaries && <ul className="boundary-list"><li>This is a fictional front desk demo. It does not provide medical care, triage, or advice.</li><li>Calls happen only when you ask for one. Texts are never sent; reminders are simulated records.</li><li>{cloud ? `Your demo is private to this browser: names come from the sample patients or from your own calls, and nobody else sees them. It is deleted ${retentionDays} days after last use.` : "This copy lives only in this browser. Names come from the sample patients."} Caller wording is never stored.</li><li>Your phone number is never stored. Retell processes call audio; this demo is set to keep no recordings or transcripts.</li><li>Not represented as HIPAA, GDPR, or UAE health-data compliant.</li></ul>}</div></section>
      <section className="card settings-card reset-card"><div><h2>Reset my demo</h2><p>{cloud ? "Put your private demo back to the original sample clinic. Names and bookings from your calls are removed." : "Put the copy in this browser back to the original sample clinic."}</p></div><button className="button button-secondary" disabled={busy} onClick={onReset}>Reset my demo</button></section>
      <section className="card settings-card reset-card"><div><h2>Delete my demo data</h2><p>{cloud ? "Remove your private demo now instead of waiting for the automatic deletion. A fresh sample clinic starts." : "Remove the demo copy kept in this browser."}</p></div><button className="button button-secondary button-danger" disabled={busy || connection === "connecting"} onClick={onDelete}>Delete my demo data</button></section>
    </div>;
}

function Modal({ labelledBy, onClose, children }: { labelledBy: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="modal-card" role="dialog" aria-modal="true" aria-labelledby={labelledBy}>{children}</section></div>;
}

interface SlotSubmission { patient: string; appointmentType: string; slot: AvailabilitySlot; key: string }

function SlotModal({ mode, names, appointment, backend, clinicTimezone, onClose, onSubmit }: {
  mode: "book" | "move"; names: string[]; appointment?: Appointment; backend: DemoBackend; clinicTimezone: string;
  onClose: () => void; onSubmit: (submission: SlotSubmission) => Promise<boolean>;
}) {
  const [patient, setPatient] = useState(appointment?.patient ?? "");
  const [appointmentType, setAppointmentType] = useState<string>(appointment?.type ?? appointmentTypes[0]);
  const [date, setDate] = useState(() => nextOpenDateKey(clinicTimezone));
  const [slots, setSlots] = useState<AvailabilitySlot[] | null>(null);
  const [selected, setSelected] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [reload, setReload] = useState(0);
  // One key per distinct choice: pressing confirm again after a network error reuses it (no second booking),
  // while changing the patient, type, or time starts a new request.
  const key = useMemo(() => newIdempotencyKey(), [patient, appointmentType, selected]);

  useEffect(() => {
    let active = true;
    setSlots(null); setSelected(""); setError("");
    backend.availability({ date, appointmentType, timezone: clinicTimezone, ignoreAppointmentId: appointment?.id })
      .then((result) => { if (active) setSlots(result); })
      .catch((reason) => { if (active) { setSlots([]); setError(reason instanceof ApiRequestError ? reason.message : "Availability could not be loaded."); } });
    return () => { active = false; };
  }, [backend, date, appointmentType, clinicTimezone, appointment?.id, reload]);

  const slot = slots?.find((item) => item.startAt === selected);
  const title = mode === "book" ? "Book an appointment" : `Move ${appointment?.reference}`;
  return <Modal labelledBy="slot-title" onClose={onClose}>
    <div className="modal-header"><div><span className="modal-kicker">{mode === "book" ? "SAMPLE SCHEDULE" : "RESCHEDULE"}</span><h2 id="slot-title">{title}</h2><p>{mode === "book" ? "Pick a sample patient (or a name from your calls) and an open time." : `${appointment?.patient} · ${appointment?.type}. Currently ${appointment ? formatDateTime(appointment.startAt, clinicTimezone) : ""}.`}</p></div><button className="modal-close" onClick={onClose} aria-label="Close">×</button></div>
    <form onSubmit={async (event) => {
      event.preventDefault();
      if (!slot || !patient) return;
      setSubmitting(true);
      const ok = await onSubmit({ patient, appointmentType, slot, key });
      setSubmitting(false);
      if (!ok) setReload((value) => value + 1);
    }}>
      {mode === "book" && <>
        <label className="form-label">Patient<select name="patient" required value={patient} onChange={(event) => setPatient(event.target.value)}><option value="" disabled>Choose a patient</option><PatientOptions names={names} /></select></label>
        <label className="form-label">Appointment type<select name="appointmentType" value={appointmentType} onChange={(event) => setAppointmentType(event.target.value)}>{appointmentTypes.map((type) => <option key={type}>{type}</option>)}</select></label>
      </>}
      <label className="form-label">Date (clinic time)<input type="date" name="date" required min={todayKey(clinicTimezone)} value={date} onChange={(event) => { if (event.target.value) setDate(event.target.value); }} /></label>
      <fieldset className="slot-fieldset"><legend className="form-label">Open sample times</legend>
        {slots === null && <p className="slot-note">Checking availability…</p>}
        {slots && slots.length === 0 && <p className="slot-note">{error || "No open sample times on this date. The clinic is open Monday to Friday, 8 AM to 5 PM. Try another date or the waitlist."}</p>}
        {slots && slots.length > 0 && <div className="slot-grid">{slots.map((item) => <button type="button" key={item.startAt} className={`slot-option ${selected === item.startAt ? "slot-selected" : ""}`} aria-pressed={selected === item.startAt} onClick={() => setSelected(item.startAt)}><strong>{formatTime(item.startAt, clinicTimezone)}</strong><small>{item.provider.replace("Dr. ", "Dr ")}</small></button>)}</div>}
      </fieldset>
      <div className="timezone-hint"><span>◷</span> Clinic time: <strong>{timezoneLabel(clinicTimezone)}</strong></div>
      <div className="modal-disclaimer">{mode === "book" ? "This adds a sample appointment and simulated texts once the schedule confirms it. No real text is sent." : "The new time is saved only if the schedule confirms it is still free. No real text is sent."}</div>
      <div className="modal-actions"><button type="button" className="button button-secondary" onClick={onClose}>Back</button><button type="submit" className="button button-primary" disabled={!slot || !patient || submitting}>{submitting ? "Saving…" : mode === "book" ? "Confirm sample booking" : "Move appointment"} <span>→</span></button></div>
    </form>
  </Modal>;
}

function WaitlistModal({ names, clinicTimezone, busy, onClose, onSubmit }: { names: string[]; clinicTimezone: string; busy: boolean; onClose: () => void; onSubmit: (action: DemoAction, key: string) => Promise<void> }) {
  // Same request, same key; any edit to the form starts a new request.
  const keyRef = useRef(newIdempotencyKey());
  return <Modal labelledBy="waitlist-title" onClose={onClose}><div className="modal-header"><div><span className="modal-kicker">SAMPLE WAITLIST</span><h2 id="waitlist-title">Add a waitlist request</h2><p>Pick a sample patient (or a name from your calls) and a preferred date.</p></div><button className="modal-close" onClick={onClose} aria-label="Close">×</button></div><form onChange={() => { keyRef.current = newIdempotencyKey(); }} onSubmit={(event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void onSubmit({ type: "join_waitlist", patient: String(form.get("patient") || ""), appointmentType: String(form.get("appointmentType") || ""), preferredDate: String(form.get("preferredDate") || ""), timezone: clinicTimezone }, keyRef.current);
  }}>
    <label className="form-label">Patient<select name="patient" required defaultValue=""><option value="" disabled>Choose a patient</option><PatientOptions names={names} /></select></label>
    <label className="form-label">Appointment type<select name="appointmentType">{appointmentTypes.map((type) => <option key={type}>{type}</option>)}</select></label>
    <label className="form-label">Preferred date (clinic time)<input type="date" name="preferredDate" required min={todayKey(clinicTimezone)} defaultValue={nextOpenDateKey(clinicTimezone)} /></label>
    <div className="timezone-hint"><span>◷</span> Preferred date uses clinic time: <strong>{timezoneLabel(clinicTimezone)}</strong></div>
    <div className="modal-disclaimer">This creates a sample request. A staff task is made when a matching opening appears; no text is sent.</div>
    <div className="modal-actions"><button type="button" className="button button-secondary" onClick={onClose}>Back</button><button type="submit" className="button button-primary" disabled={busy}>Add to sample waitlist <span>→</span></button></div>
  </form></Modal>;
}

/** Sample patients first, then names the visitor gave on their own calls. */
function PatientOptions({ names }: { names: string[] }) {
  const samples = names.slice(0, 5);
  const callers = names.slice(5);
  if (callers.length === 0) return <>{samples.map((name) => <option key={name}>{name}</option>)}</>;
  return <>
    <optgroup label="Sample patients">{samples.map((name) => <option key={name}>{name}</option>)}</optgroup>
    <optgroup label="From your calls">{callers.map((name) => <option key={name}>{name}</option>)}</optgroup>
  </>;
}

function EmptyState({ title, text }: { title: string; text: string }) {
  return <div className="empty-state"><span>⌕</span><strong>{title}</strong><p>{text}</p></div>;
}

export default App;
