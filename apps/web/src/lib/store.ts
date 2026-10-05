import { createSeedState } from "./demoData";
import type { DemoState } from "../types";

const storageKey = "healthcare-front-desk-demo-v1";

export function loadDemoState(): DemoState {
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved) {
      const parsed = JSON.parse(saved) as Partial<DemoState>;
      if (Array.isArray(parsed.appointments) && Array.isArray(parsed.tasks) && Array.isArray(parsed.referrals) && Array.isArray(parsed.messages)) {
        return { ...parsed, waitlist: Array.isArray(parsed.waitlist) ? parsed.waitlist : [] } as DemoState;
      }
    }
  } catch {
    // A broken local demo snapshot should fall back to the sample records.
  }
  return createSeedState();
}

export function saveDemoState(state: DemoState) {
  try {
    localStorage.setItem(storageKey, JSON.stringify(state));
  } catch {
    // Keep the current session usable when browser storage is unavailable.
  }
}

export function resetDemoState() {
  localStorage.removeItem(storageKey);
  return createSeedState();
}
