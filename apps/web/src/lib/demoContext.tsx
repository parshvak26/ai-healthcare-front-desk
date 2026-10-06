// One demo connection for the whole site. It lives above the router, so the call page and the staff screen share the
// same private clinic, and a call that is running keeps the staff screen polling fast.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { DemoAction, DemoState } from "../types";
import {
  ApiRequestError, apiBaseUrl, cloudBackend, getHealth, newIdempotencyKey, onReloadRequired, requiredApiVersion,
} from "./api";
import type { ActionResponse, DemoBackend, DemoCallsInfo, HealthResponse, Snapshot, Unchanged } from "./api";
import type { LocalBackend } from "./localBackend";
import { rotateVisitorKey, visitorKeyIsMemoryOnly } from "./visitor";

export type Connection = "connecting" | "cloud" | "local" | "fallback";

export interface DemoContextValue {
  connection: Connection;
  /** Why the browser-only copy is used, when the cloud demo was expected but is not usable. */
  fallbackReason: string;
  health: HealthResponse | null;
  /** Call settings, only when the cloud demo is in use (calls need it). */
  demoCalls?: DemoCallsInfo;
  snapshot: Snapshot | null;
  /**
   * The stored state. Due simulated texts are processed on this device's clock by the staff screen, the only place
   * messages are shown (keeping the rule set out of the call page's first-load JavaScript).
   */
  state: DemoState | null;
  backend: DemoBackend | null;
  retentionDays: number;
  /** True when the visitor key cannot be saved, so the private demo ends with this tab. */
  memoryOnly: boolean;
  reloadRequired: boolean;
  refresh(): Promise<void>;
  perform(action: DemoAction, key?: string): Promise<ActionResponse>;
  forget(): Promise<void>;
  /** Poll every 3 seconds until this time (a call is running). */
  requestFastPoll(until: number): void;
}

const DemoContext = createContext<DemoContextValue | null>(null);

export function useDemo() {
  const value = useContext(DemoContext);
  if (!value) throw new Error("useDemo must be used inside <DemoProvider>");
  return value;
}

export const broadcastName = "caredesk-demo";
export type DemoBroadcast = { type: "call-active"; until: number } | { type: "state-changed" };

let channel: BroadcastChannel | null | undefined;
function getChannel() {
  if (channel === undefined) {
    try { channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(broadcastName); } catch { channel = null; }
  }
  return channel;
}

/** Tells other open tabs of this site about a running call or a changed demo. */
export function broadcast(message: DemoBroadcast) {
  try { getChannel()?.postMessage(message); } catch { /* another tab simply won't hear it */ }
}

const isUnchanged = (value: Snapshot | Unchanged): value is Unchanged => "unchanged" in value && value.unchanged === true;

export function DemoProvider({ children }: { children: ReactNode }) {
  const [connection, setConnection] = useState<Connection>("connecting");
  const [fallbackReason, setFallbackReason] = useState("");
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [reloadRequired, setReloadRequired] = useState(false);
  // "Poll fast until" lives in a ref, so extending it (every status poll during a call) does not restart the timer.
  const fastUntilRef = useRef(0);
  const [fast, setFast] = useState(false);
  const [memoryOnly, setMemoryOnly] = useState(false);
  const backendRef = useRef<DemoBackend | null>(null);
  const localRef = useRef<LocalBackend | null>(null);
  const currentRef = useRef<Snapshot | null>(null);
  const loadingRef = useRef(false);

  // Poll results that arrive after a newer save are ignored, unless the workspace generation changed (reset, delete,
  // purge or re-creation), which restarts the revision count. A save's own response is always applied.
  const accept = useCallback((next: Snapshot, fromAction = false) => {
    const current = currentRef.current;
    if (!fromAction && current && backendRef.current?.kind === "cloud" && next.generation === current.generation && next.revision < current.revision) return;
    currentRef.current = next;
    setSnapshot(next);
  }, []);

  const startLocal = useCallback(async (reason: string) => {
    const { createLocalBackend } = await import("./localBackend");
    const local = createLocalBackend();
    localRef.current = local;
    backendRef.current = local;
    currentRef.current = null;
    const loaded = await local.load();
    if (!isUnchanged(loaded)) accept(loaded, true);
    setFallbackReason(reason);
    setConnection(reason ? "fallback" : "local");
  }, [accept]);

  useEffect(() => onReloadRequired(() => setReloadRequired(true)), []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!apiBaseUrl) { await startLocal(""); return; }
      try {
        const info = await getHealth();
        if (cancelled) return;
        setHealth(info);
        if (!info.databaseConnected) throw new ApiRequestError(503, "database_unavailable", "The cloud demo database is not reachable.");
        if ((info.apiVersion ?? 1) < requiredApiVersion) throw new ApiRequestError(409, "api_outdated", "The cloud API is older than this website.");
        const loaded = await cloudBackend.load();
        if (cancelled || isUnchanged(loaded)) return;
        backendRef.current = cloudBackend;
        accept(loaded, true);
        setMemoryOnly(visitorKeyIsMemoryOnly());
        setConnection("cloud");
      } catch (error) {
        if (cancelled) return;
        if (error instanceof ApiRequestError && error.code === "reload_required") return;
        const reason = error instanceof ApiRequestError && error.code === "api_outdated"
          ? "The demo server has not been updated yet, so this browser is using its own copy."
          : "The demo server is unavailable, so this browser is using its own copy.";
        await startLocal(reason);
      }
    })();
    return () => { cancelled = true; };
  }, [accept, startLocal]);

  const refresh = useCallback(async () => {
    const backend = backendRef.current;
    if (!backend || loadingRef.current) return;
    loadingRef.current = true;
    try {
      const current = currentRef.current;
      const loaded = await backend.load(current && backend.kind === "cloud" ? { generation: current.generation, revision: current.revision } : undefined);
      if (!isUnchanged(loaded)) accept(loaded);
    } catch {
      // Keep the last good copy; the next poll retries.
    } finally {
      loadingRef.current = false;
    }
  }, [accept]);

  const requestFastPoll = useCallback((until: number) => {
    if (until <= fastUntilRef.current) return;
    fastUntilRef.current = until;
    setFast(until > Date.now());
  }, []);

  useEffect(() => {
    if (!fast) return;
    const timer = window.setInterval(() => { if (Date.now() >= fastUntilRef.current) setFast(false); }, 1000);
    return () => window.clearInterval(timer);
  }, [fast]);

  // Other tabs: a call running elsewhere makes this tab poll fast; a deleted or reset demo makes it reload.
  useEffect(() => {
    const bc = getChannel();
    if (!bc) return;
    const onMessage = (event: MessageEvent<DemoBroadcast>) => {
      if (event.data?.type === "call-active" && typeof event.data.until === "number") requestFastPoll(Math.min(event.data.until, Date.now() + 10 * 60_000));
      if (event.data?.type === "state-changed") void refresh();
    };
    bc.addEventListener("message", onMessage);
    return () => bc.removeEventListener("message", onMessage);
  }, [refresh, requestFastPoll]);

  // Polling: every 3 s while a call is running (here or in another tab), otherwise every 30 s. Local mode only runs the
  // reminder simulation.
  useEffect(() => {
    if (connection === "connecting") return;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      if (connection === "cloud") void refresh();
      else { const ticked = localRef.current?.tick(); if (ticked) accept(ticked, true); }
    }, connection !== "cloud" ? 60_000 : fast ? 3_000 : 30_000);
    const onVisible = () => { if (document.visibilityState === "visible" && connection === "cloud") void refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [connection, refresh, accept, fast]);

  const perform = useCallback(async (action: DemoAction, key = newIdempotencyKey()) => {
    const backend = backendRef.current;
    if (!backend) throw new ApiRequestError(503, "not_ready", "The demo is still loading.");
    try {
      const response = await backend.perform(action, key);
      accept(response, true);
      if (response.result.changed) broadcast({ type: "state-changed" });
      return response;
    } catch (error) {
      if (error instanceof ApiRequestError && (error.uncertain || error.status === 409)) void refresh();
      throw error;
    }
  }, [accept, refresh]);

  const forget = useCallback(async () => {
    const backend = backendRef.current;
    if (!backend) return;
    await backend.forget();
    if (backend.kind === "cloud") { rotateVisitorKey(); setMemoryOnly(visitorKeyIsMemoryOnly()); }
    currentRef.current = null;
    const loaded = await backend.load();
    if (!isUnchanged(loaded)) accept(loaded, true);
    broadcast({ type: "state-changed" });
  }, [accept]);

  const state = snapshot?.state ?? null;

  const value = useMemo<DemoContextValue>(() => ({
    connection,
    fallbackReason,
    health,
    demoCalls: connection === "cloud" ? health?.demoCalls : undefined,
    snapshot,
    state,
    backend: backendRef.current,
    retentionDays: health?.privateDemo?.retentionDays ?? 7,
    memoryOnly,
    reloadRequired,
    refresh,
    perform,
    forget,
    requestFastPoll,
  }), [connection, fallbackReason, health, snapshot, state, memoryOnly, reloadRequired, refresh, perform, forget, requestFastPoll]);

  return <DemoContext.Provider value={value}>{children}</DemoContext.Provider>;
}
