import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { normalizeDemoPhone } from "../../../packages/shared/src/index.ts";
import { ApiRequestError, requestDemoCall } from "./lib/api";
import type { DemoCallResponse, DemoCallsInfo } from "./lib/api";

const scriptId = "cloudflare-turnstile-script";
const scriptUrl = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
/** Must match turnstileAction in apps/worker/src/calls.ts. */
const turnstileAction = "healthcare_demo_call";

function TurnstileWidget({ onToken, onError, resetKey }: { onToken: (token: string) => void; onError: (message: string) => void; resetKey: number }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onToken, onError });
  callbacks.current = { onToken, onError };
  const siteKey = import.meta.env.VITE_TURNSTILE_SITE_KEY;

  useEffect(() => {
    if (!siteKey) { callbacks.current.onError("The security check is not configured for this website."); return; }
    let cancelled = false;
    let widgetId: string | null = null;
    const render = () => {
      if (cancelled || !containerRef.current || !window.turnstile) return;
      widgetId = window.turnstile.render(containerRef.current, {
        sitekey: siteKey,
        action: turnstileAction,
        theme: "light",
        size: "flexible",
        callback: (token) => callbacks.current.onToken(token),
        "expired-callback": () => callbacks.current.onToken(""),
        "error-callback": () => callbacks.current.onError("The security check could not finish. Please try again."),
      });
    };
    const existing = document.getElementById(scriptId);
    if (window.turnstile) render();
    else if (existing) existing.addEventListener("load", render, { once: true });
    else {
      const script = document.createElement("script");
      script.id = scriptId;
      script.src = scriptUrl;
      script.async = true;
      script.defer = true;
      script.addEventListener("load", render, { once: true });
      script.addEventListener("error", () => callbacks.current.onError("The security check could not load. Please try again."), { once: true });
      document.head.append(script);
    }
    const container = containerRef.current;
    return () => {
      cancelled = true;
      if (widgetId && window.turnstile) window.turnstile.remove(widgetId);
      container?.replaceChildren();
    };
  }, [siteKey, resetKey]);

  return <div className="turnstile-box" ref={containerRef} />;
}

type CallState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "calling"; result: DemoCallResponse }
  | { kind: "error"; message: string };

/** "Call me" form: one real AI demo call to a US or Indian number, after consent and a bot check. */
export function CallMePanel({ info, cloud, onCallPlaced }: { info?: DemoCallsInfo; cloud: boolean; onCallPlaced: () => void }) {
  const [phone, setPhone] = useState("");
  const [consent, setConsent] = useState(false);
  const [token, setToken] = useState("");
  const [resetKey, setResetKey] = useState(0);
  const [state, setState] = useState<CallState>({ kind: "idle" });
  const parsed = normalizeDemoPhone(phone);
  const available = cloud && info?.enabled;

  if (!available) {
    return <section className="call-me-card call-me-off">
      <div className="call-me-heading"><span className="call-me-icon">✆</span><div><strong>Get a real call from the AI front desk</strong><small>{cloud ? "Live demo calls are not switched on yet." : "Live calls need the shared cloud demo, which is not reachable right now."}</small></div></div>
    </section>;
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!parsed || !consent || !token) return;
    setState({ kind: "submitting" });
    try {
      const result = await requestDemoCall({ phoneNumber: parsed.e164, consent: true, turnstileToken: token });
      setState({ kind: "calling", result });
      onCallPlaced();
    } catch (error) {
      const message = error instanceof ApiRequestError
        ? (error.code === "network_error" ? "The call request did not get an answer. If your phone does not ring within a minute, please try again." : error.message)
        : "The call could not be requested. Please try again.";
      setState({ kind: "error", message });
    } finally {
      // A security-check token works once, so get a fresh one for any further attempt.
      setToken("");
      setResetKey((value) => value + 1);
    }
  }

  if (state.kind === "calling") {
    const { result } = state;
    return <section className="call-me-card call-me-success" role="status">
      <div className="call-me-heading"><span className="call-me-icon call-me-ringing">✆</span><div><strong>Calling {result.maskedNumber} now</strong><small>The call comes from {result.fromNumber} and lasts at most {result.maxMinutes} minutes.</small></div></div>
      <ul className="call-me-tips">
        <li>Use a sample name: Maya Patel, Jordan Lee, Samira Khan, Alex Morgan, or Taylor Reed.</li>
        <li>Try “Book a follow-up visit next Tuesday”, “Is there parking?”, or “Cancel DEMO-4812”.</li>
        <li>Don’t share real health information. Bookings you make appear on this page within seconds.</li>
      </ul>
      <button type="button" className="text-button" onClick={() => setState({ kind: "idle" })}>Request another call <span>→</span></button>
    </section>;
  }

  return <section className="call-me-card">
    <div className="call-me-heading"><span className="call-me-icon">✆</span><div><strong>Get a real call from the AI front desk</strong><small>One AI demo call from {info?.fromNumber} · up to {info?.maxMinutes ?? 5} minutes · US or India</small></div></div>
    <form onSubmit={submit}>
      <label className="form-label">Your phone number
        <input type="tel" inputMode="tel" autoComplete="tel" value={phone} maxLength={24} placeholder="+1 512 555 0100 or +91 98765 43210" aria-invalid={phone !== "" && !parsed} onChange={(event) => setPhone(event.target.value)} />
      </label>
      <small className="call-me-hint">{parsed ? `We will call ${parsed.display} (${parsed.country === "IN" ? "India" : "US"}).` : phone ? "Include the country code: +1 for a US number or +91 for an Indian mobile." : "Include the country code: +1 for the US or +91 for India."}</small>
      <label className="call-me-consent"><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} /><span>I agree to receive one AI-generated demo call at this number. This is a fictional clinic, so I won’t share real health information. This demo does not keep a recording or transcript.</span></label>
      <TurnstileWidget resetKey={resetKey} onToken={setToken} onError={(message) => setState({ kind: "error", message })} />
      {state.kind === "error" && <div className="call-me-error" role="alert">{state.message}</div>}
      <button type="submit" className="button button-primary full-button" disabled={!parsed || !consent || !token || state.kind === "submitting"}>
        {state.kind === "submitting" ? "Requesting the call…" : !token ? "Complete the security check" : "Call me"}
      </button>
    </form>
  </section>;
}
