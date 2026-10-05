import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { faqEntries } from "./lib/demoData";
import { apiBaseUrl, getRemoteDemoState, putRemoteDemoState, RemoteStateConflict } from "./lib/api";
import { loadDemoState, resetDemoState, saveDemoState } from "./lib/store";
import { addLocalDays, allTimezones, defaultLocalDateTime, formatDate, formatDateTime, formatTime, localDateTimeToUtc, marketTimezones, timezoneLabel } from "./lib/timezone";
import type { Appointment, DemoState, FollowUpTask, Market } from "./types";

type Page = "Overview" | "Appointments" | "Waitlist" | "Referrals" | "Follow-ups" | "Messages" | "FAQs" | "Settings";
type CallIntent = "appointment" | "waitlist" | "faq" | "callback" | "refill" | "records" | "billing" | "documents";

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
const demoPatients = ["Maya Patel", "Jordan Lee", "Samira Khan", "Alex Morgan", "Taylor Reed"];
const appointmentTypes = ["New patient visit", "Follow-up visit", "Consultation", "Administrative call"];
const serviceDurations: Record<string, number> = { "New patient visit": 60, "Follow-up visit": 30, Consultation: 45, "Administrative call": 15 };
const demoProviders = [
  { name: "Dr. Avery Chen", location: "Main clinic" },
  { name: "Dr. Noah Rivera", location: "North clinic" },
];

function id(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
}

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

function appointmentTone(status: Appointment["status"]): "green" | "amber" | "red" {
  if (status === "Confirmed") return "green";
  if (status === "Cancelled") return "red";
  return "amber";
}

function taskTone(priority: FollowUpTask["priority"]): "amber" | "red" | "neutral" {
  if (priority === "Urgent") return "red";
  if (priority === "Today") return "amber";
  return "neutral";
}

function isDemoSlotOpen(startAt: string, appointmentType: string, timezone: string) {
  const duration = serviceDurations[appointmentType];
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(startAt));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const hour = Number(values.hour);
  const minute = Number(values.minute);
  return Boolean(duration && ["Mon", "Tue", "Wed", "Thu", "Fri"].includes(values.weekday)
    && minute % 30 === 0 && hour * 60 + minute >= 8 * 60
    && hour * 60 + minute + duration <= 17 * 60 && Date.parse(startAt) > Date.now());
}

function providerForSlot(appointments: Appointment[], startAt: string, appointmentType: string, ignoreId?: string) {
  const start = Date.parse(startAt);
  const end = start + (serviceDurations[appointmentType] || 30) * 60_000;
  return demoProviders.find((provider) => !appointments.some((item) => {
    if (item.id === ignoreId || item.status === "Cancelled" || item.provider !== provider.name) return false;
    const itemStart = Date.parse(item.startAt);
    const itemEnd = itemStart + (serviceDurations[item.type] || 30) * 60_000;
    return start < itemEnd && itemStart < end;
  }));
}

function localMorningOnSameDay(value: string, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(value));
  const date = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return localDateTimeToUtc(`${date.year}-${date.month}-${date.day}T10:00`, timezone);
}

function localDateKey(value: string, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(value));
  const date = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${date.year}-${date.month}-${date.day}`;
}

function validDateKey(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function mergeRows<T extends { id: string }>(base: T[], local: T[], remote: T[]) {
  const baseById = new Map(base.map((item) => [item.id, item]));
  const localById = new Map(local.map((item) => [item.id, item]));
  const remoteById = new Map(remote.map((item) => [item.id, item]));
  const merged = new Map(remoteById);
  for (const id of baseById.keys()) if (!localById.has(id)) merged.delete(id);
  for (const [id, item] of localById) {
    const before = baseById.get(id);
    if (!before || JSON.stringify(before) !== JSON.stringify(item)) merged.set(id, item);
  }
  return [
    ...local.map((item) => merged.get(item.id)).filter((item): item is T => Boolean(item)),
    ...remote.filter((item) => !localById.has(item.id)).map((item) => merged.get(item.id)).filter((item): item is T => Boolean(item)),
  ];
}

function mergeDemoState(base: DemoState, local: DemoState, remote: DemoState): DemoState {
  return {
    appointments: mergeRows(base.appointments, local.appointments, remote.appointments),
    tasks: mergeRows(base.tasks, local.tasks, remote.tasks),
    referrals: mergeRows(base.referrals, local.referrals, remote.referrals),
    messages: mergeRows(base.messages, local.messages, remote.messages),
    waitlist: mergeRows(base.waitlist, local.waitlist, remote.waitlist),
  };
}

function App() {
  const [state, setState] = useState<DemoState>(loadDemoState);
  const [cloudReady, setCloudReady] = useState(!apiBaseUrl);
  const [cloudStatus, setCloudStatus] = useState(apiBaseUrl ? "connecting" : "local");
  const cloudRevision = useRef<number | null>(null);
  const cloudBaseState = useRef<DemoState | null>(null);
  const latestState = useRef(state);
  const syncQueue = useRef<Promise<void>>(Promise.resolve());
  latestState.current = state;
  const [page, setPage] = useState<Page>("Overview");
  const [market, setMarket] = useState<Market>("USA");
  const [clinicTimezone, setClinicTimezone] = useState("America/Chicago");
  const [displayTimezone, setDisplayTimezone] = useState("America/Los_Angeles");
  const [showBooking, setShowBooking] = useState(false);
  const [showWaitlist, setShowWaitlist] = useState(false);
  const [showCallDemo, setShowCallDemo] = useState(false);
  const [toast, setToast] = useState("");
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (!apiBaseUrl) return;
    const controller = new AbortController();
    getRemoteDemoState(controller.signal).then((snapshot) => {
      cloudRevision.current = snapshot.revision;
      cloudBaseState.current = snapshot.state;
      setState(snapshot.state);
      setCloudStatus("connected");
      setCloudReady(true);
    }).catch(() => {
      if (controller.signal.aborted) return;
      setCloudStatus("local");
      setCloudReady(false);
    });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    saveDemoState(state);
    if (!apiBaseUrl || !cloudReady || cloudRevision.current === null) return;
    const timer = window.setTimeout(() => {
      setCloudStatus("saving");
      syncQueue.current = syncQueue.current.catch(() => undefined).then(async () => {
        const desired = latestState.current;
        const revision = cloudRevision.current;
        if (revision === null) return;
        try {
          const saved = await putRemoteDemoState({ state: desired, revision });
          cloudBaseState.current = saved.state;
          cloudRevision.current = saved.revision;
        } catch (error) {
          if (!(error instanceof RemoteStateConflict)) throw error;
          const remote = await getRemoteDemoState(new AbortController().signal);
          const localNow = latestState.current;
          const merged = mergeDemoState(cloudBaseState.current || remote.state, localNow, remote.state);
          const saved = await putRemoteDemoState({ state: merged, revision: remote.revision });
          cloudBaseState.current = saved.state;
          cloudRevision.current = saved.revision;
          if (JSON.stringify(latestState.current) === JSON.stringify(localNow)
            && JSON.stringify(merged) !== JSON.stringify(localNow)) setState(merged);
        }
        setCloudStatus("connected");
      }).catch(() => setCloudStatus("sync issue"));
    }, 500);
    return () => window.clearTimeout(timer);
  }, [state, cloudReady]);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const appointments = useMemo(
    () => [...state.appointments].sort((a, b) => a.startAt.localeCompare(b.startAt)),
    [state.appointments],
  );
  const openTasks = state.tasks.filter((task) => task.status !== "Done");

  function changeMarket(nextMarket: Market) {
    setMarket(nextMarket);
    setClinicTimezone(marketTimezones[nextMarket][0]);
    setDisplayTimezone(marketTimezones[nextMarket][0]);
  }

  function addMessage(recipient: string, purpose: string, body: string) {
    setState((current) => ({
      ...current,
      messages: [{ id: id("msg"), recipient, purpose, body, sentAt: new Date().toISOString(), status: "Queued (demo)" as const }, ...current.messages].slice(0, 200),
    }));
  }

  function addTask(title: string, patient: string, detail: string, priority: FollowUpTask["priority"] = "Normal") {
    const task: FollowUpTask = {
      id: id("task"), title, patient, detail,
      dueAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
      priority, status: "Open",
    };
    setState((current) => ({ ...current, tasks: [task, ...current.tasks].slice(0, 100) }));
    setToast("Added to the staff follow-up queue");
  }

  function createAppointment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const patient = String(form.get("patient") || "").trim();
    const appointmentType = String(form.get("appointmentType") || appointmentTypes[0]);
    const localStart = String(form.get("startAt") || "");
    if (!patient || !localStart) return;

    let startAt: string;
    try {
      startAt = localDateTimeToUtc(localStart, clinicTimezone);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Choose a valid time");
      return;
    }

    if (!isDemoSlotOpen(startAt, appointmentType, clinicTimezone)) {
      setToast("Choose a future weekday slot from 8:00 AM to 5:00 PM, in 30-minute steps");
      return;
    }
    const provider = providerForSlot(state.appointments, startAt, appointmentType);
    if (!provider) {
      setToast("No sample provider is free at that time");
      return;
    }

    const reference = `DEMO-${Math.floor(1000 + Math.random() * 8999)}`;
    const appointment: Appointment = {
      id: id("apt"), patient, reference, type: appointmentType,
      provider: provider.name, location: provider.location, startAt,
      timezone: clinicTimezone,
      status: "Confirmed", documents: appointmentType === "Follow-up visit" ? "Received" : "Needed",
    };
    setState((current) => ({
      ...current,
      appointments: [appointment, ...current.appointments].slice(0, 100),
      referrals: appointment.documents === "Needed" ? [{
        id: id("doc"), patient, reference, appointment: appointmentType,
        document: "Referral letter · sample needed", status: "Needed" as const,
      }, ...current.referrals].slice(0, 100) : current.referrals,
      tasks: appointment.documents === "Needed" ? [{
        id: id("task"), title: "Referral document missing", patient,
        detail: "Check whether the sample referral has arrived; the 48-hour text remains simulated.",
        dueAt: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(), priority: "Normal" as const, status: "Open" as const,
      }, ...current.tasks].slice(0, 100) : current.tasks,
      messages: [
        {
          id: id("msg"), recipient: `${patient} · ${reference}`, purpose: "Booking confirmation",
          body: `Demo appointment confirmed for ${formatDateTime(startAt, clinicTimezone)} (${timezoneLabel(clinicTimezone)}). No text was sent.`,
          sentAt: new Date().toISOString(), appointmentReference: reference, status: "Queued (demo)" as const,
        },
        {
          id: id("msg"), recipient: `${patient} · ${reference}`, purpose: "24-hour appointment reminder",
          body: `Reminder for your sample appointment at ${formatDateTime(startAt, clinicTimezone)} (${timezoneLabel(clinicTimezone)}). This text is not sent.`,
          sentAt: new Date().toISOString(), scheduledFor: new Date(Math.max(Date.now(), Date.parse(startAt) - 24 * 60 * 60 * 1000)).toISOString(),
          appointmentReference: reference, status: "Scheduled (demo)" as const,
        },
        ...(appointment.documents === "Needed" ? [{
          id: id("msg"), recipient: `${patient} · ${reference}`, purpose: "48-hour missing-document follow-up",
          body: "A sample referral is still marked as needed. This follow-up is simulated and will be cancelled if the sample is received.",
          sentAt: new Date().toISOString(), scheduledFor: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
          appointmentReference: reference, status: "Scheduled (demo)" as const,
        }] : []),
        ...current.messages,
      ].slice(0, 200),
    }));
    setShowBooking(false);
    setPage("Appointments");
    setToast(`Appointment confirmed · ${reference}`);
  }

  function changeAppointment(appointment: Appointment, action: "reschedule" | "cancel") {
    const actionLabel = action === "reschedule" ? "move this demo appointment to the next available day" : "cancel this demo appointment";
    if (!window.confirm(`Would you like to ${actionLabel}? This only changes sample data.`)) return;
    let nextStartAt = appointment.startAt;
    let nextProvider = { name: appointment.provider, location: appointment.location };
    if (action === "reschedule") {
      try {
        const baseStart = isDemoSlotOpen(appointment.startAt, appointment.type, clinicTimezone)
          ? appointment.startAt
          : localMorningOnSameDay(appointment.startAt, clinicTimezone);
        let found = false;
        for (let day = 1; day <= 31 && !found; day += 1) {
          const candidate = addLocalDays(baseStart, day, clinicTimezone);
          const available = isDemoSlotOpen(candidate, appointment.type, clinicTimezone)
            ? providerForSlot(state.appointments, candidate, appointment.type, appointment.id)
            : undefined;
          if (available) { nextStartAt = candidate; nextProvider = available; found = true; }
        }
        if (!found) throw new Error("No sample opening was found in the next month. Choose another time.");
      } catch (error) {
        setToast(error instanceof Error ? error.message : "Choose another time");
        return;
      }
    }
    setState((current) => ({
      ...current,
      appointments: current.appointments.map((item) => item.id === appointment.id
        ? { ...item, ...(action === "cancel" ? { status: "Cancelled" as const } : { startAt: nextStartAt, timezone: clinicTimezone, provider: nextProvider.name, location: nextProvider.location }) }
        : item),
      messages: current.messages.map((message) => {
        if (message.appointmentReference !== appointment.reference || message.status !== "Scheduled (demo)") return message;
        if (action === "cancel") return { ...message, status: "Cancelled (demo)" as const };
        if (message.purpose === "24-hour appointment reminder") return { ...message, scheduledFor: new Date(Math.max(Date.now(), Date.parse(nextStartAt) - 24 * 60 * 60 * 1000)).toISOString() };
        return message;
      }),
      ...(action === "cancel" && current.waitlist.some((item) => item.status === "Waiting"
        && item.appointmentType === appointment.type
        && item.preferredDate === localDateKey(appointment.startAt, item.timezone)) ? (() => {
        const opening = current.waitlist.find((item) => item.status === "Waiting"
          && item.appointmentType === appointment.type
          && item.preferredDate === localDateKey(appointment.startAt, item.timezone));
        if (!opening) return {};
        const task: FollowUpTask = {
          id: id("task"), title: "Waitlist follow-up", patient: opening.patient,
          detail: "A sample opening is available; confirm the waitlist request with the sample patient.",
          dueAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(), priority: "Today", status: "Open",
        };
        return {
          waitlist: current.waitlist.map((item) => item.id === opening.id ? { ...item, status: "Opening found" as const } : item),
          tasks: [task, ...current.tasks].slice(0, 100),
        };
      })() : {}),
    }));
    const purpose = action === "reschedule" ? "Reschedule confirmation" : "Cancellation confirmation";
    addMessage(appointment.patient, purpose, `Your sample appointment has been ${action === "reschedule" ? "rescheduled" : "cancelled"}. This is a demo message; nothing was sent.`);
    setToast(action === "reschedule" ? "Appointment moved by one day in the demo" : "Appointment cancelled in the demo");
  }

  function joinWaitlist(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const patient = String(form.get("patient") || "").trim();
    const appointmentType = String(form.get("appointmentType") || appointmentTypes[0]);
    const preferredDate = String(form.get("preferredDate") || "");
    if (!demoPatients.includes(patient) || !appointmentTypes.includes(appointmentType) || !validDateKey(preferredDate)) {
      setToast("Choose a sample patient, appointment type, and valid date");
      return;
    }
    if (state.waitlist.some((item) => item.patient === patient && item.appointmentType === appointmentType
      && item.preferredDate === preferredDate && item.timezone === clinicTimezone && item.status !== "Cancelled")) {
      setToast("That sample is already on the waitlist");
      return;
    }
    const item = {
      id: id("wait"), patient, appointmentType, preferredDate, timezone: clinicTimezone,
      createdAt: new Date().toISOString(), status: "Waiting" as const,
    };
    setState((current) => ({ ...current, waitlist: [item, ...current.waitlist].slice(0, 100) }));
    setShowWaitlist(false);
    setPage("Waitlist");
    setToast("Added to the sample waitlist. No message was sent.");
  }

  function cancelWaitlist(itemId: string) {
    setState((current) => ({
      ...current,
      waitlist: current.waitlist.map((item) => item.id === itemId && ["Waiting", "Opening found"].includes(item.status)
        ? { ...item, status: "Cancelled" }
        : item),
    }));
    setToast("Sample waitlist request cancelled");
  }

  function markDocument(itemId: string) {
    setState((current) => ({
      ...current,
      referrals: current.referrals.map((item) => item.id === itemId ? { ...item, status: "Received", receivedAt: new Date().toISOString() } : item),
      appointments: current.appointments.map((appointment) => {
        const referral = current.referrals.find((item) => item.id === itemId);
        return referral && appointment.reference === referral.reference ? { ...appointment, documents: "Received" } : appointment;
      }),
      tasks: current.tasks.map((task) => task.title.toLowerCase().includes("document") && task.patient === current.referrals.find((item) => item.id === itemId)?.patient
        ? { ...task, status: "Done" }
        : task),
      messages: current.messages.map((message) => message.appointmentReference === current.referrals.find((item) => item.id === itemId)?.reference && message.purpose === "48-hour missing-document follow-up" && message.status === "Scheduled (demo)"
        ? { ...message, status: "Cancelled (demo)" }
        : message),
    }));
    setToast("Sample document marked as received");
  }

  function updateTask(taskId: string, status: FollowUpTask["status"]) {
    setState((current) => ({ ...current, tasks: current.tasks.map((task) => task.id === taskId ? { ...task, status } : task) }));
    setToast(status === "Done" ? "Follow-up completed" : "Follow-up updated");
  }

  function simulateCall(intent: CallIntent) {
    setShowCallDemo(false);
    if (intent === "appointment") {
      setShowBooking(true);
      return;
    }
    if (intent === "waitlist") {
      setShowWaitlist(true);
      return;
    }
    if (intent === "faq") {
      setPage("FAQs");
      setToast("Browse the approved answers. Unlisted questions go to staff.");
      return;
    }
    const messages: Record<Exclude<CallIntent, "appointment" | "waitlist">, [string, string, FollowUpTask["priority"]?]> = {
      faq: ["FAQ question", "The assistant uses approved clinic answers only. If it cannot find an answer, it offers staff follow-up."],
      callback: ["Call back requested", "Caller asked to speak with a member of the front desk.", "Today"],
      refill: ["Prescription request", "Request passed to staff. The demo does not approve or advise about medication."],
      records: ["Medical records request", "Request captured for the records team. No records are accessed or released in the demo."],
      billing: ["Billing question", "Question routed to the billing team. The demo does not confirm coverage or charges."],
      documents: ["Referral document follow-up", "Caller needs help with the sample referral checklist."],
    };
    const [title, detail, priority] = messages[intent];
    addTask(title, demoPatients[Math.floor(Math.random() * demoPatients.length)], detail, priority || "Normal");
    setPage("Follow-ups");
  }

  function resetDemo() {
    if (!window.confirm("Reset all local sample changes and restore the original fake clinic data?")) return;
    setState(resetDemoState());
    setPage("Overview");
    setToast("Sample data restored");
  }

  const filteredFaqs = faqEntries.filter((entry) => `${entry.question} ${entry.answer} ${entry.category}`.toLowerCase().includes(search.toLowerCase()));
  const pageTitle = page === "Overview" ? "Good morning, team" : page;

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
              <button className={`nav-item ${page === item.name ? "nav-item-active" : ""}`} onClick={() => setPage(item.name)} aria-current={page === item.name ? "page" : undefined}>
                <span className="nav-icon">{item.icon}</span><span>{item.name}</span>
                {item.name === "Follow-ups" && openTasks.length > 0 && <span className="nav-count">{openTasks.length}</span>}
              </button>
            </div>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="assistant-card">
            <div className="assistant-card-top"><span className="online-dot" />AI receptionist <span className="mock-tag">MOCK</span></div>
            <p>{cloudStatus === "connected" || cloudStatus === "saving" ? "Shared cloud demo. No calls or texts are sent." : cloudStatus === "sync issue" ? "Cloud sync issue. No calls or texts are sent." : "Local demo mode. No calls or texts are sent."}</p>
            <button className="assistant-link" onClick={() => setShowCallDemo(true)}>Try a sample call <span>↗</span></button>
          </div>
          <div className="user-profile"><Avatar name="Owner" /><span><strong>Demo workspace</strong><small>Administrator</small></span><button className="more-button" aria-label="Profile options">···</button></div>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div className="breadcrumb"><span>Harbor Health</span><span className="crumb-divider">/</span><strong>{page}</strong></div>
          <div className="topbar-actions">
            <span className="demo-indicator"><span className="online-dot" />{cloudStatus === "connected" ? "CLOUD DEMO · CALLS OFF" : cloudStatus === "saving" ? "SAVING SAMPLE DATA" : cloudStatus === "sync issue" ? "LOCAL COPY · SYNC ISSUE" : "LOCAL DEMO · CALLS OFF"}</span>
            <button className="icon-button" aria-label="Notifications">♧<i /></button>
            <Avatar name="Owner" size="small" />
          </div>
        </header>

        <div className="page-content">
          <div className="page-heading-row">
            <div>
              <div className="eyebrow">{new Intl.DateTimeFormat("en", { weekday: "long", month: "long", day: "numeric", timeZone: clinicTimezone }).format(new Date()).toUpperCase()} <span>·</span> {timezoneLabel(clinicTimezone)}</div>
              <h1>{pageTitle}</h1>
              <p className="page-subtitle">{page === "Overview" ? "Here’s what needs your attention today." : pageDescriptions[page]}</p>
            </div>
            <div className="heading-actions">
              <button className="button button-secondary" onClick={() => setShowCallDemo(true)}><span className="button-icon">◉</span> Simulate a call</button>
              {page === "Waitlist" && <button className="button button-secondary" onClick={() => setShowWaitlist(true)}><span className="button-icon">↗</span> Join waitlist</button>}
              <button className="button button-primary" onClick={() => setShowBooking(true)}><span className="button-icon">＋</span> New appointment</button>
            </div>
          </div>

          <section className="timezone-strip" aria-label="Market and timezone controls">
            <div className="market-control"><span className="control-icon">◎</span><label htmlFor="market-select">Market</label>
              <select id="market-select" value={market} onChange={(event) => changeMarket(event.target.value as Market)}>
                {marketNames.map((name) => <option key={name}>{name}</option>)}
              </select>
            </div>
            <div className="control-divider" />
            <div className="market-control"><span className="control-icon">◷</span><label htmlFor="clinic-timezone">Clinic schedule</label>
              <select id="clinic-timezone" value={clinicTimezone} onChange={(event) => setClinicTimezone(event.target.value)}>
                {marketTimezones[market].map((zone) => <option key={zone} value={zone}>{timezoneLabel(zone)}</option>)}
              </select>
            </div>
            <div className="control-divider" />
            <div className="market-control"><span className="control-icon">◉</span><label htmlFor="display-timezone">My display time</label>
              <select id="display-timezone" value={displayTimezone} onChange={(event) => setDisplayTimezone(event.target.value)}>
                {allTimezones.map((zone) => <option key={zone} value={zone}>{timezoneLabel(zone)}</option>)}
              </select>
            </div>
            <span className="english-tag">ENGLISH</span>
          </section>

          {page === "Overview" && <Overview state={state} clinicTimezone={clinicTimezone} displayTimezone={displayTimezone} onPage={setPage} onTask={updateTask} onCall={() => setShowCallDemo(true)} />}
          {page === "Appointments" && <Appointments appointments={appointments} clinicTimezone={clinicTimezone} displayTimezone={displayTimezone} onChange={changeAppointment} onBook={() => setShowBooking(true)} />}
          {page === "Waitlist" && <Waitlist entries={state.waitlist} onCancel={cancelWaitlist} />}
          {page === "Referrals" && <Referrals state={state} clinicTimezone={clinicTimezone} onMark={markDocument} />}
          {page === "Follow-ups" && <FollowUps tasks={state.tasks} clinicTimezone={clinicTimezone} onUpdate={updateTask} />}
          {page === "Messages" && <Messages state={state} clinicTimezone={clinicTimezone} />}
          {page === "FAQs" && <Faqs entries={filteredFaqs} search={search} onSearch={setSearch} onAskStaff={() => addTask("FAQ needs review", "Front desk", "A published demo FAQ was flagged for staff review. No caller text was stored.", "Normal")} />}
          {page === "Settings" && <Settings market={market} clinicTimezone={clinicTimezone} displayTimezone={displayTimezone} onReset={resetDemo} />}

          <div className="footer-note"><span className="shield-icon">◇</span><span>Fictional demo · Use sample data only · Not for medical advice or real patient information</span><button onClick={() => setPage("Settings")}>Demo settings</button></div>
        </div>
      </main>

      {showBooking && <BookingModal clinicTimezone={clinicTimezone} onClose={() => setShowBooking(false)} onSubmit={createAppointment} />}
      {showWaitlist && <WaitlistModal clinicTimezone={clinicTimezone} onClose={() => setShowWaitlist(false)} onSubmit={joinWaitlist} />}
      {showCallDemo && <CallDemoModal onClose={() => setShowCallDemo(false)} onSelect={simulateCall} />}
      {toast && <div className="toast" role="status"><span>✓</span>{toast}</div>}
    </div>
  );
}

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

function Overview({ state, clinicTimezone, displayTimezone, onPage, onTask, onCall }: {
  state: DemoState; clinicTimezone: string; displayTimezone: string; onPage: (page: Page) => void;
  onTask: (id: string, status: FollowUpTask["status"]) => void; onCall: () => void;
}) {
  const upcoming = state.appointments.filter((item) => item.status !== "Cancelled").sort((a, b) => a.startAt.localeCompare(b.startAt)).slice(0, 4);
  const open = state.tasks.filter((item) => item.status !== "Done").sort((a, b) => a.dueAt.localeCompare(b.dueAt)).slice(0, 3);
  const pendingDocs = state.referrals.filter((item) => item.status !== "Received").length;
  const dueMessages = state.messages.filter((item) => item.status === "Queued (demo)" || item.status === "Scheduled (demo)").length;

  return <>
    <div className="stats-grid">
      <StatCard label="Appointments today" value={String(state.appointments.filter((item) => item.status !== "Cancelled" && new Date(item.startAt).getTime() < Date.now() + 24 * 60 * 60 * 1000).length)} note="Across both locations" icon="▦" color="blue" />
      <StatCard label="Needs follow-up" value={String(state.tasks.filter((item) => item.status !== "Done").length)} note="Requests from callers" icon="◷" color="purple" />
      <StatCard label="Documents pending" value={String(pendingDocs)} note="Sample referrals and forms" icon="▤" color="orange" />
      <StatCard label="Texts planned" value={String(dueMessages)} note="Simulation only · not sent" icon="◌" color="green" />
    </div>

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
          {open.map((task) => <div className="attention-item" key={task.id}><span className={`attention-mark mark-${taskTone(task.priority)}`}>{task.priority === "Today" ? "!" : "·"}</span><div className="attention-copy"><div className="attention-title">{task.title}</div><div className="attention-detail">{task.patient} · due {formatShort(task.dueAt, clinicTimezone)}</div></div><button className="check-button" onClick={() => onTask(task.id, "Done")} aria-label={`Complete ${task.title}`}>✓</button></div>)}
          {open.length === 0 && <EmptyState title="All caught up" text="New staff requests will appear here." />}
        </div>
        <button className="list-footer-button" onClick={() => onPage("Follow-ups")}>View follow-up queue <span>→</span></button>
      </section>
    </div>

    <div className="content-grid lower-grid">
      <section className="card activity-card">
        <div className="card-heading"><div><h2>Recent front desk activity</h2><p>Updates across calls, visits, and documents</p></div><button className="text-button" onClick={() => onPage("Messages")}>Message log <span>→</span></button></div>
        <div className="activity-list">
          <Activity icon="✓" color="green" title="Appointment confirmed" detail="Maya Patel · New patient visit" time={formatShort(state.appointments[0]?.startAt || new Date().toISOString(), displayTimezone)} />
          <Activity icon="▤" color="orange" title="Referral still needed" detail="Jordan Lee · Follow-up visit" time="Follow-up due tomorrow" />
          <Activity icon="↗" color="blue" title="Call-back requested" detail="Samira Khan · Location question" time="Added to staff queue" />
        </div>
      </section>
      <section className="card assistant-summary-card">
        <div className="summary-top"><div className="summary-icon">✦</div><div><span className="summary-overline">AI FRONT DESK</span><h2>Ready to help, safely.</h2></div><StatusPill tone="blue">Mock mode</StatusPill></div>
        <p>The assistant can answer approved admin questions, help with sample appointments, and route requests to staff.</p>
        <div className="summary-safety"><span>✓</span><span>Clinical questions go to a person. No calls or texts are sent in this local demo.</span></div>
        <button className="button button-secondary full-button" onClick={onCall}>Explore a sample call <span>→</span></button>
      </section>
    </div>
  </>;
}

function StatCard({ label, value, note, icon, color }: { label: string; value: string; note: string; icon: string; color: string }) {
  return <div className="stat-card"><div className={`stat-icon stat-${color}`}>{icon}</div><div className="stat-label">{label}</div><div className="stat-value">{value}</div><div className="stat-note">{note}</div></div>;
}

function Activity({ icon, color, title, detail, time }: { icon: string; color: string; title: string; detail: string; time: string }) {
  return <div className="activity-item"><span className={`activity-icon activity-${color}`}>{icon}</span><div className="activity-copy"><strong>{title}</strong><span>{detail}</span></div><span className="activity-time">{time}</span></div>;
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

function Appointments({ appointments, clinicTimezone, displayTimezone, onChange, onBook }: {
  appointments: Appointment[]; clinicTimezone: string; displayTimezone: string;
  onChange: (appointment: Appointment, action: "reschedule" | "cancel") => void; onBook: () => void;
}) {
  const [filter, setFilter] = useState("All appointments");
  const visible = appointments.filter((appointment) => filter === "All appointments" || appointment.status === filter);
  return <section className="card full-card">
    <div className="card-heading card-heading-wide"><div><h2>Appointment schedule</h2><p>Sample appointments use the clinic timezone for scheduling.</p></div><div className="inline-actions"><select className="filter-select" value={filter} onChange={(event) => setFilter(event.target.value)}><option>All appointments</option><option>Confirmed</option><option>Needs confirmation</option><option>Cancelled</option></select><button className="button button-primary button-small" onClick={onBook}>＋ Book appointment</button></div></div>
    <div className="table-head appointment-table-head"><span>DATE</span><span>PATIENT</span><span>CLINIC TIME / YOUR TIME</span><span>PROVIDER</span><span>STATUS</span><span>ACTIONS</span></div>
    <div className="table-list">{visible.map((appointment) => <div className="table-row appointment-table-row" key={appointment.id}>
      <div className="date-stack"><strong>{formatDate(appointment.startAt, clinicTimezone)}</strong><span>{formatTime(appointment.startAt, clinicTimezone)} clinic</span></div>
      <div className="patient-cell"><Avatar name={appointment.patient} size="small" /><div><strong>{appointment.patient}</strong><span>{appointment.reference} · {appointment.type}</span></div></div>
      <div className="dual-time"><strong>{formatTime(appointment.startAt, clinicTimezone)}</strong><span>{formatTime(appointment.startAt, displayTimezone)} viewer</span></div>
      <div className="provider-cell"><strong>{appointment.provider}</strong><span>{appointment.location}</span></div>
      <StatusPill tone={appointmentTone(appointment.status)}>{appointment.status}</StatusPill>
      <div className="row-actions">{appointment.status !== "Cancelled" && <><button onClick={() => onChange(appointment, "reschedule")}>Move</button><button className="action-danger" onClick={() => onChange(appointment, "cancel")}>Cancel</button></>}</div>
    </div>)}{visible.length === 0 && <EmptyState title="No appointments here" text="Try a different filter or book a sample appointment." />}</div>
    <div className="table-foot"><span>{visible.length} sample appointments</span><span>All times stored as UTC · shown in selected zones</span></div>
  </section>;
}

function Waitlist({ entries, onCancel }: { entries: DemoState["waitlist"]; onCancel: (id: string) => void }) {
  const active = entries.filter((item) => item.status !== "Cancelled");
  return <div className="stack-layout">
    <div className="banner banner-demo"><span className="banner-icon">↗</span><div><strong>Sample waitlist</strong><span>When a matching appointment is cancelled, the front desk gets a follow-up task. The demo never books or texts someone automatically.</span></div><StatusPill tone="blue">No messages sent</StatusPill></div>
    <section className="card full-card"><div className="card-heading"><div><h2>Waitlist requests</h2><p>Requests use fictional patients and a preferred clinic date.</p></div><StatusPill tone="amber">{`${active.length} active`}</StatusPill></div>
      <div className="waitlist-list">{entries.map((item) => <article className="waitlist-entry" key={item.id}>
        <Avatar name={item.patient} size="small" />
        <div className="waitlist-person"><strong>{item.patient}</strong><span>{item.appointmentType}</span></div>
        <div className="waitlist-date"><span>Preferred date</span><strong>{item.preferredDate}</strong><small>{timezoneLabel(item.timezone)}</small></div>
        <StatusPill tone={item.status === "Opening found" || item.status === "Booked" ? "green" : item.status === "Cancelled" ? "neutral" : "amber"}>{item.status}</StatusPill>
        {item.status === "Waiting" || item.status === "Opening found" ? <button className="row-text-action" onClick={() => onCancel(item.id)}>Cancel request</button> : <span className="waitlist-date">Added {formatDateTime(item.createdAt, item.timezone)}</span>}
      </article>)}{entries.length === 0 && <EmptyState title="No waitlist requests" text="Add a fictional request to try the cancellation workflow." />}</div>
      <div className="storage-note"><span>i</span><p>The demo stores no phone numbers or contact details. Staff must confirm a matching opening with the fictional sample patient.</p></div>
    </section>
  </div>;
}

function Referrals({ state, clinicTimezone, onMark }: { state: DemoState; clinicTimezone: string; onMark: (id: string) => void }) {
  return <div className="stack-layout">
    <div className="banner banner-safety"><span className="banner-icon">◇</span><div><strong>Sample files only</strong><span>Document uploads are simulated here. Never add a real referral or medical record to this demo.</span></div></div>
    <section className="card full-card"><div className="card-heading"><div><h2>Referral & document checklist</h2><p>Track what's needed before each sample visit.</p></div><button className="button button-secondary button-small" disabled={!state.referrals.some((item) => item.status !== "Received")} onClick={() => { const next = state.referrals.find((item) => item.status !== "Received"); if (next) onMark(next.id); }}>＋ Mark next sample received</button></div>
      <div className="document-list">{state.referrals.map((item) => <div className="document-row" key={item.id}><div className="file-icon">▤</div><div className="document-main"><strong>{item.document}</strong><span>{item.patient} · {item.reference} · {item.appointment}</span></div><div className="document-date">{item.receivedAt ? `Received ${formatDateTime(item.receivedAt, clinicTimezone)}` : "Waiting for sample"}</div><StatusPill tone={item.status === "Received" ? "green" : item.status === "In review" ? "blue" : "amber"}>{item.status}</StatusPill><button className="row-text-action" disabled={item.status === "Received"} onClick={() => onMark(item.id)}>{item.status === "Received" ? "Complete" : item.status === "In review" ? "Mark reviewed" : "Mark sample received"}</button></div>)}</div>
      <div className="storage-note"><span>i</span><p>The demo stores only sample document names and statuses in this browser. It does not upload or retain file contents.</p></div>
    </section>
    <section className="card followup-banner-card"><div className="calendar-illustration">◷</div><div><h3>Automatic follow-up, without the chasing</h3><p>The demo schedules one sample follow-up 48 hours after booking when a referral is missing. Mark the sample document received to cancel it. No text is sent.</p></div><StatusPill tone="blue">Planned</StatusPill></section>
  </div>;
}

function FollowUps({ tasks, clinicTimezone, onUpdate }: { tasks: FollowUpTask[]; clinicTimezone: string; onUpdate: (id: string, status: FollowUpTask["status"]) => void }) {
  const sorted = [...tasks].sort((a, b) => (a.status === "Done" ? 1 : 0) - (b.status === "Done" ? 1 : 0) || a.dueAt.localeCompare(b.dueAt));
  return <section className="card full-card"><div className="card-heading"><div><h2>Staff follow-up queue</h2><p>Requests that need a person to close the loop.</p></div><StatusPill tone="amber">{`${tasks.filter((task) => task.status !== "Done").length} open`}</StatusPill></div>
    <div className="task-list">{sorted.map((task) => <div className={`task-row ${task.status === "Done" ? "task-complete" : ""}`} key={task.id}><span className={`task-priority priority-${taskTone(task.priority)}`}>{task.priority === "Urgent" ? "!" : "◷"}</span><div className="task-body"><div className="task-title-line"><strong>{task.title}</strong><StatusPill tone={task.status === "Done" ? "green" : taskTone(task.priority)}>{task.status === "Done" ? "Done" : task.priority}</StatusPill></div><span>{task.patient} · {task.detail}</span></div><div className="task-due">Due <strong>{formatDateTime(task.dueAt, clinicTimezone)}</strong></div><select aria-label={`Update ${task.title}`} value={task.status} onChange={(event) => onUpdate(task.id, event.target.value as FollowUpTask["status"])}><option>Open</option><option>In progress</option><option>Done</option></select></div>)}</div>
  </section>;
}

function Messages({ state, clinicTimezone }: { state: DemoState; clinicTimezone: string }) {
  return <div className="stack-layout"><div className="banner banner-demo"><span className="banner-icon">◌</span><div><strong>SMS simulation only</strong><span>These messages are examples in local storage. The app does not contact anyone.</span></div><StatusPill tone="blue">Live texting off</StatusPill></div>
    <section className="card full-card"><div className="card-heading"><div><h2>Message activity</h2><p>Booking confirmations, reminders, follow-ups, and opt-outs.</p></div><span className="subtle-label">{state.messages.length} examples</span></div>
      <div className="message-list">{state.messages.map((message) => <article className="message-row" key={message.id}><div className="message-leading"><span className={`message-icon ${message.status === "Opt-out" || message.status === "Cancelled (demo)" ? "message-muted" : ""}`}>{message.status === "Opt-out" || message.status === "Cancelled (demo)" ? "⊘" : "↗"}</span></div><div className="message-content"><div className="message-title"><strong>{message.purpose}</strong><span>{message.recipient}</span></div><p>{message.body}</p><small>{message.scheduledFor ? `Scheduled for ${formatDateTime(message.scheduledFor, clinicTimezone)}` : formatDateTime(message.sentAt, clinicTimezone)} · {message.status}</small></div><StatusPill tone={message.status === "Delivered (demo)" ? "green" : message.status === "Opt-out" || message.status === "Cancelled (demo)" ? "neutral" : "amber"}>{message.status}</StatusPill></article>)}</div>
    </section></div>;
}

function Faqs({ entries, search, onSearch, onAskStaff }: { entries: typeof faqEntries; search: string; onSearch: (value: string) => void; onAskStaff: (question: string) => void }) {
  const categories = [...new Set(faqEntries.map((entry) => entry.category))];
  const [category, setCategory] = useState("All topics");
  const visible = entries.filter((entry) => category === "All topics" || entry.category === category);
  return <div className="stack-layout"><div className="faq-tools"><div className="search-wrap"><span>⌕</span><input aria-label="Search FAQs" value={search} onChange={(event) => onSearch(event.target.value)} placeholder="Search common questions..." /></div><select value={category} onChange={(event) => setCategory(event.target.value)}><option>All topics</option>{categories.map((item) => <option key={item}>{item}</option>)}</select><StatusPill tone="green">English · reviewed</StatusPill></div>
    <div className="faq-grid">{visible.map((entry) => <article className="card faq-card" key={entry.id}><div className="faq-card-top"><span className="faq-category">{entry.category}</span><span className="faq-status">✓ Approved</span></div><h3>{entry.question}</h3><p>{entry.answer}</p><div className="faq-card-footer"><span>{entry.updated}</span><button onClick={() => onAskStaff(`Please review this answer: ${entry.question}`)}>Ask staff to review ↗</button></div></article>)}{visible.length === 0 && <EmptyState title="No matching questions" text="Try another search term." />}</div>
    <div className="banner banner-safety"><span className="banner-icon">◇</span><div><strong>Answers stay in their lane</strong><span>Medical, symptom, and medication questions are handed to clinic staff. The assistant does not guess when an approved answer is missing.</span></div></div>
  </div>;
}

function Settings({ market, clinicTimezone, displayTimezone, onReset }: { market: Market; clinicTimezone: string; displayTimezone: string; onReset: () => void }) {
  return <div className="settings-grid"><section className="card settings-card"><div className="card-heading"><div><h2>Clinic profile</h2><p>Fictional settings for the local demo.</p></div><StatusPill tone="blue">Demo only</StatusPill></div><div className="setting-line"><span>Market</span><strong>{market}</strong></div><div className="setting-line"><span>Clinic scheduling timezone</span><strong>{timezoneLabel(clinicTimezone)}</strong></div><div className="setting-line"><span>My display timezone</span><strong>{timezoneLabel(displayTimezone)}</strong></div><div className="setting-line"><span>Language</span><strong>English</strong></div><div className="setting-line"><span>Opening hours</span><strong>Mon–Fri · 8 AM–5 PM</strong></div><div className="setting-line"><span>Reminder plan</span><strong>Confirmation · 24h · docs follow-up</strong></div></section>
      <section className="card settings-card"><div className="card-heading"><div><h2>Phone & messaging</h2><p>External services are not connected in local mode.</p></div><span className="mock-tag">MOCK</span></div><div className="integration-item"><span className="integration-logo retell-logo">R</span><div><strong>Voice assistant</strong><small>Retell · test numbers only when enabled</small></div><StatusPill tone="blue">Not connected</StatusPill></div><div className="integration-item"><span className="integration-logo sms-logo">↗</span><div><strong>SMS reminders</strong><small>Provider chosen after first market pilot</small></div><StatusPill tone="blue">Not connected</StatusPill></div><div className="allowlist-box"><span>◉</span><div><strong>Test number allowlist</strong><small>No live numbers configured. Real calls and texts remain blocked.</small></div></div></section>
      <section className="card settings-card privacy-card"><div className="privacy-icon">◇</div><div><h2>Keep the demo safe</h2><p>Use fictional names and sample data only. Do not enter real health details or upload patient records. Clinical requests go to a person.</p><button className="text-button" onClick={() => window.alert("This is a fictional front desk demo. It does not provide medical care and does not send calls or texts.")}>View demo boundaries <span>→</span></button></div></section>
      <section className="card settings-card reset-card"><div><h2>Reset this demo</h2><p>Restore the original fictional appointments, tasks, and messages stored in this browser.</p></div><button className="button button-secondary" onClick={onReset}>Reset sample data</button></section>
    </div>;
}

function BookingModal({ clinicTimezone, onClose, onSubmit }: { clinicTimezone: string; onClose: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="booking-title"><div className="modal-header"><div><span className="modal-kicker">SAMPLE SCHEDULE</span><h2 id="booking-title">Book an appointment</h2><p>Choose fictional details for this local demo.</p></div><button className="modal-close" onClick={onClose} aria-label="Close">×</button></div><form onSubmit={onSubmit}>
    <label className="form-label">Fictional patient<select name="patient" required defaultValue=""><option value="" disabled>Choose sample patient</option>{demoPatients.map((patient) => <option key={patient}>{patient}</option>)}</select></label>
    <label className="form-label">Appointment type<select name="appointmentType">{appointmentTypes.map((type) => <option key={type}>{type}</option>)}</select></label>
    <label className="form-label">Date and time <input type="datetime-local" name="startAt" required defaultValue={defaultLocalDateTime(clinicTimezone)} /></label>
    <div className="timezone-hint"><span>◷</span> Using clinic time: <strong>{timezoneLabel(clinicTimezone)}</strong></div>
    <div className="modal-disclaimer">This adds a sample appointment and a simulated confirmation. No real text is sent.</div>
    <div className="modal-actions"><button type="button" className="button button-secondary" onClick={onClose}>Back</button><button type="submit" className="button button-primary">Confirm sample booking <span>→</span></button></div>
  </form></section></div>;
}

function WaitlistModal({ clinicTimezone, onClose, onSubmit }: { clinicTimezone: string; onClose: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="waitlist-title"><div className="modal-header"><div><span className="modal-kicker">SAMPLE WAITLIST</span><h2 id="waitlist-title">Add a waitlist request</h2><p>Use a fictional patient and preferred date.</p></div><button className="modal-close" onClick={onClose} aria-label="Close">×</button></div><form onSubmit={onSubmit}>
    <label className="form-label">Fictional patient<select name="patient" required defaultValue=""><option value="" disabled>Choose sample patient</option>{demoPatients.map((patient) => <option key={patient}>{patient}</option>)}</select></label>
    <label className="form-label">Appointment type<select name="appointmentType">{appointmentTypes.map((type) => <option key={type}>{type}</option>)}</select></label>
    <label className="form-label">Preferred date<input type="date" name="preferredDate" required min={new Date().toISOString().slice(0, 10)} defaultValue={new Date(Date.now() + 4 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)} /></label>
    <div className="timezone-hint"><span>◷</span> Preferred date uses clinic time: <strong>{timezoneLabel(clinicTimezone)}</strong></div>
    <div className="modal-disclaimer">This creates a sample request. A staff task is made when a matching opening appears; no text is sent.</div>
    <div className="modal-actions"><button type="button" className="button button-secondary" onClick={onClose}>Back</button><button type="submit" className="button button-primary">Add to sample waitlist <span>→</span></button></div>
  </form></section></div>;
}

function CallDemoModal({ onClose, onSelect }: { onClose: () => void; onSelect: (intent: CallIntent) => void }) {
  const options: { id: CallIntent; icon: string; title: string; detail: string }[] = [
    { id: "appointment", icon: "▦", title: "Book an appointment", detail: "Try a sample booking flow" },
    { id: "waitlist", icon: "↗", title: "Join a waitlist", detail: "Ask staff to contact a sample patient about an opening" },
    { id: "faq", icon: "?", title: "Ask a common question", detail: "See how approved answers work" },
    { id: "callback", icon: "◉", title: "Ask for a person", detail: "Add a callback to the staff queue" },
    { id: "documents", icon: "▤", title: "Ask about a referral", detail: "Create a document follow-up task" },
    { id: "refill", icon: "＋", title: "Request a prescription refill", detail: "Route it to staff without advice" },
    { id: "records", icon: "▧", title: "Request medical records", detail: "Create an administrative task" },
    { id: "billing", icon: "$", title: "Ask a billing question", detail: "Route the question to staff" },
  ];
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="modal-card call-modal" role="dialog" aria-modal="true" aria-labelledby="call-title"><div className="modal-header"><div><span className="modal-kicker">INTERACTIVE WALKTHROUGH · MOCK MODE</span><h2 id="call-title">What would you like to try?</h2><p>Choose a sample caller request. Nothing is sent outside this browser.</p></div><button className="modal-close" onClick={onClose} aria-label="Close">×</button></div><div className="call-options">{options.map((option) => <button className="call-option" key={option.id} onClick={() => onSelect(option.id)}><span className="call-option-icon">{option.icon}</span><span><strong>{option.title}</strong><small>{option.detail}</small></span><span className="call-option-arrow">→</span></button>)}</div><div className="modal-disclaimer">The live voice and SMS providers are not connected. This walkthrough uses fictional data only.</div></section></div>;
}

function EmptyState({ title, text }: { title: string; text: string }) {
  return <div className="empty-state"><span>⌕</span><strong>{title}</strong><p>{text}</p></div>;
}

export default App;
