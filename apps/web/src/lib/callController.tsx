// The call controller. It sits above the router, so moving to the staff screen never ends a browser call, and it owns
// everything about the one call a visitor can have at a time: starting it (phone or browser), following its status,
// mute/end, the 5-minute clock, the wake lock, and remembering it across reloads (localStorage) and tabs
// (BroadcastChannel). The summary itself is computed from the clinic state (see callInsights.ts).
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ApiRequestError, getCallStatus, releaseCall, requestDemoCall, toMillis } from "./api";
import type { CallCountry, CallOutcome, ToolTiming } from "./api";
import { broadcast, useDemo } from "./demoContext";
import { loadWebCallSdk, prefetchWebCallSdk, startWebCall } from "./webCall";
import type { WebCallHandle } from "./webCall";

export type CallChannel = "phone" | "web";
/** ending = the browser left the call and the summary is on its way. */
export type CallPhase = "ringing" | "connecting" | "live" | "ending" | "ended" | "unknown";

export interface ActiveCall {
  callRef: string;
  channel: CallChannel;
  phase: CallPhase;
  /** This device's clock when the call was requested. */
  placedAt: number;
  /** The server's clock when the call was placed (from the status endpoint); the change feed uses it. */
  serverPlacedAt?: number;
  /** This device's clock when the conversation started / ended. */
  startedAt?: number;
  endedAt?: number;
  outcome?: CallOutcome;
  maskedNumber?: string;
  fromNumber?: string;
  country?: CallCountry;
  maxMinutes: number;
  tools: ToolTiming[];
  muted: boolean;
  /** Restored after a reload: a browser call cannot continue, but its status and summary can. */
  restored?: boolean;
  /** A browser call that ended before it ever connected (for example, the page was reloaded while connecting). */
  notStarted?: boolean;
}

/** The server stops counting a call as "in progress" once it has gone this long without starting. */
export const unansweredReleaseMs = 120_000;

/** True when a new call may start: the last one ended, or never started and is past the server's 120 s window. */
export function canStartAnother(call: ActiveCall | null, now = Date.now()) {
  if (!call || call.phase === "ended") return true;
  return call.phase === "unknown" && !call.startedAt && now - call.placedAt >= unansweredReleaseMs;
}

export type StartStep = "requesting" | "microphone" | "loading" | "connecting";

export interface CallError {
  channel: CallChannel;
  code: string;
  message: string;
  /** Offer the other way of calling (a blocked Indian number → "Talk in browser"). */
  switchTo?: CallChannel;
  /** The page is out of date. */
  reload?: boolean;
  /** A limit or switch-off rather than a mistake: shown calmly, with a way to the staff screen. */
  limit?: boolean;
  /** When the server says a new call will be allowed (from Retry-After), for a live countdown. */
  retryAt?: number;
}

interface CallControllerValue {
  call: ActiveCall | null;
  starting: { channel: CallChannel; step: StartStep } | null;
  error: CallError | null;
  /** A call is starting or running (not yet ended). */
  busy: boolean;
  startPhone(input: { phoneNumber: string; turnstileToken: string; country: CallCountry }): Promise<boolean>;
  /** Must be called from the click handler: it asks for the microphone and unlocks audio inside the gesture. */
  startWeb(input: { turnstileToken: string }): Promise<boolean>;
  endWebCall(): void;
  toggleMute(): void;
  /** Clears an ended call (after the summary was seen) so a new one can start. */
  dismiss(): void;
  clearError(): void;
  /** Ava's current voice level (0–1) during a browser call. */
  getLevel(): number;
  prefetchSdk(): void;
}

const CallContext = createContext<CallControllerValue | null>(null);

export function useCall() {
  const value = useContext(CallContext);
  if (!value) throw new Error("useCall must be used inside <CallProvider>");
  return value;
}

// ---------- persistence ----------

const storageKey = "caredesk-active-call-v1";
const keepForMs = 15 * 60_000;

type StoredCall = Pick<ActiveCall, "callRef" | "channel" | "placedAt" | "serverPlacedAt" | "startedAt" | "endedAt" | "outcome" | "maskedNumber" | "fromNumber" | "country" | "maxMinutes" | "notStarted">;

function saveCall(call: ActiveCall | null) {
  try {
    if (!call) { localStorage.removeItem(storageKey); return; }
    const stored: StoredCall = {
      callRef: call.callRef, channel: call.channel, placedAt: call.placedAt, serverPlacedAt: call.serverPlacedAt, startedAt: call.startedAt,
      endedAt: call.phase === "ended" ? call.endedAt : undefined, outcome: call.phase === "ended" ? call.outcome : undefined,
      maskedNumber: call.maskedNumber, fromNumber: call.fromNumber, country: call.country, maxMinutes: call.maxMinutes,
      notStarted: call.phase === "ended" ? call.notStarted : undefined,
    };
    localStorage.setItem(storageKey, JSON.stringify(stored));
  } catch {
    // Without storage the call simply isn't restored after a reload.
  }
}

function loadCall(): ActiveCall | null {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return null;
    const stored = JSON.parse(raw) as Partial<StoredCall>;
    if (typeof stored.callRef !== "string" || !/^[\w-]{8,80}$/.test(stored.callRef) || (stored.channel !== "phone" && stored.channel !== "web")
      || typeof stored.placedAt !== "number" || Date.now() - stored.placedAt > keepForMs || stored.placedAt > Date.now() + 60_000) {
      localStorage.removeItem(storageKey);
      return null;
    }
    const ended = typeof stored.endedAt === "number";
    return {
      callRef: stored.callRef, channel: stored.channel, placedAt: stored.placedAt, serverPlacedAt: stored.serverPlacedAt, startedAt: stored.startedAt,
      endedAt: stored.endedAt, outcome: stored.outcome, maskedNumber: stored.maskedNumber, fromNumber: stored.fromNumber, country: stored.country,
      maxMinutes: typeof stored.maxMinutes === "number" ? stored.maxMinutes : 5, tools: [], muted: false, restored: true, notStarted: stored.notStarted === true,
      phase: ended ? "ended" : stored.channel === "web" ? (stored.startedAt ? "ending" : "connecting") : (stored.startedAt ? "live" : "ringing"),
    };
  } catch {
    return null;
  }
}

// ---------- friendly errors ----------

/** Daily limits reset at 00:00 UTC; shown in the visitor's own time. */
export function dailyResetLocalTime(now = Date.now()) {
  const next = new Date(now);
  next.setUTCHours(24, 0, 0, 0);
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(next);
}

function minutesText(seconds?: number) {
  if (!seconds) return "a little while";
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return minutes >= 90 ? `about ${Math.round(minutes / 60)} hours` : `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

/** "in 25 minutes (at 3:40 PM your time)", from the server's Retry-After. */
function retryText(seconds?: number) {
  if (!seconds) return "later";
  const at = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(new Date(Date.now() + seconds * 1000));
  return `in ${minutesText(seconds)} (at ${at} your time)`;
}

export function describeCallError(error: unknown, channel: CallChannel, country?: CallCountry): CallError {
  const other: CallChannel = channel === "phone" ? "web" : "phone";
  if (!(error instanceof ApiRequestError)) {
    return channel === "web"
      ? { channel, code: "connect_failed", switchTo: "phone", message: "Your browser couldn't connect to Ava. Some office and school networks block voice calls — try another network, or use Call my phone." }
      : { channel, code: "unknown", message: "The call could not be requested. Please try again." };
  }
  const base = { channel, code: error.code };
  switch (error.code) {
    case "reload_required": return { ...base, reload: true, message: "This page is out of date. Reload it to continue." };
    case "consent_required": return { ...base, message: "Tick the consent box first." };
    case "invalid_phone": return { ...base, message: "That number can't get a demo call. Check the digits: US numbers have 10, Indian mobiles 10 starting with 6–9." };
    case "verification_required":
    case "verification_failed": return { ...base, message: "The security check didn't go through. Wait for it to finish, then try again." };
    case "number_blocked":
    case "phone_suppressed": return { ...base, switchTo: "web", message: "This number can't get demo calls. You can still talk to Ava in your browser." };
    case "call_rejected": return country === "IN"
      ? { ...base, switchTo: "web", message: "Calls to Indian numbers aren't enabled on this demo's phone line yet. Talk to Ava in your browser instead — it works from any country." }
      : { ...base, switchTo: "web", message: "The phone line refused this number. Talk to Ava in your browser instead." };
    // Retry-After is when the server stops counting the last call as in progress, so it drives a countdown.
    case "call_in_progress": return error.retryAfterSeconds
      ? { ...base, limit: true, message: "Your last call is still closing.", retryAt: Date.now() + error.retryAfterSeconds * 1000 }
      : { ...base, limit: true, message: "Your last call is still closing — try again in a moment." };
    case "phone_cooldown": return { ...base, limit: true, switchTo: "web", message: `This number had a demo call recently. It can get another ${retryText(error.retryAfterSeconds)} — or talk in the browser now.` };
    case "ip_daily_limit": return { ...base, limit: true, message: `This connection has used its 3 demo calls for the last 24 hours. You can call again ${retryText(error.retryAfterSeconds)}. The staff screen still works in the meantime.` };
    case "daily_limit": return { ...base, limit: true, message: `Today's demo calls are all used up. They reset at ${dailyResetLocalTime()} your time. The staff screen still works in the meantime.` };
    case "demo_busy":
    case "demo_busy_creation": return { ...base, limit: true, message: `The demo is busy right now. Please try again in ${minutesText(error.retryAfterSeconds)}.` };
    case "demo_calls_off": return { ...base, limit: true, message: "Live calls are switched off right now. The clinic staff screen still works." };
    // The server explains this one (for example: "if your phone rings in the next minute, pick up").
    case "calls_unavailable": return { ...base, limit: true, message: error.message || "Calls aren't available right now. Please try again in a few minutes." };
    case "web_calls_off": return { ...base, limit: true, switchTo: "phone", message: "Browser calls are switched off right now. Try Call my phone instead." };
    case "network_error": return channel === "phone"
      ? { ...base, message: "The call request got no answer. If your phone doesn't ring within a minute, try again." }
      : { ...base, switchTo: other, message: "Couldn't reach the demo server. Check your connection and try again." };
    default: return { ...base, message: error.message || "The call could not be started. Please try again." };
  }
}

function describeMicError(error: unknown): CallError {
  const name = error instanceof DOMException || error instanceof Error ? error.name : "";
  const base = { channel: "web" as const, switchTo: "phone" as const };
  if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") {
    return { ...base, code: "mic_denied", message: "Microphone access is blocked. Allow it for this site (the icon in the address bar), then press Start talking again — or use Call my phone." };
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError" || name === "OverconstrainedError") {
    return { ...base, code: "no_mic", message: "No microphone was found. Connect one and try again — or use Call my phone." };
  }
  if (name === "NotReadableError" || name === "TrackStartError" || name === "AbortError") {
    return { ...base, code: "mic_busy", message: "Your microphone is busy in another app. Close that app and try again." };
  }
  if (name === "Unsupported") {
    return { ...base, code: "mic_unsupported", message: "This browser can't use the microphone here. Open the page in Safari or Chrome — or use Call my phone." };
  }
  return { ...base, code: "mic_failed", message: "The microphone couldn't start. Check your browser's microphone settings and try again." };
}

// ---------- provider ----------

const phaseRank: Record<CallPhase, number> = { ringing: 1, connecting: 1, unknown: 1, live: 2, ending: 3, ended: 4 };

type WakeLockSentinelLike = { release(): Promise<void>; addEventListener?: (type: "release", fn: () => void) => void };

export function CallProvider({ children }: { children: ReactNode }) {
  const demo = useDemo();
  const [call, setCallState] = useState<ActiveCall | null>(() => loadCall());
  const [starting, setStarting] = useState<{ channel: CallChannel; step: StartStep } | null>(null);
  const [error, setError] = useState<CallError | null>(null);
  const callRef = useRef<ActiveCall | null>(call);
  const handleRef = useRef<WebCallHandle | null>(null);
  const audioRef = useRef<AudioContext | null>(null);
  const cancelledRef = useRef(false);
  /** The browser call's transport ("gateway" or "livekit"), from the server's create-web-call answer. */
  const transportRef = useRef<"gateway" | "livekit" | null>(null);
  /** The call reference the restore check last ran for. */
  const restoreChecked = useRef<string | null>(null);
  /** Set by "pagehide": the page is going away, so a failing browser call is left for the next load to release. */
  const leavingRef = useRef(false);
  const { refresh, requestFastPoll } = demo;

  const setCall = useCallback((next: ActiveCall | null | ((current: ActiveCall | null) => ActiveCall | null)) => {
    const value = typeof next === "function" ? next(callRef.current) : next;
    callRef.current = value;
    setCallState(value);
    saveCall(value);
  }, []);

  /** Moves the call forward; never backwards (a slow status answer cannot undo "ended"). */
  const advance = useCallback((callRefId: string, patch: Partial<ActiveCall>) => {
    setCall((current) => {
      if (!current || current.callRef !== callRefId) return current;
      if (patch.phase && phaseRank[patch.phase] < phaseRank[current.phase]) {
        const rest = { ...patch };
        delete rest.phase;
        return { ...current, ...rest };
      }
      return { ...current, ...patch };
    });
  }, [setCall]);

  const closeAudio = useCallback(() => {
    const context = audioRef.current;
    audioRef.current = null;
    context?.close().catch(() => undefined);
  }, []);

  const keepFast = useCallback((ms = 20_000) => {
    const until = Date.now() + ms;
    requestFastPoll(until);
    broadcast({ type: "call-active", until });
  }, [requestFastPoll]);

  // Follow the call's status every 3 seconds until it has ended.
  const activeRef = call && call.phase !== "ended" ? call.callRef : null;
  useEffect(() => {
    if (!activeRef) return;
    let stopped = false;
    let failures = 0;
    const poll = async () => {
      const current = callRef.current;
      if (!current || current.callRef !== activeRef || current.phase === "ended") return;
      keepFast();
      try {
        const status = await getCallStatus(activeRef);
        if (stopped) return;
        failures = 0;
        const now = Date.now();
        const serverPlacedAt = toMillis(status.placedAt);
        // This device's clock may be off; server times are shifted by the offset seen at placement.
        const skew = serverPlacedAt !== undefined ? serverPlacedAt - current.placedAt : 0;
        const toLocal = (value: string | number | undefined) => { const ms = toMillis(value); return ms === undefined ? undefined : Math.min(now, ms - skew); };
        const patch: Partial<ActiveCall> = { tools: status.tools ?? current.tools, serverPlacedAt: serverPlacedAt ?? current.serverPlacedAt };
        if (status.maxMinutes) patch.maxMinutes = status.maxMinutes;
        if ((status.phase === "live" || status.phase === "ended") && status.startedAt && !current.startedAt) patch.startedAt = toLocal(status.startedAt);
        if (status.phase === "ended") {
          patch.phase = "ended";
          patch.outcome = status.outcome ?? "completed";
          patch.endedAt = current.endedAt ?? toLocal(status.endedAt) ?? now;
          if (current.channel === "web" && !current.startedAt && !patch.startedAt && !handleRef.current) patch.notStarted = true;
        } else if (status.phase === "live") {
          if (!current.startedAt && !patch.startedAt) patch.startedAt = now;
          // A browser call this tab is not connected to (it left, or the page was reloaded) is wrapping up.
          patch.phase = current.channel === "web" && !handleRef.current ? "ending" : "live";
        } else if (status.phase === "unknown") {
          if (current.channel === "phone") patch.phase = "unknown";
          // A browser call the server never saw start, and that this tab is not connecting: it is over.
          else if (!handleRef.current) Object.assign(patch, { phase: "ended", endedAt: current.endedAt ?? now, notStarted: !current.startedAt });
        }
        if (patch.phase === "ending" && !current.endedAt) patch.endedAt = now;
        // Stop waiting for an end event that is not coming: 25 s after the browser left, or well past the time limit.
        const overdue = now - current.placedAt > ((patch.maxMinutes ?? current.maxMinutes) * 60 + 150) * 1000;
        if (status.phase !== "ended" && ((current.phase === "ending" && current.endedAt && now - current.endedAt > 25_000) || overdue)) {
          patch.phase = "ended";
          patch.endedAt = current.endedAt ?? now;
        }
        advance(activeRef, patch);
        if (patch.phase === "ended") { void refresh(); keepFast(12_000); }
      } catch (reason) {
        if (stopped) return;
        if (reason instanceof ApiRequestError && reason.status === 404) { setCall(null); return; }
        failures += 1;
        // After two minutes without any answer, show what we have.
        if (failures >= 40) advance(activeRef, { phase: "ended", endedAt: Date.now() });
      }
    };
    void poll();
    const timer = window.setInterval(() => { void poll(); }, 3_000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [activeRef, advance, keepFast, refresh, setCall]);

  // After a reload, a browser call that never connected cannot be joined again: release it (it stops blocking a new
  // call at once) and show "Start again". If the server refuses because the call did start, keep following it.
  const restoredRef = call?.restored ? call.callRef : null;
  useEffect(() => {
    const current = callRef.current;
    if (!restoredRef || restoreChecked.current === restoredRef || !current || current.channel !== "web" || current.startedAt || current.phase === "ended") return;
    restoreChecked.current = restoredRef;
    releaseCall(current.callRef)
      .then((result) => { if (result.released) advance(current.callRef, { phase: "ended", endedAt: Date.now(), notStarted: true }); })
      .catch(() => undefined);
  }, [advance, restoredRef]);

  // Keep the screen awake while talking in the browser (mobile screens lock and cut the audio otherwise).
  const wakeWanted = Boolean(call && call.channel === "web" && call.phase === "live" && handleRef.current);
  useEffect(() => {
    if (!wakeWanted) return;
    const nav = navigator as Navigator & { wakeLock?: { request(type: "screen"): Promise<WakeLockSentinelLike> } };
    if (!nav.wakeLock) return;
    let sentinel: WakeLockSentinelLike | null = null;
    let done = false;
    const acquire = () => {
      if (done || document.visibilityState !== "visible") return;
      nav.wakeLock!.request("screen").then((lock) => { if (done) void lock.release().catch(() => undefined); else sentinel = lock; }).catch(() => undefined);
    };
    acquire();
    document.addEventListener("visibilitychange", acquire);
    return () => { done = true; document.removeEventListener("visibilitychange", acquire); void sentinel?.release().catch(() => undefined); };
  }, [wakeWanted]);

  // Leaving the page always ends a browser call, explicitly, whatever the transport (a call left open would keep
  // running, and costing money, until Retell noticed). "pagehide" also fires when the page enters the back/forward
  // cache, where the audio would stop anyway.
  // A call that has not connected yet is released with a keepalive request, and its stored record is kept so the next
  // load (a reload) can confirm the release and offer "Start again".
  useEffect(() => {
    const onHide = () => {
      leavingRef.current = true;
      const current = callRef.current;
      if (handleRef.current && current?.channel === "web" && !current.startedAt && current.phase !== "ended") {
        void releaseCall(current.callRef, { keepalive: true }).catch(() => undefined);
      }
      handleRef.current?.end();
    };
    // Back from the back/forward cache: the call ended when the page was hidden; follow it as after a reload.
    const onShow = (event: PageTransitionEvent) => {
      if (!event.persisted || !leavingRef.current) return;
      leavingRef.current = false;
      setCall((current) => (current && current.phase !== "ended" ? { ...current, restored: true } : current));
    };
    window.addEventListener("pagehide", onHide);
    window.addEventListener("pageshow", onShow);
    return () => { window.removeEventListener("pagehide", onHide); window.removeEventListener("pageshow", onShow); };
  }, [setCall]);

  // Ask before leaving only where "Stay" can actually save the call: livekit-client disconnects by itself on
  // beforeunload, so the prompt is shown for the gateway (WebRTC) transport only.
  const webLive = Boolean(call && call.channel === "web" && (call.phase === "live" || call.phase === "connecting") && handleRef.current);
  useEffect(() => {
    if (!webLive || transportRef.current !== "gateway") return;
    const onLeave = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", onLeave);
    return () => window.removeEventListener("beforeunload", onLeave);
  }, [webLive]);

  const busy = Boolean(starting || !canStartAnother(call));

  const startPhone = useCallback(async ({ phoneNumber, turnstileToken, country }: { phoneNumber: string; turnstileToken: string; country: CallCountry }) => {
    if (starting || !canStartAnother(callRef.current)) return false;
    setError(null);
    setStarting({ channel: "phone", step: "requesting" });
    try {
      const placed = await requestDemoCall({ phoneNumber, turnstileToken });
      setCall({
        callRef: placed.callRef, channel: "phone", phase: "ringing", placedAt: Date.now(), maskedNumber: placed.maskedNumber,
        fromNumber: placed.fromNumber, country: placed.country ?? country, maxMinutes: placed.maxMinutes || 5, tools: [], muted: false,
      });
      keepFast();
      return true;
    } catch (reason) {
      setError(describeCallError(reason, "phone", country));
      return false;
    } finally {
      setStarting(null);
    }
  }, [keepFast, setCall, starting]);

  const startWeb = useCallback(async ({ turnstileToken }: { turnstileToken: string }) => {
    if (starting || !canStartAnother(callRef.current)) return false;
    // Inside the click: the microphone prompt and the audio unlock both need the user's gesture.
    const media = navigator.mediaDevices;
    const micRequest: Promise<MediaStream> = media?.getUserMedia
      ? media.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
      : Promise.reject(Object.assign(new Error("No microphone API"), { name: "Unsupported" }));
    try {
      const Context = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (Context) { const context = new Context(); audioRef.current = context; void context.resume().catch(() => undefined); }
    } catch { /* audio unlock is best effort */ }
    const sdkRequest = loadWebCallSdk();
    sdkRequest.catch(() => undefined);
    cancelledRef.current = false;
    setError(null);
    setStarting({ channel: "web", step: "microphone" });

    let stream: MediaStream | null = null;
    const stopMic = () => { stream?.getTracks().forEach((track) => track.stop()); stream = null; };
    try {
      stream = await micRequest;
    } catch (reason) {
      closeAudio();
      setStarting(null);
      setError(describeMicError(reason));
      return false;
    }
    setStarting({ channel: "web", step: "loading" });
    let sdk: Awaited<typeof sdkRequest>;
    try {
      sdk = await sdkRequest;
    } catch {
      stopMic(); closeAudio(); setStarting(null);
      setError({ channel: "web", code: "sdk_failed", message: "The voice component didn't load. Check your connection and try again." });
      return false;
    }
    setStarting({ channel: "web", step: "requesting" });
    let created: string | null = null;
    const handle = startWebCall(sdk, {
      turnstileToken,
      events: {
        onCreated: (response) => {
          created = response.callRef;
          // The SDK falls back to LiveKit when the server names no transport.
          transportRef.current = response.transport ?? "livekit";
          setStarting(null);
          setCall({ callRef: response.callRef, channel: "web", phase: "connecting", placedAt: Date.now(), maxMinutes: response.maxMinutes || 5, tools: [], muted: false });
          keepFast();
        },
        onLive: () => {
          // The SDK holds its own microphone track now.
          stopMic();
          if (created) advance(created, { phase: "live", startedAt: callRef.current?.startedAt ?? Date.now() });
          keepFast();
        },
        onEnded: () => {
          handleRef.current = null;
          closeAudio();
          if (created) advance(created, { phase: "ending", endedAt: Date.now() });
          keepFast();
        },
      },
    });
    handleRef.current = handle;
    try {
      await handle.ready;
      return true;
    } catch (reason) {
      stopMic(); closeAudio();
      handleRef.current = null;
      // The page is unloading (pagehide ended the call): keep the stored call for the next load to release, and show
      // nothing.
      if (leavingRef.current) return false;
      setStarting(null);
      if (created) {
        void releaseCall(created).catch(() => undefined);
        const ref = created;
        setCall((current) => (current?.callRef === ref ? null : current));
      }
      if (!cancelledRef.current) setError(describeCallError(reason, "web"));
      return false;
    }
  }, [advance, closeAudio, keepFast, setCall, starting]);

  const endWebCall = useCallback(() => {
    const handle = handleRef.current;
    if (!handle) return;
    if (callRef.current?.phase !== "live") cancelledRef.current = true;
    handle.end();
  }, []);

  const toggleMute = useCallback(() => {
    const handle = handleRef.current;
    const current = callRef.current;
    if (!handle || !current) return;
    if (current.muted) handle.unmute(); else handle.mute();
    handle.resumeAudio();
    setCall({ ...current, muted: !current.muted });
  }, [setCall]);

  /** Clears an ended call, or an unanswered phone call once the server no longer counts it as in progress. */
  const dismiss = useCallback(() => {
    if (!canStartAnother(callRef.current)) return;
    setCall(null);
    setError(null);
  }, [setCall]);

  const clearError = useCallback(() => setError(null), []);
  const getLevel = useCallback(() => handleRef.current?.level() ?? 0, []);

  // A browser call ends with the page; tidy up if this provider ever unmounts.
  useEffect(() => () => { handleRef.current?.end(); }, []);

  const value = useMemo<CallControllerValue>(() => ({
    call, starting, error, busy, startPhone, startWeb, endWebCall, toggleMute, dismiss, clearError, getLevel, prefetchSdk: prefetchWebCallSdk,
  }), [call, starting, error, busy, startPhone, startWeb, endWebCall, toggleMute, dismiss, clearError, getLevel]);

  return <CallContext.Provider value={value}>{children}</CallContext.Provider>;
}
