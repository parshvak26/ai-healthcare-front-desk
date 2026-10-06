import { useEffect, useRef } from "react";

const scriptId = "cloudflare-turnstile-script";
const scriptUrl = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
/** Must match turnstileAction in apps/worker/src/calls.ts. */
export const turnstileAction = "healthcare_demo_call";

/**
 * Cloudflare Turnstile bot check. Usually passes invisibly; `onToken("")` means the token expired. A token works once,
 * so bump `resetKey` after every call request to get a fresh one.
 */
export function TurnstileWidget({ onToken, onError, resetKey }: { onToken: (token: string) => void; onError: (message: string) => void; resetKey: number }) {
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
        "error-callback": () => callbacks.current.onError("The security check could not finish. Please reload the page and try again."),
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
      script.addEventListener("error", () => callbacks.current.onError("The security check could not load. Check your connection, then reload the page."), { once: true });
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
