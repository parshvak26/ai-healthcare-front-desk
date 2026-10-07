// The call page ("#/"): a product showcase whose one job is to get the visitor talking to Ava, the AI receptionist,
// by phone or in the browser, and then to show what she changed in their private demo clinic.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, FormEvent, ReactNode } from "react";
// Direct module imports (not the package index) keep the scheduling rules out of the call page bundle.
import { callerNames } from "../../../packages/shared/src/names.ts";
import { TurnstileWidget } from "./Turnstile";
import { viewerTimezone } from "./lib/api";
import type { CallCountry, DemoCallsInfo, ToolTiming } from "./lib/api";
import { callChanges, ownUpcomingBookings, trySaying } from "./lib/callInsights";
import type { CallChange } from "./lib/callInsights";
import { canStartAnother, dailyResetLocalTime, unansweredReleaseMs, useCall } from "./lib/callController";
import type { ActiveCall, CallChannel, CallError } from "./lib/callController";
import { clockText, useTicker } from "./lib/clock";
import { useDemo } from "./lib/demoContext";
import {
  caretAfterDigits, checkPhone, composePhone, countries, defaultCountry, deviceLooksIndian, formatLocalDigits, readPhoneEntry, supportedCountries,
} from "./lib/phoneInput";
import { prefetchStaffScreen, routeHref } from "./lib/routes";

const githubUrl = "https://github.com/parshvak26/ai-healthcare-front-desk";

function inAppBrowser() {
  try {
    const agent = navigator.userAgent;
    if (/LinkedInApp/i.test(agent)) return "LinkedIn";
    if (/Instagram/i.test(agent)) return "Instagram";
    if (/FBAN|FBAV|FB_IAB/i.test(agent)) return "Facebook";
  } catch { /* ignore */ }
  return null;
}

// ---------- page ----------

export default function CallPage() {
  const demo = useDemo();
  const controller = useCall();
  const [mode, setMode] = useState<CallChannel>("phone");
  const viewerZone = useMemo(viewerTimezone, []);
  const now = useTicker(60_000);
  const { state, connection, snapshot } = demo;

  // "Welcome back" is decided once, from the first state this page sees, so it doesn't appear after a first call.
  const [returning, setReturning] = useState<boolean | null>(null);
  useEffect(() => {
    if (returning === null && snapshot && connection !== "connecting") setReturning(connection === "cloud" && snapshot.persisted);
  }, [returning, snapshot, connection]);

  const groups = useMemo(() => trySaying(state, now, viewerZone), [state, now, viewerZone]);

  function switchTo(channel: CallChannel) {
    controller.dismiss();
    controller.clearError();
    setMode(channel);
    if (channel === "web") controller.prefetchSdk();
    window.requestAnimationFrame(() => document.getElementById(`mode-${channel}`)?.focus());
  }

  return <div className="cp">
    <a className="cp-skip" href="#call-card">Skip to the call form</a>
    <header className="cp-top">
      <div className="cp-top-inner">
        <a className="cp-brand" href={routeHref.call} aria-label="CareDesk home">
          <span className="cp-brand-mark" aria-hidden="true">+</span>
          <span className="cp-brand-name">caredesk</span>
        </a>
        <span className="cp-demo-pill">Fictional demo</span>
        <a className="cp-staff-link" href={routeHref.staff} onMouseEnter={prefetchStaffScreen} onFocus={prefetchStaffScreen}>
          <span className="cp-staff-long">Clinic staff screen</span><span className="cp-staff-short">Staff screen</span> <span aria-hidden="true">→</span>
        </a>
      </div>
    </header>

    <main className="cp-main">
      <div className="cp-layout">
        <section className="cp-hero" aria-labelledby="page-heading">
          <p className="cp-eyebrow">AI front desk · Live demo</p>
          <h1 id="page-heading" className="cp-title" tabIndex={-1}>Call an AI receptionist that <span className="cp-underline">actually books</span> the appointment.</h1>
          <p className="cp-pitch">Ava runs the front desk at Harbor Health, a made-up clinic. Ask for a visit and she checks the real schedule, books it and reads you a reference — then it shows up on the clinic's staff screen.</p>
          <ul className="cp-chips" aria-label="About the call">
            <li>~5-minute call</li><li>Free</li><li>Fictional clinic</li><li>English</li>
          </ul>
          {returning && state && snapshot?.persisted && <WelcomeBack />}
        </section>

        <div className="cp-card-col" id="call-card">
          <CallCard mode={mode} onMode={setMode} onSwitch={switchTo} />
          <CallNotes mode={mode} info={demo.demoCalls} />
        </div>

        <TrySaying groups={groups} />
      </div>

      <HowItWorks />
      <PrivacyNote />
    </main>

    <footer className="cp-footer">
      <div className="cp-footer-inner">
        <p><strong>CareDesk and Harbor Health are fictional.</strong> This demo gives no medical advice — please don't share real health information.</p>
        <p className="cp-emergency">In an emergency, call your local emergency number.</p>
      </div>
    </footer>
  </div>;
}

function WelcomeBack() {
  const { state, retentionDays } = useDemo();
  const viewerZone = useMemo(viewerTimezone, []);
  const now = useTicker(60_000);
  if (!state) return null;
  const names = callerNames(state);
  const bookings = ownUpcomingBookings(state, now, viewerZone);
  return <div className="cp-welcome">
    <p className="cp-welcome-title"><span aria-hidden="true">↺</span> Welcome back — your demo clinic is saved for {retentionDays} days.</p>
    {bookings.length > 0
      ? <ul className="cp-welcome-list">{bookings.map(({ appointment, when, whenLocal }) => <li key={appointment.id}>
          <strong>{appointment.patient}</strong> · {appointment.type} · {when}{whenLocal ? ` (${whenLocal})` : ""} · <span className="cp-ref">{appointment.reference}</span>
        </li>)}</ul>
      : names.length > 0 && <p className="cp-welcome-sub">Ava will ask who's calling. Names from your calls: {names.slice(0, 4).join(", ")}.</p>}
  </div>;
}

// ---------- the call card ----------

function CallCard({ mode, onMode, onSwitch }: { mode: CallChannel; onMode: (mode: CallChannel) => void; onSwitch: (channel: CallChannel) => void }) {
  const demo = useDemo();
  const { call } = useCall();
  const info = demo.demoCalls;
  let body: ReactNode;
  let variant = "";
  if (call && call.phase !== "ended") { body = <LivePanel call={call} onSwitch={onSwitch} />; variant = "cp-card-live"; }
  else if (call) body = <SummaryPanel call={call} onSwitch={onSwitch} />;
  else if (demo.connection === "connecting") body = <div className="cp-card-loading" role="status"><span className="cp-spinner" aria-hidden="true" />Checking the demo line…</div>;
  else if (demo.connection !== "cloud" || !info?.enabled) { body = <CallsOff />; variant = "cp-card-compact"; }
  else body = <CallForm info={info} mode={mode} onMode={onMode} onSwitch={onSwitch} />;
  return <section className={`cp-card ${variant}`} aria-label="Talk to Ava">{body}</section>;
}

function CallsOff() {
  const demo = useDemo();
  const reason = demo.connection === "local"
    ? "This copy of the site isn't connected to the demo server, so calls are off."
    : demo.connection === "fallback"
      ? "The demo server can't be reached right now, so calls are off."
      : "The demo phone line is switched off at the moment.";
  return <div className="cp-off">
    <span className="cp-off-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M5 4h3l2 5-2.5 1.5a11 11 0 0 0 6 6L15 14l5 2v3a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2" /><path d="M3 3l18 18" /></svg></span>
    <h2 className="cp-card-title">Live calls are off right now</h2>
    <p>{reason} The clinic staff screen still works{demo.connection === "cloud" ? "" : " with a copy of the clinic kept in this browser"} — book, move and cancel sample visits there.</p>
    <a className="cp-btn cp-btn-primary cp-btn-block" href={routeHref.staff} onMouseEnter={prefetchStaffScreen}>Open the clinic staff screen <span aria-hidden="true">→</span></a>
  </div>;
}

function ModeSwitch({ mode, disabled, onMode, prefetch }: { mode: CallChannel; disabled: boolean; onMode: (mode: CallChannel) => void; prefetch: () => void }) {
  const options: { id: CallChannel; label: string }[] = [{ id: "phone", label: "Call my phone" }, { id: "web", label: "Talk in browser" }];
  return <fieldset className="cp-segment" role="radiogroup" aria-labelledby="mode-legend" disabled={disabled}>
    <legend className="cp-sr" id="mode-legend">How do you want to talk to Ava?</legend>
    {options.map((option) => <label key={option.id} className={`cp-segment-option ${mode === option.id ? "is-on" : ""}`} onMouseEnter={option.id === "web" ? prefetch : undefined}>
      <input type="radio" name="call-mode" id={`mode-${option.id}`} value={option.id} checked={mode === option.id} onChange={() => { onMode(option.id); if (option.id === "web") prefetch(); }} />
      <span>{option.label}</span>
    </label>)}
  </fieldset>;
}

function RetryCountdown({ at }: { at: number }) {
  const now = useTicker(1000, at > Date.now() - 1000);
  const left = Math.ceil((at - now) / 1000);
  const clock = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" }).format(new Date(at));
  // The ticking text is hidden from screen readers (it sits in an alert); they get the time once instead.
  return <p className="cp-retry">
    <span aria-hidden="true">{left > 0 ? <>You can try again in <span className="cp-retry-time">{clockText(left)}</span>.</> : "You can try again now."}</span>
    <span className="cp-sr">You can try again at {clock}.</span>
  </p>;
}

function ErrorBox({ error, onSwitch }: { error: CallError; onSwitch: (channel: CallChannel) => void }) {
  return <div className={`cp-error ${error.limit ? "is-limit" : ""}`} role="alert">
    <p>{error.message}</p>
    {error.retryAt && <RetryCountdown at={error.retryAt} />}
    {(error.switchTo || error.reload || error.limit) && <div className="cp-error-actions">
      {error.switchTo === "web" && <button type="button" className="cp-link-btn" onClick={() => onSwitch("web")}>Talk in browser instead <span aria-hidden="true">→</span></button>}
      {error.switchTo === "phone" && <button type="button" className="cp-link-btn" onClick={() => onSwitch("phone")}>Use Call my phone <span aria-hidden="true">→</span></button>}
      {error.reload && <button type="button" className="cp-link-btn" onClick={() => window.location.reload()}>Reload the page</button>}
      {error.limit && !error.switchTo && <a className="cp-link-btn" href={routeHref.staff} onMouseEnter={prefetchStaffScreen}>Open the clinic staff screen <span aria-hidden="true">→</span></a>}
    </div>}
  </div>;
}

const webSteps = { microphone: "Allow the microphone…", loading: "Getting the voice line ready…", requesting: "Connecting you to Ava…", connecting: "Connecting you to Ava…" } as const;

function CallForm({ info, mode, onMode, onSwitch }: { info: DemoCallsInfo; mode: CallChannel; onMode: (mode: CallChannel) => void; onSwitch: (channel: CallChannel) => void }) {
  const controller = useCall();
  const available = useMemo(() => supportedCountries(info.countries), [info.countries]);
  const [country, setCountry] = useState<CallCountry>(() => defaultCountry(available));
  const [digits, setDigits] = useState("");
  const [rawOverride, setRawOverride] = useState<string | null>(null);
  const [unsupported, setUnsupported] = useState<string | null>(null);
  const [blurred, setBlurred] = useState(false);
  const [consentPhone, setConsentPhone] = useState(false);
  const [consentWeb, setConsentWeb] = useState(false);
  const [token, setToken] = useState("");
  const [checkError, setCheckError] = useState("");
  const [resetKey, setResetKey] = useState(0);
  const [nudge, setNudge] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const pendingCaret = useRef<number | null>(null);
  const appBrowser = useMemo(inAppBrowser, []);
  const webEnabled = info.web?.enabled !== false;
  const { starting, error, prefetchSdk } = controller;
  const busy = Boolean(starting);

  useEffect(() => { if (mode === "web") prefetchSdk(); }, [mode, prefetchSdk]);

  const formatted = formatLocalDigits(digits, country);
  const phone = composePhone(country, digits);
  const check = unsupported
    ? { problem: "Only US (+1) and Indian (+91) numbers can get a call. Talk in browser works from any country.", suggestion: undefined }
    : checkPhone(country, digits, blurred, available);
  const { problem, suggestion } = check;
  const indiaHint = deviceLooksIndian() && country === "US" && available.includes("IN");

  useLayoutEffect(() => {
    const input = inputRef.current;
    if (pendingCaret.current === null || !input || document.activeElement !== input) return;
    const position = caretAfterDigits(input.value, pendingCaret.current);
    input.setSelectionRange(position, position);
    pendingCaret.current = null;
  });

  function onPhoneInput(event: ChangeEvent<HTMLInputElement>) {
    const raw = event.target.value;
    const caret = event.target.selectionStart ?? raw.length;
    const entry = readPhoneEntry(raw, country, available);
    controller.clearError();
    if (entry.unsupported) { setUnsupported(entry.unsupported); setRawOverride(raw); setDigits(""); return; }
    setUnsupported(null);
    // "+", "+9" or "00" while typing: show what was typed until the country code is complete.
    const pending = entry.digits === "" && entry.country === country && /^\s*(\+|00)/.test(raw);
    setRawOverride(pending ? raw : null);
    if (pending) pendingCaret.current = null;
    else if (entry.country !== country) { setCountry(entry.country); pendingCaret.current = entry.digits.length; }
    else pendingCaret.current = Math.min(raw.slice(0, caret).replace(/\D/g, "").length, entry.digits.length);
    setDigits(entry.digits);
  }

  const consent = mode === "phone" ? consentPhone : consentWeb;
  const blockers: { reason: string; focus: string }[] = [];
  const problemShown = Boolean(problem && (blurred || unsupported || digits.length >= 10));

  function applySuggestion() {
    if (!suggestion) return;
    setCountry(suggestion.country);
    setDigits(suggestion.digits);
    setRawOverride(null);
    pendingCaret.current = suggestion.digits.length;
    inputRef.current?.focus();
  }
  if (mode === "phone" && !phone) blockers.push({ reason: problemShown ? "Check the phone number above." : digits ? "Finish typing your phone number." : "Enter your phone number.", focus: "phone-input" });
  if (mode === "web" && !webEnabled) blockers.push({ reason: "Browser calls are switched off right now. Call my phone still works.", focus: "mode-phone" });
  if (!consent) blockers.push({ reason: "Tick the box to agree to the call.", focus: `consent-${mode}` });
  if (!token) blockers.push({ reason: checkError || "Running a quick security check…", focus: "" });
  const ready = blockers.length === 0 && !busy;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (!ready) {
      setNudge(true);
      setBlurred(true);
      if (blockers[0]?.focus) document.getElementById(blockers[0].focus)?.focus();
      return;
    }
    setNudge(false);
    const used = token;
    // A security-check token works once: whatever happens, get a fresh one for the next attempt.
    setToken("");
    setResetKey((value) => value + 1);
    if (mode === "phone" && phone) await controller.startPhone({ phoneNumber: phone.e164, turnstileToken: used, country });
    else await controller.startWeb({ turnstileToken: used });
  }

  const ctaLabel = starting
    ? (starting.channel === "phone" ? "Requesting your call…" : webSteps[starting.step])
    : mode === "phone" ? (phone ? `Call ${phone.display}` : "Call me now") : "Start talking";

  return <form className="cp-form" onSubmit={submit} noValidate>
    <h2 className="cp-card-title">Talk to Ava now</h2>
    <ModeSwitch mode={mode} disabled={busy} onMode={(next) => { controller.clearError(); setNudge(false); onMode(next); }} prefetch={controller.prefetchSdk} />

    <div className="cp-mode-body">
      {mode === "phone" ? <>
        <label className="cp-label" htmlFor="phone-input">Your phone number</label>
        <div className={`cp-phone-field ${problemShown ? "is-invalid" : ""} ${phone ? "is-valid" : ""}`}>
          <label className="cp-country">
            <span className="cp-sr">Country</span>
            <span className="cp-country-face" aria-hidden="true"><span className="cp-flag">{countries[country].flag}</span>{countries[country].dial}<span className="cp-caret">▾</span></span>
            <select id="country-select" value={country} disabled={busy} onChange={(event) => { setCountry(event.target.value as CallCountry); setUnsupported(null); setRawOverride(null); inputRef.current?.focus(); }}>
              {available.map((code) => <option key={code} value={code}>{countries[code].flag} {countries[code].name} {countries[code].dial}</option>)}
            </select>
          </label>
          <input
            ref={inputRef} id="phone-input" type="tel" inputMode="tel" autoComplete="tel-national" maxLength={24}
            placeholder={countries[country].placeholder} value={rawOverride ?? formatted} disabled={busy}
            aria-invalid={problemShown} aria-describedby="phone-hint"
            onChange={onPhoneInput} onBlur={() => setBlurred(digits.length > 0)}
          />
        </div>
        <p id="phone-hint" className={`cp-hint ${problemShown ? "cp-hint-error" : phone ? "cp-hint-ok" : ""}`}>
          {problemShown ? problem : phone ? <>✓ We'll call {phone.display} in {countries[country].name === "United States" ? "the United States" : countries[country].name}</> : country === "IN" ? "10-digit Indian mobile (or paste a number with +1)" : "10-digit US number (or paste a number with +91)"}
        </p>
        {problemShown && suggestion && <button type="button" className="cp-link-btn cp-suggest" onClick={applySuggestion}>Did you mean {suggestion.display}?</button>}
        {unsupported && <button type="button" className="cp-link-btn" onClick={() => onSwitch("web")}>Talk in browser instead <span aria-hidden="true">→</span></button>}
        {indiaHint && <p className="cp-tip">Your device is set to India time. Calling an Indian number? <button type="button" className="cp-link-btn" onClick={() => { setCountry("IN"); setRawOverride(null); setUnsupported(null); inputRef.current?.focus(); }}>Switch to 🇮🇳 +91</button></p>}
        <label className="cp-check">
          <input type="checkbox" id="consent-phone" checked={consentPhone} disabled={busy} onChange={(event) => setConsentPhone(event.target.checked)} />
          <span>I agree to get one AI-generated demo call at this number. I won't share real health information.</span>
        </label>
      </> : <>
        <p className="cp-web-lead"><span className="cp-mic" aria-hidden="true" />Uses your microphone · works from any country</p>
        <p className="cp-hint">Best with headphones, in a quiet spot. Works in Chrome, Safari, Edge and Firefox.</p>
        {!webEnabled && <p className="cp-tip">Browser calls are switched off right now. <button type="button" className="cp-link-btn" onClick={() => onSwitch("phone")}>Use Call my phone</button></p>}
        {appBrowser && <p className="cp-tip">You're in the {appBrowser} app's browser, which often blocks the microphone. Open this page in Safari or Chrome to talk here — or use <button type="button" className="cp-link-btn" onClick={() => onSwitch("phone")}>Call my phone</button>.</p>}
        <label className="cp-check">
          <input type="checkbox" id="consent-web" checked={consentWeb} disabled={busy} onChange={(event) => setConsentWeb(event.target.checked)} />
          <span>I agree to talk with an AI voice agent and allow the microphone. I won't share real health information.</span>
        </label>
      </>}
    </div>

    <TurnstileWidget resetKey={resetKey} onToken={(value) => {
      setToken(value);
      if (!value) return;
      setCheckError("");
      // A fresh token replaces the one the server refused, so that refusal no longer applies.
      if (controller.error?.code === "verification_failed" || controller.error?.code === "verification_required") controller.clearError();
    }} onError={setCheckError} />
    {error && error.channel === mode && <ErrorBox error={error} onSwitch={onSwitch} />}

    <button type="submit" className={`cp-btn cp-btn-primary cp-btn-block cp-cta ${ready ? "" : "is-waiting"}`} aria-describedby="cta-reason" aria-busy={busy}>
      {busy && <span className="cp-spinner cp-spinner-light" aria-hidden="true" />}{ctaLabel}
    </button>
    <p id="cta-reason" className={`cp-cta-reason ${nudge && !ready ? "is-nudged" : ""}`}>
      {!busy && !ready ? blockers[0]?.reason : mode === "phone" ? `We'll call from ${info.fromNumber ?? "our US demo number"}.` : "Ava answers within a second or two of connecting."}
    </p>
  </form>;
}

function CallNotes({ mode, info }: { mode: CallChannel; info?: DemoCallsInfo }) {
  const { call } = useCall();
  if (!info?.enabled) return null;
  const phoneNote = mode === "phone" && !call;
  return <ul className="cp-notes">
    {phoneNote && <li>Calls come from {info.fromNumber ?? "a US number"} and may be labelled “Spam likely” — answer anyway. If it goes to voicemail, Ava hangs up.</li>}
    <li>Up to {info.maxMinutes ?? 5} minutes per call · 3 calls per connection in any 24 hours · {info.maxCallsPerDay ?? 10} demo calls a day across all visitors, renewed at {dailyResetLocalTime()} your time.</li>
  </ul>;
}

// ---------- during the call ----------

function VoiceOrb({ getLevel, reactive, muted }: { getLevel: () => number; reactive: boolean; muted: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (!reactive || reduced) { element.style.setProperty("--level", "0"); return; }
    let frame = 0;
    let smooth = 0;
    const tick = () => {
      const level = getLevel();
      smooth = level > smooth ? smooth * 0.55 + level * 0.45 : smooth * 0.88 + level * 0.12;
      element.style.setProperty("--level", smooth.toFixed(3));
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [getLevel, reactive]);
  return <div ref={ref} className={`cp-orb ${reactive ? "is-reactive" : "is-idle"} ${muted ? "is-muted" : ""}`} aria-hidden="true">
    <span className="cp-orb-halo" /><span className="cp-orb-ring" /><span className="cp-orb-core" />
  </div>;
}

function CallClock({ call }: { call: ActiveCall }) {
  const live = call.phase === "live" && Boolean(call.startedAt);
  const now = useTicker(1000, call.phase !== "ended");
  const total = call.maxMinutes * 60;
  if (!live || !call.startedAt) return <div className="cp-clock"><span className="cp-clock-main">0:00</span><span className="cp-clock-sub">up to {call.maxMinutes} minutes</span></div>;
  const elapsed = Math.max(0, (now - call.startedAt) / 1000);
  const left = Math.max(0, total - elapsed);
  return <div className="cp-clock">
    <span className="cp-clock-main" aria-label={`Call time ${clockText(elapsed)}`}>{clockText(elapsed)}</span>
    <span className={`cp-clock-sub ${left <= 60 ? "is-low" : ""}`}>{clockText(left)} left</span>
  </div>;
}

function LastMinute({ call }: { call: ActiveCall }) {
  const now = useTicker(1000, call.phase === "live");
  if (call.phase !== "live" || !call.startedAt) return null;
  const left = call.maxMinutes * 60 - (now - call.startedAt) / 1000;
  if (left > 60 || left <= 0) return null;
  return <p className="cp-last-minute" role="status">1 minute left — Ava will wrap up soon.</p>;
}

function phaseCopy(call: ActiveCall): { label: string; title: string; sub?: string } {
  const from = call.fromNumber ?? "our demo number";
  if (call.channel === "phone") {
    switch (call.phase) {
      case "ringing": return { label: "Calling", title: `Calling ${call.maskedNumber ?? "your phone"}…`, sub: `Answer the call from ${from}.` };
      case "live": return { label: "On the call", title: "On the call with Ava", sub: "Talk normally — she'll confirm before changing anything." };
      case "unknown": return { label: "No answer yet", title: "We couldn't confirm the call", sub: "If your phone rings, pick up. If it didn't ring, you can talk in the browser instead." };
      default: return { label: "Wrapping up", title: "Call ended · getting your summary…" };
    }
  }
  switch (call.phase) {
    case "connecting": return { label: "Connecting", title: call.restored ? "Checking your browser call…" : "Connecting you to Ava…", sub: call.restored ? "Reloading the page ended the browser call." : "Ava will greet you as soon as the audio connects." };
    case "live": return call.muted
      ? { label: "Muted", title: "You're muted — Ava can't hear you", sub: "Unmute to keep talking." }
      : { label: "Live", title: "You're talking with Ava", sub: "Talk normally — she'll confirm before changing anything." };
    default: return { label: "Wrapping up", title: "Call ended · getting your summary…", sub: call.restored ? "Reloading the page ended the browser call." : undefined };
  }
}

function LivePanel({ call, onSwitch }: { call: ActiveCall; onSwitch: (channel: CallChannel) => void }) {
  const controller = useCall();
  const { state } = useDemo();
  const viewerZone = useMemo(viewerTimezone, []);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const copy = phaseCopy(call);
  const since = call.serverPlacedAt ?? call.placedAt - 5_000;
  const changes = useMemo(() => (state ? callChanges(state, since, viewerZone) : []), [state, since, viewerZone]);
  const connected = call.channel === "web" && (call.phase === "live" || call.phase === "connecting") && !call.restored;
  const talkingHere = call.channel === "web" && call.phase === "live" && !call.restored;

  useEffect(() => { if (!call.restored) titleRef.current?.focus({ preventScroll: true }); }, [call.restored]);

  return <div className="cp-live">
    <div className="cp-live-stage">
      <div className="cp-live-top">
        <span className={`cp-phase cp-phase-${call.phase}`}><span className="cp-phase-dot" aria-hidden="true" />{copy.label}</span>
        <CallClock call={call} />
      </div>
      <VoiceOrb getLevel={controller.getLevel} reactive={call.channel === "web" && call.phase === "live" && !call.restored} muted={call.muted} />
      <div className="cp-live-text" role="status" aria-live="polite">
        <h2 className="cp-live-title" ref={titleRef} tabIndex={-1}>{copy.title}</h2>
        {copy.sub && <p className="cp-live-sub">{copy.sub}</p>}
      </div>
      <LastMinute call={call} />
      {connected && <div className="cp-live-controls">
        <button type="button" className={`cp-round ${call.muted ? "is-on" : ""}`} aria-pressed={call.muted} disabled={call.phase !== "live"} onClick={controller.toggleMute}>
          <span aria-hidden="true">{call.muted ? "🔇" : "🎙"}</span>{call.muted ? "Unmute" : "Mute"}
        </button>
        <button type="button" className="cp-round cp-round-end" onClick={controller.endWebCall}><span aria-hidden="true">✕</span>{call.phase === "live" ? "End call" : "Cancel"}</button>
      </div>}
      {call.phase === "unknown" && <UnansweredActions call={call} onSwitch={onSwitch} />}
    </div>
    <div className="cp-live-feed">
      <ChangeFeed changes={changes} live />
      <UnderTheHood tools={call.tools} />
      <p className="cp-live-hint"><span aria-hidden="true">↗</span> Changes appear on the <a href={routeHref.staff} onMouseEnter={prefetchStaffScreen}>clinic staff screen</a> as you talk{talkingHere ? " — your call keeps going if you open it" : ""}.</p>
    </div>
  </div>;
}

/** A phone call nobody saw start. The server keeps it "in progress" for 120 s, so the switch waits until then. */
function UnansweredActions({ call, onSwitch }: { call: ActiveCall; onSwitch: (channel: CallChannel) => void }) {
  const controller = useCall();
  const now = useTicker(1000);
  const allowed = canStartAnother(call, now);
  const wait = Math.max(0, Math.ceil((call.placedAt + unansweredReleaseMs - now) / 1000));
  return <div className="cp-live-controls cp-unanswered">
    <button type="button" className="cp-btn cp-btn-light" disabled={!allowed} aria-describedby="unanswered-wait" onClick={() => onSwitch("web")}>Talk in browser instead</button>
    {allowed && <button type="button" className="cp-btn cp-btn-ghost" onClick={controller.dismiss}>Try calling again</button>}
    <p id="unanswered-wait" className="cp-unanswered-wait">{allowed ? "Your last call no longer blocks a new one." : `Available in ${clockText(wait)}, once the line has closed.`}</p>
  </div>;
}

function ChangeRow({ change }: { change: CallChange }) {
  return <li className={`cp-change cp-tone-${change.tone}`}>
    <span className="cp-change-icon" aria-hidden="true">{change.icon}</span>
    <div className="cp-change-body">
      <p className="cp-change-head"><strong>{change.verb}</strong>{change.patient && <> · {change.patient}</>}{change.reference && <span className="cp-ref">{change.reference}</span>}</p>
      {(change.detail || change.when) && <p className="cp-change-meta">{[change.detail, change.when].filter(Boolean).join(" · ")}{change.whenLocal && <span className="cp-local-time"> ({change.whenLocal})</span>}</p>}
    </div>
  </li>;
}

function ChangeFeed({ changes, live }: { changes: CallChange[]; live?: boolean }) {
  const ordered = live ? [...changes].reverse() : changes;
  return <section className="cp-feed" aria-labelledby={live ? "feed-live-title" : "feed-summary-title"}>
    <h3 className="cp-feed-title" id={live ? "feed-live-title" : "feed-summary-title"}>{live ? "What Ava just did" : "Changes"}</h3>
    {live && changes.length === 0 && <p className="cp-feed-empty">Bookings and requests appear here the moment Ava makes them.</p>}
    {/* Always rendered during a call, so the first change is announced. */}
    <ol className={`cp-change-list ${changes.length === 0 ? "is-empty" : ""}`} aria-live={live ? "polite" : undefined} aria-relevant={live ? "additions" : undefined}>
      {ordered.map((change) => <ChangeRow key={change.id} change={change} />)}
    </ol>
  </section>;
}

function UnderTheHood({ tools }: { tools: ToolTiming[] }) {
  if (tools.length === 0) return null;
  return <details className="cp-hood">
    <summary>Under the hood <span className="cp-hood-count">{tools.length} tool call{tools.length === 1 ? "" : "s"}</span></summary>
    <ol className="cp-hood-list">{tools.map((tool, index) => <li key={`${tool.tool}-${index}`}>
      <code>{tool.tool}</code><span className="cp-hood-ms">{Math.round(tool.ms)} ms</span><span className={tool.ok ? "cp-hood-ok" : "cp-hood-fail"}>{tool.ok ? "ok" : "failed"}</span>
    </li>)}</ol>
  </details>;
}

// ---------- after the call ----------

function outcomeNote(call: ActiveCall): { tone: "info" | "warn"; text: string; switchTo?: CallChannel } | null {
  switch (call.outcome) {
    case "no_answer": return call.channel === "phone"
      ? { tone: "info", text: "The call wasn't answered. It may have been labelled “Spam likely”, silenced, or sent to voicemail — Ava hangs up on voicemail.", switchTo: "web" }
      : { tone: "info", text: "Ava couldn't reach your browser. Check the microphone and connection, then try again." };
    case "blocked": return call.country === "IN"
      ? { tone: "warn", text: "Calls to Indian numbers aren't getting through on this demo's phone line yet. Talk to Ava in your browser instead — it works from any country.", switchTo: "web" }
      : { tone: "warn", text: "The phone network blocked this call. Talk to Ava in your browser instead.", switchTo: "web" };
    case "time_limit": return { tone: "info", text: `The call reached the ${call.maxMinutes}-minute limit, so Ava wrapped up.` };
    case "error": return { tone: "warn", text: "The call dropped because of a technical problem. Anything Ava confirmed before that is saved." };
    default: return null;
  }
}

function SummaryPanel({ call, onSwitch }: { call: ActiveCall; onSwitch: (channel: CallChannel) => void }) {
  const controller = useCall();
  const { state } = useDemo();
  const viewerZone = useMemo(viewerTimezone, []);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const since = call.serverPlacedAt ?? call.placedAt - 5_000;
  const changes = useMemo(() => (state ? callChanges(state, since, viewerZone) : []), [state, since, viewerZone]);
  const note = call.notStarted
    ? { tone: "info" as const, text: "Leaving or reloading the page ends a browser call before it connects. Nothing changed in your demo clinic.", switchTo: undefined }
    : outcomeNote(call);
  const talked = call.startedAt && call.endedAt ? clockText((call.endedAt - call.startedAt) / 1000) : null;
  const cooldownUntil = call.channel === "phone" ? new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(new Date(call.placedAt + 30 * 60_000)) : null;

  useEffect(() => { if (!call.restored) headingRef.current?.focus({ preventScroll: true }); }, [call.restored]);

  return <div className="cp-summary">
    <p className="cp-summary-kicker"><span className="cp-phase-dot" aria-hidden="true" />Call ended{talked ? ` · ${talked}` : ""}</p>
    <h2 className="cp-card-title" ref={headingRef} tabIndex={-1}>{changes.length ? "Here's what Ava did" : call.notStarted ? "Your browser call didn't start" : "No changes were made"}</h2>
    {note && <div className={`cp-note cp-note-${note.tone}`}>
      <p>{note.text}</p>
      {note.switchTo === "web" && <button type="button" className="cp-link-btn" onClick={() => onSwitch("web")}>Talk in browser instead <span aria-hidden="true">→</span></button>}
    </div>}
    {changes.length > 0
      ? <ol className="cp-change-list cp-summary-list">{changes.map((change) => <ChangeRow key={change.id} change={change} />)}</ol>
      : call.notStarted
        ? <p className="cp-summary-tip">Browser calls run inside this tab, so keep it open until you hang up. You can visit the staff screen during the call — it opens in the same tab without ending it.</p>
        : <div className="cp-summary-empty">
          <p>{call.outcome === "completed" || !call.outcome ? "Nothing in the clinic changed on this call. Next time, try:" : "Next time, try:"}</p>
          <ul><li>“What are your hours?”</li><li>“I'd like to book a new-patient visit next week.”</li></ul>
        </div>}
    <UnderTheHood tools={call.tools} />
    {call.notStarted
      ? <div className="cp-summary-actions">
          <button type="button" className="cp-btn cp-btn-primary cp-btn-block" onClick={() => onSwitch("web")}>Start again</button>
          <a className="cp-btn cp-btn-secondary cp-btn-block" href={routeHref.staff} onMouseEnter={prefetchStaffScreen}>Open the clinic staff screen</a>
        </div>
      : <div className="cp-summary-actions">
          <a className="cp-btn cp-btn-primary cp-btn-block" href={routeHref.staff} onMouseEnter={prefetchStaffScreen}>Open the clinic staff screen <span aria-hidden="true">→</span></a>
          <button type="button" className="cp-btn cp-btn-secondary cp-btn-block" onClick={controller.dismiss}>Call again</button>
        </div>}
    {cooldownUntil && <p className="cp-summary-foot">The same number can get another call after {cooldownUntil}. Talk in browser works any time within the call limits.</p>}
  </div>;
}

// ---------- supporting sections ----------

function TrySaying({ groups }: { groups: { title: string; lines: string[] }[] }) {
  return <section className="cp-try" aria-labelledby="try-title">
    <div className="cp-section-head">
      <h2 id="try-title" className="cp-h2">Try saying</h2>
      <p>Made-up details are fine. Ava can book, move, cancel and confirm visits, add you to the waitlist, and pass requests to the front desk.</p>
    </div>
    <div className="cp-try-grid">
      {groups.map((group) => <div className="cp-try-group" key={group.title}>
        <h3>{group.title}</h3>
        <ul>{group.lines.map((line) => <li key={line}>{line}</li>)}</ul>
      </div>)}
    </div>
    <p className="cp-wont"><span className="cp-wont-label">Won't do</span>Medical advice, diagnoses or real records — she'll pass anything clinical to staff.</p>
  </section>;
}

function HowItWorks() {
  const steps = [
    { title: "You talk", text: "On your phone or in the browser. Ask the way you'd ask a real front desk." },
    { title: "Ava follows the clinic's rules", text: "She checks openings, double-bookings and opening hours with the same scheduling rules the staff screen uses, and confirms before every change." },
    { title: "The staff screen updates", text: "Bookings, waitlist requests and follow-ups land in your private demo clinic within seconds." },
  ];
  return <section className="cp-how" aria-labelledby="how-title">
    <h2 id="how-title" className="cp-h2">How it works</h2>
    <ol className="cp-steps">{steps.map((step, index) => <li key={step.title}>
      <span className="cp-step-n" aria-hidden="true">{index + 1}</span>
      <h3>{step.title}</h3>
      <p>{step.text}</p>
    </li>)}</ol>
    <div className="cp-credits">
      <p className="cp-stack"><span>Retell voice agent</span><span>Cloudflare Worker</span><span>Supabase</span><span>React</span></p>
      <p className="cp-builder">Built by Parshva Karani · <a href={githubUrl} target="_blank" rel="noreferrer">Source on GitHub<span className="cp-sr"> (opens in a new tab)</span> <span aria-hidden="true">↗</span></a></p>
    </div>
  </section>;
}

function PrivacyNote() {
  const demo = useDemo();
  const { busy, dismiss } = useCall();
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [working, setWorking] = useState(false);
  const cloud = demo.connection === "cloud";

  async function remove() {
    if (busy) { setMessage({ tone: "error", text: "Your call is still running. End it first, then delete your demo data." }); return; }
    if (!window.confirm(cloud ? "Delete your private demo clinic now? Names and bookings from your calls are removed and a fresh sample clinic starts." : "Delete the demo copy kept in this browser?")) return;
    setWorking(true);
    setMessage(null);
    try {
      await demo.forget();
      dismiss();
      setMessage({ tone: "ok", text: cloud ? "Deleted. Your private demo is gone and a fresh sample clinic is ready." : "Deleted this browser's copy. A fresh sample clinic is ready." });
    } catch (reason) {
      const code = (reason as { code?: string }).code;
      setMessage({ tone: "error", text: code === "call_in_progress" ? "A call is still running for your demo. Try again once it has ended." : "Your demo data couldn't be deleted just now. Please try again." });
    } finally {
      setWorking(false);
    }
  }

  return <section className="cp-privacy" aria-labelledby="privacy-title">
    <span className="cp-privacy-icon" aria-hidden="true">◇</span>
    <div className="cp-privacy-body">
      <h2 id="privacy-title" className="cp-h3">Your data</h2>
      <p>Your phone number is never stored. Names you give are kept only in your private demo for {demo.retentionDays} days. Retell processes the call audio; this demo is set to keep no recordings or transcripts.</p>
      {demo.memoryOnly && <p className="cp-privacy-extra">This browser isn't saving site data, so your demo resets when you close this tab.</p>}
    </div>
    <div className="cp-privacy-action">
      <button type="button" className="cp-btn cp-btn-quiet" onClick={() => void remove()} disabled={working || demo.connection === "connecting"}>{working ? "Deleting…" : "Delete my demo data"}</button>
      {message && <p className={`cp-privacy-msg ${message.tone === "error" ? "is-error" : ""}`} role={message.tone === "error" ? "alert" : "status"}>{message.text}</p>}
    </div>
  </section>;
}
