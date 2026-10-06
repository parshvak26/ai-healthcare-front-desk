// The visitor key: 32 random bytes (base64url, 43 characters) that tie this browser to its private demo clinic.
// It is a bearer secret for synthetic data only. It lives in localStorage so it survives reloads; when storage is
// unavailable (private windows, blocked site data) it is kept in memory and the demo resets when the tab closes.
// Every storage access is guarded, because reading localStorage can throw.

const storageKey = "caredesk-visitor-v1";
const keyPattern = /^[A-Za-z0-9_-]{43}$/;
let memoryKey: string | null = null;
let memoryOnly = false;

function randomKey() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function readStored() {
  try {
    const value = localStorage.getItem(storageKey);
    return value && keyPattern.test(value) ? value : null;
  } catch {
    return null;
  }
}

function store(value: string) {
  try {
    localStorage.setItem(storageKey, value);
    memoryOnly = localStorage.getItem(storageKey) !== value;
  } catch {
    memoryOnly = true;
  }
}

/**
 * The current visitor key. Read from storage on every call, so a key rotated in another tab (after "Delete my demo
 * data") is picked up by this one on its next request.
 */
export function getVisitorKey() {
  const stored = readStored();
  if (stored) { memoryKey = stored; memoryOnly = false; return stored; }
  if (!memoryKey) memoryKey = randomKey();
  store(memoryKey);
  return memoryKey;
}

/** Starts a new, empty private demo for this browser (after the old one was deleted). */
export function rotateVisitorKey() {
  memoryKey = randomKey();
  store(memoryKey);
  return memoryKey;
}

/** True when the key could not be saved, so the private demo only lasts as long as this tab. */
export function visitorKeyIsMemoryOnly() {
  getVisitorKey();
  return memoryOnly;
}
