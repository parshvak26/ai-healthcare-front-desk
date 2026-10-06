// Patient names. Callers may give any name on a demo call; it is stored only in that visitor's private demo.
// Names are restricted to letters (any script), spaces, apostrophes, hyphens and periods, so digits, emails,
// phone numbers and the "·" separator used in message recipients can never be smuggled in through a name.
import { allowedDemoPatients } from "./catalog.ts";
import type { DemoState } from "./types.ts";

/** Most distinct caller-given names one private demo may hold (the five sample patients are extra). */
export const maxCallerNames = 20;
export const maxNameLength = 60;

const samples = new Set<string>(allowedDemoPatients);
const reservedNames = new Set(["front desk"]);
const allowedShape = /^[\p{L}\p{M}][\p{L}\p{M}' .-]*$/u;

export function isSamplePatient(value: unknown): value is string {
  return typeof value === "string" && samples.has(value);
}

function titleCase(value: string) {
  return value.toLowerCase().replace(/(^|[\s'-])(\p{L})/gu, (_match, before: string, letter: string) => before + letter.toUpperCase());
}

/**
 * Returns the canonical form of a person's name, or null when it is not an acceptable name. Canonical means:
 * NFC, straight apostrophes, single spaces, no leading/trailing punctuation, and title case when the input was
 * all lower or all upper case (speech recognition often returns "parshva" or "PARSHVA").
 */
export function normalizePersonName(input: unknown): string | null {
  if (typeof input !== "string" || input.length > 200) return null;
  let name = input.normalize("NFC").replace(/[‘’ʼ`´]/g, "'").replace(/\s+/g, " ").trim();
  name = name.replace(/^[\s'.-]+/u, "").replace(/[\s'-]+$/u, "").replace(/ ?- ?/g, "-");
  if (name.length < 1 || name.length > maxNameLength) return null;
  if (!allowedShape.test(name) || !/\p{L}/u.test(name)) return null;
  if (/['.-]{2,}/.test(name) || name.split(" ").length > 5) return null;
  if (reservedNames.has(name.toLowerCase())) return null;
  if (!samples.has(name) && (name === name.toLowerCase() || name === name.toUpperCase())) {
    // Case mapping can decompose letters ("İ" lower-cases to "i" + a combining dot), so re-compose and re-check.
    name = titleCase(name).normalize("NFC");
    if (name.length > maxNameLength || !allowedShape.test(name)) return null;
  }
  return name;
}

/** True only for a name already in canonical form (what the store accepts). */
export function isPatientName(value: unknown): value is string {
  return typeof value === "string" && normalizePersonName(value) === value;
}

/** Comparison form: no accents, lower case, letters and single spaces only. */
export function foldName(value: string) {
  return value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L} ]/gu, "").replace(/\s+/g, " ").trim();
}

export function sameName(a: string, b: string) {
  const fa = foldName(a);
  return fa.length > 0 && fa === foldName(b);
}

function editDistance(a: string, b: string) {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const previous = Array.from({ length: b.length + 1 }, (_value, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const above = previous[j];
      previous[j] = Math.min(previous[j] + 1, previous[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return previous[b.length];
}

/** Spelling tolerance for speech recognition: none for short names, one edit from 4 letters, two from 8. */
function closeEnough(a: string, b: string) {
  const length = Math.min(a.length, b.length);
  const allowed = length >= 8 ? 2 : length >= 4 ? 1 : 0;
  return allowed > 0 && editDistance(a, b) <= allowed;
}

export type NameMatchTier = "exact" | "first-name" | "fuzzy";

/**
 * Finds the stored names a spoken or typed name refers to, in tiers: an exact (folded) match wins; otherwise a
 * matching first name (only when the query is a single word) or the same first and last name; otherwise a close
 * spelling. Only the best non-empty tier is returned, so "Anna" never matches "Anne" when an "Anna" exists.
 */
export function matchNames(query: string, candidates: readonly string[]): { tier: NameMatchTier | null; names: string[] } {
  const q = foldName(query);
  if (!q) return { tier: null, names: [] };
  const unique = [...new Set(candidates)];
  const folded = unique.map((name) => ({ name, folded: foldName(name) }));
  const exact = folded.filter((item) => item.folded === q).map((item) => item.name);
  if (exact.length) return { tier: "exact", names: exact };
  const qWords = q.split(" ");
  const partial = folded.filter((item) => {
    const words = item.folded.split(" ");
    if (qWords.length === 1) return words[0] === qWords[0];
    return words.length > 1 && words[0] === qWords[0] && words[words.length - 1] === qWords[qWords.length - 1];
  }).map((item) => item.name);
  if (partial.length) return { tier: "first-name", names: partial };
  const fuzzy = folded.filter((item) => {
    if (closeEnough(q, item.folded)) return true;
    // A single spoken word may be a misheard first name ("Parsva" for "Parshva Karani").
    return qWords.length === 1 && closeEnough(q, item.folded.split(" ")[0]);
  }).map((item) => item.name);
  return fuzzy.length ? { tier: "fuzzy", names: fuzzy } : { tier: null, names: [] };
}

/**
 * Stricter than matchNames, for deciding that a new booking belongs to an existing person: same number of words,
 * exactly one word spelled differently, that word at least 6 letters, and within one edit (two from 8 letters).
 * "Parsva" → "Parshva" merges; "Joan Smith" and "John Smith", or "Anna" and "Anne", stay different people.
 */
export function likelySameSpelling(a: string, b: string) {
  const wa = foldName(a).split(" ");
  const wb = foldName(b).split(" ");
  if (!wa[0] || wa.length !== wb.length) return false;
  const differing = wa.map((word, index) => [word, wb[index]] as const).filter(([x, y]) => x !== y);
  if (differing.length !== 1) return false;
  const [x, y] = differing[0];
  const shortest = Math.min(x.length, y.length);
  return shortest >= 6 && editDistance(x, y) <= (shortest >= 8 ? 2 : 1);
}

export function namesMatch(query: string, stored: string) {
  return matchNames(query, [stored]).names.length > 0;
}

/** Every patient name present in a demo: the five samples first, then caller-given names in first-seen order. */
export function patientNames(state: Pick<DemoState, "appointments" | "waitlist" | "tasks" | "referrals" | "smsPreferences">) {
  const names: string[] = [...allowedDemoPatients];
  const seen = new Set(names);
  const add = (name: string) => { if (name !== "Front desk" && !seen.has(name)) { seen.add(name); names.push(name); } };
  for (const list of [state.appointments, state.waitlist, state.tasks, state.referrals, state.smsPreferences]) {
    for (const item of [...list].reverse()) add(item.patient);
  }
  return names;
}

export function callerNames(state: Parameters<typeof patientNames>[0]) {
  return patientNames(state).filter((name) => !samples.has(name));
}
