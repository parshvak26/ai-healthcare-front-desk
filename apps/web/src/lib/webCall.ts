// Browser ("Talk in browser") calls with retell-client-js-sdk 3.x.
//
// Which SDK API, and why: our Worker creates the web call (POST /api/demo-web-call checks consent, Turnstile and the
// shared call budget, then calls Retell's /v3/create-web-call with the agent, metadata and per-call context), so the
// browser must join a call whose access token it did not mint. The SDK offers two ways:
//   1. `new RetellWebClient().startCall({ accessToken, ... })`: media only, but deprecated in 3.x and removed in 4.0.
//   2. `new RetellClient({ fetch }).createWebCall(...)`: the current API. Its documented `fetch` option routes the
//      control request through your own backend. We use this one: our `fetch` adapter answers the SDK's
//      /v3/create-web-call request with our Worker's response (renamed to Retell's field names), so the SDK then
//      joins the call straight away with the server-issued token, transport and ICE servers. The `key` and the
//      request body the SDK builds are never sent anywhere. The only other control request a web call can make is
//      /v2/stop-call (when the session is ended while the create request is in flight); the adapter turns that into
//      POST /api/demo-call/release, so a call nobody joined stops blocking a new one straight away.
// The SDK pulls in livekit-client, so it is loaded with a dynamic import (its own chunk) and prefetched when the
// visitor opens the "Talk in browser" tab. Without `transcript: true` (which needs a secret-scoped key) the session
// reports status, end and errors only; the voice-level orb uses the SDK's analyser (`emitRawAudioSamples`).
import { releaseCall, requestWebCall } from "./api";
import type { WebCallResponse } from "./api";

type RetellSdk = typeof import("retell-client-js-sdk");

let sdkPromise: Promise<RetellSdk> | null = null;

/** Loads the SDK chunk once. A failed load is forgotten so the next attempt retries. */
export function loadWebCallSdk(): Promise<RetellSdk> {
  if (!sdkPromise) {
    sdkPromise = import("retell-client-js-sdk").catch((error: unknown) => {
      sdkPromise = null;
      throw error;
    });
  }
  return sdkPromise;
}

/** Starts downloading the SDK in the background (when the browser tab is shown). */
export function prefetchWebCallSdk() {
  loadWebCallSdk().catch(() => { /* retried on click */ });
}

export interface WebCallEvents {
  /** The Worker created the call; from now on the call counts and has a reference. */
  onCreated(created: WebCallResponse): void;
  /** Audio is connected and Ava can hear the visitor. */
  onLive(): void;
  /** The call ended after it was live (either side hung up, or the connection dropped). */
  onEnded(): void;
}

export interface WebCallHandle {
  /** Resolves when the call is live. Rejects with the reason when it fails or is ended before that. */
  ready: Promise<void>;
  mute(): void;
  unmute(): void;
  end(): void;
  /** Ava's current voice level, roughly 0–1. */
  level(): number;
  /** Retries audio playback a browser blocked (call from a click, e.g. Mute/Unmute). */
  resumeAudio(): void;
}

/** Rough voice level: both transports' analysers report an RMS around 0.02–0.3 while someone speaks. */
const scaleLevel = (rms: number) => (Number.isFinite(rms) ? Math.max(0, Math.min(1, rms * 3.2)) : 0);

export function startWebCall(sdk: RetellSdk, options: { turnstileToken: string; events: WebCallEvents }): WebCallHandle {
  if (import.meta.env.DEV && typeof window !== "undefined" && window.__caredeskFakeWebCall) {
    return startFakeWebCall(window.__caredeskFakeWebCall, options);
  }
  let callRef: string | null = null;
  const adapter = async (input: RequestInfo | URL): Promise<Response> => {
    const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
    if (path === "/v3/create-web-call") {
      // Throws ApiRequestError (limits, security check, calls off…); the SDK passes it to `ready` unchanged.
      const created = await requestWebCall({ turnstileToken: options.turnstileToken });
      callRef = created.callRef;
      options.events.onCreated(created);
      return new Response(JSON.stringify({
        call_id: created.callId,
        access_token: created.accessToken,
        transport: created.transport,
        ice_servers: created.iceServers,
      }), { status: 201, headers: { "Content-Type": "application/json" } });
    }
    if (path.startsWith("/v2/stop-call/")) {
      if (callRef) await releaseCall(callRef).catch(() => undefined);
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected voice control request: ${path}`);
  };

  const client = new sdk.RetellClient({ key: "issued-by-the-demo-server", fetch: adapter as typeof fetch });
  let live = false;
  const session = client.createWebCall({
    // Required by the request type, but the adapter above discards the body: the Worker picks the agent and version.
    agent_id: "chosen-by-the-demo-server",
    audio: { emitRawAudioSamples: true },
    hooks: {
      onStatus: (status) => {
        if (status === "live" && !live) {
          live = true;
          // Best effort: the click that started the call may be a few seconds old by now (microphone prompt).
          session.startAudioPlayback().catch(() => undefined);
          options.events.onLive();
        }
        if (status === "ended" && live) options.events.onEnded();
      },
      // Non-fatal errors arrive here too; fatal ones also reject `ready`, which the caller handles.
      onError: () => undefined,
    },
  });
  return {
    ready: session.ready,
    mute: () => session.mute(),
    unmute: () => session.unmute(),
    end: () => { void session.end(); },
    level: () => scaleLevel(session.analyzerComponent?.calculateVolume() ?? 0),
    resumeAudio: () => { session.startAudioPlayback().catch(() => undefined); },
  };
}

// ---------- development-only test seam ----------
// With `window.__caredeskFakeWebCall = {}` in a dev build (`vite`), the flow runs end to end (microphone prompt,
// POST /api/demo-web-call, live panel, mute, end, release on failure) without the SDK joining a real call.
// `import.meta.env.DEV` is false in production builds, so this code is removed from them.

export interface FakeWebCallSeam {
  /** Fail after the call was created, before it connects (exercises the release request). */
  failAt?: "connect";
  /** Milliseconds from creation to "live" (default 700). */
  liveAfterMs?: number;
  /** Set by the fake: lets a test end the call "from Ava's side". */
  hangUp?: () => void;
}

declare global {
  interface Window { __caredeskFakeWebCall?: FakeWebCallSeam }
}

function startFakeWebCall(seam: FakeWebCallSeam, options: { turnstileToken: string; events: WebCallEvents }): WebCallHandle {
  let ended = false;
  let live = false;
  let finishEarly: (reason: Error) => void = () => undefined;
  const finish = () => {
    if (ended) return;
    ended = true;
    if (live) options.events.onEnded();
    else finishEarly(new Error("Session ended before it was ready"));
  };
  const ready = new Promise<void>((resolve, reject) => {
    finishEarly = reject;
    void (async () => {
      const created = await requestWebCall({ turnstileToken: options.turnstileToken });
      options.events.onCreated(created);
      await new Promise((done) => window.setTimeout(done, seam.liveAfterMs ?? 700));
      if (ended) return;
      if (seam.failAt === "connect") {
        ended = true;
        throw new Error("Fake transport could not connect");
      }
      live = true;
      options.events.onLive();
      resolve();
    })().catch(reject);
  });
  ready.catch(() => undefined);
  seam.hangUp = finish;
  const started = performance.now();
  return {
    ready,
    mute: () => undefined,
    unmute: () => undefined,
    resumeAudio: () => undefined,
    end: finish,
    level: () => {
      if (!live || ended) return 0;
      const t = (performance.now() - started) / 1000;
      const speaking = Math.sin(t * 0.9) > -0.2 ? 1 : 0.1;
      return Math.max(0, speaking * (0.35 + 0.3 * Math.sin(t * 7.3) * Math.sin(t * 2.1)));
    },
  };
}
