import type { DemoState } from "../types";

export interface RemoteDemoSnapshot {
  state: DemoState;
  revision: number;
}

export class RemoteStateConflict extends Error {}

export const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL || "").trim().replace(/\/$/, "");

export async function getRemoteDemoState(signal: AbortSignal): Promise<RemoteDemoSnapshot> {
  const response = await fetch(`${apiBaseUrl}/api/demo/state`, { signal, headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`Cloud demo returned ${response.status}`);
  return await response.json() as RemoteDemoSnapshot;
}

export async function putRemoteDemoState(snapshot: RemoteDemoSnapshot): Promise<RemoteDemoSnapshot> {
  const response = await fetch(`${apiBaseUrl}/api/demo/state`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(snapshot),
  });
  if (response.status === 409) throw new RemoteStateConflict("Another demo session changed the sample schedule.");
  if (!response.ok) throw new Error(`Cloud demo returned ${response.status}`);
  return await response.json() as RemoteDemoSnapshot;
}
