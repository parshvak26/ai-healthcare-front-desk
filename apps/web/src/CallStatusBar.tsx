// A compact "call in progress" bar for the staff screen. The call itself is owned by the controller above the router,
// so a browser call keeps going while the visitor watches the clinic update.
import { useCall } from "./lib/callController";
import { clockText, useTicker } from "./lib/clock";
import { routeHref } from "./lib/routes";

export function CallStatusBar() {
  const { call, toggleMute, endWebCall } = useCall();
  const now = useTicker(1000, Boolean(call && call.phase === "live"));
  if (!call || call.phase === "ended") return null;
  const web = call.channel === "web";
  const controllable = web && call.phase === "live" && !call.restored;
  const label = call.phase === "live"
    ? (web ? (call.muted ? "Browser call · muted" : "Browser call with Ava") : "Phone call with Ava")
    : call.phase === "ringing" ? `Calling ${call.maskedNumber ?? "your phone"}…`
      : call.phase === "connecting" ? "Connecting to Ava…"
        : call.phase === "unknown" ? "Waiting for your phone call…" : "Call ended · getting your summary…";
  return <div className="cp-callbar" role="region" aria-label="Call in progress">
    <span className={`cp-callbar-dot ${call.phase === "live" ? "is-live" : ""}`} aria-hidden="true" />
    <span className="cp-callbar-label" role="status">{label}</span>
    {call.phase === "live" && call.startedAt && <span className="cp-callbar-time">{clockText((now - call.startedAt) / 1000)}</span>}
    <span className="cp-callbar-hint">Changes appear here within seconds.</span>
    <span className="cp-callbar-actions">
      {controllable && <button type="button" aria-pressed={call.muted} onClick={toggleMute}>{call.muted ? "Unmute" : "Mute"}</button>}
      {controllable && <button type="button" className="is-end" onClick={endWebCall}>End call</button>}
      <a href={routeHref.call}>Back to the call <span aria-hidden="true">→</span></a>
    </span>
  </div>;
}
