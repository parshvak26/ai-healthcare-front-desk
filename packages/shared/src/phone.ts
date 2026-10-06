// Phone-number rules for the outbound demo call, shared by the form and the Worker. Like the HVAC demo, it
// accepts US numbers (NANP) and Indian mobile numbers. Unlike it, the country code is always required.

export type DemoCallCountry = "US" | "IN";

export interface NormalizedPhone {
  e164: string;
  country: DemoCallCountry;
  /** Human-friendly form for confirmations, e.g. "+1 (512) 555-0100" or "+91 98765 43210". */
  display: string;
}

const usPattern = /^\+1([2-9]\d{2})([2-9]\d{2})(\d{4})$/;
const indiaMobilePattern = /^\+91([6-9]\d{4})(\d{5})$/;

export function normalizeDemoPhone(input: unknown): NormalizedPhone | null {
  if (typeof input !== "string" || input.length > 40) return null;
  const compact = input.trim().replace(/[\s().-]/g, "");
  if (!/^(?:\+|00)?\d{10,13}$/.test(compact)) return null;
  // The country code is required. A 10-digit Indian mobile typed without +91 can look like a valid US number,
  // and guessing would place an AI call to a stranger.
  const candidate = compact.startsWith("00") ? `+${compact.slice(2)}` : compact;
  if (!candidate.startsWith("+")) return null;
  const us = usPattern.exec(candidate);
  if (us) return { e164: candidate, country: "US", display: `+1 (${us[1]}) ${us[2]}-${us[3]}` };
  const india = indiaMobilePattern.exec(candidate);
  if (india) return { e164: candidate, country: "IN", display: `+91 ${india[1]} ${india[2]}` };
  return null;
}

/** Formats a stored E.164 caller ID for display without validating it as a destination. */
export function displayPhone(e164: string) {
  return normalizeDemoPhone(e164)?.display ?? e164;
}
