// Browser-only back end: the same shared rules as the Worker, applied to a copy kept in this browser. Used when no
// Worker is configured, reachable or current. Loaded on demand (it pulls in the full rule set).
import { applyDemoAction, buildAvailability, createSeedState, DomainError, processDueMessages } from "../../../../packages/shared/src/index.ts";
import type { DemoSnapshot } from "../types";
import { ApiRequestError } from "./api";
import type { DemoBackend, Snapshot } from "./api";
import { clearLocalSnapshot, loadLocalSnapshot, saveLocalSnapshot } from "./store";

function asApiError(error: unknown) {
  if (error instanceof DomainError) return new ApiRequestError(error.status, error.code, error.message);
  return error;
}

/** Browser-only back end. It applies the same rules and runs the reminder simulation on load and on a timer. */
export type LocalBackend = DemoBackend & { tick(): Snapshot | null };

export function createLocalBackend(): LocalBackend {
  let generation = 1;
  let snapshot = loadLocalSnapshot();
  const full = (): Snapshot => ({ ...snapshot, generation, persisted: true });
  const persist = (next: DemoSnapshot) => { snapshot = next; saveLocalSnapshot(next); return full(); };
  const tick = () => {
    const processed = processDueMessages(snapshot.state, Date.now());
    return processed.changed ? persist({ state: processed.state, revision: snapshot.revision + 1 }) : null;
  };
  return {
    kind: "local",
    tick,
    load: async () => { tick(); return full(); },
    perform: async (action, idempotencyKey) => {
      try {
        const outcome = applyDemoAction(snapshot.state, action, { now: Date.now(), channel: "Staff console", key: `web|${idempotencyKey}`, random: Math.random });
        const next = outcome.changed ? persist({ state: outcome.state, revision: snapshot.revision + 1 }) : full();
        return { ...next, result: { changed: outcome.changed, message: outcome.message, appointment: outcome.appointment, waitlistItem: outcome.waitlistItem, task: outcome.task } };
      } catch (error) {
        throw asApiError(error);
      }
    },
    availability: async (query) => {
      try {
        return buildAvailability(snapshot.state, { ...query, now: Date.now() });
      } catch (error) {
        throw asApiError(error);
      }
    },
    forget: async () => {
      clearLocalSnapshot();
      generation += 1;
      snapshot = { state: createSeedState(), revision: 1 };
    },
  };
}
