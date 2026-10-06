// Browser storage for local mode only. Cloud mode never relies on it. Storage can be unavailable (private
// windows, blocked site data), so every access is guarded and the demo falls back to fresh sample data.
import { createSeedState, normalizeDemoState } from "../../../../packages/shared/src/index.ts";
import type { DemoSnapshot } from "../types";

const storageKey = "healthcare-front-desk-demo-v2";
const legacyStorageKey = "healthcare-front-desk-demo-v1";

function read(key: string) {
  try { return localStorage.getItem(key); } catch { return null; }
}

export function loadLocalSnapshot(): DemoSnapshot {
  const current = read(storageKey);
  if (current) {
    try {
      const parsed = JSON.parse(current) as { state?: unknown; revision?: unknown };
      const normalized = normalizeDemoState(parsed.state);
      if (normalized) return { state: normalized.state, revision: Number.isInteger(parsed.revision) ? Number(parsed.revision) : 1 };
    } catch { /* fall through to older data or fresh samples */ }
  }
  const legacy = read(legacyStorageKey);
  if (legacy) {
    try {
      const normalized = normalizeDemoState(JSON.parse(legacy));
      if (normalized) return { state: normalized.state, revision: 1 };
    } catch { /* ignore a broken copy */ }
  }
  return { state: createSeedState(), revision: 1 };
}

/** Removes this browser's copy ("Delete my demo data" in local mode). */
export function clearLocalSnapshot() {
  try {
    localStorage.removeItem(storageKey);
    localStorage.removeItem(legacyStorageKey);
  } catch {
    // Nothing stored, or storage is unavailable.
  }
}

export function saveLocalSnapshot(snapshot: DemoSnapshot) {
  try {
    localStorage.setItem(storageKey, JSON.stringify(snapshot));
    localStorage.removeItem(legacyStorageKey);
  } catch {
    // Keep the session usable when browser storage is unavailable.
  }
}
