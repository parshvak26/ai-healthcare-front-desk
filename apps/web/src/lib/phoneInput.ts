// Phone entry for the call form: a country (from the list the API allows) plus local digits. The E.164 number is
// composed from both and validated with the shared normalizeDemoPhone, the same rule the Worker applies.
import { normalizeDemoPhone } from "../../../../packages/shared/src/phone.ts";
import type { NormalizedPhone } from "../../../../packages/shared/src/phone.ts";
import type { CallCountry } from "./api";
import { viewerTimezone } from "./api";

export interface CountryInfo { code: CallCountry; flag: string; name: string; dial: "+1" | "+91"; placeholder: string }

export const countries: Record<CallCountry, CountryInfo> = {
  US: { code: "US", flag: "🇺🇸", name: "United States", dial: "+1", placeholder: "512 555 0100" },
  IN: { code: "IN", flag: "🇮🇳", name: "India", dial: "+91", placeholder: "98765 43210" },
};

export function supportedCountries(list: readonly string[] | undefined): CallCountry[] {
  const known = (list ?? ["US", "IN"]).filter((code): code is CallCountry => code === "US" || code === "IN");
  return known.length ? known : ["US"];
}

/** The device looks Indian: clock set to India time, or an Indian English locale. */
export function deviceLooksIndian() {
  const zone = viewerTimezone();
  if (zone === "Asia/Kolkata" || zone === "Asia/Calcutta") return true;
  try {
    return (navigator.languages ?? [navigator.language]).some((language) => /^[a-z]{2,3}-IN$/i.test(language));
  } catch {
    return false;
  }
}

export function defaultCountry(available: CallCountry[]): CallCountry {
  if (deviceLooksIndian() && available.includes("IN")) return "IN";
  return available.includes("US") ? "US" : available[0];
}

export interface PhoneEntry {
  country: CallCountry;
  /** Every national digit typed (no country code). Never truncated: extra digits are reported, not dropped. */
  digits: string;
  /** A "+44…"-style country code that cannot get a call. */
  unsupported?: string;
}

/** Longest digit string kept from the field (E.164 allows 15); anything longer is clearly not a phone number. */
const maxDigits = 15;

/**
 * Reads what was typed or pasted. A number starting with +1/+91/00 switches the country and drops that code. All
 * other digits are kept as typed: nothing is guessed or cut off, so a mistyped number can never quietly become a
 * different, valid one (checkPhone explains the problem and may offer a one-click correction).
 */
export function readPhoneEntry(raw: string, current: CallCountry, available: CallCountry[]): PhoneEntry {
  const trimmed = raw.trim();
  const compact = trimmed.replace(/[\s().-]/g, "");
  const international = compact.startsWith("+") || compact.startsWith("00");
  let digits = trimmed.replace(/\D/g, "");
  if (international) {
    if (compact.startsWith("00")) digits = digits.slice(2);
    if (digits.startsWith("91") && available.includes("IN")) return { country: "IN", digits: digits.slice(2, 2 + maxDigits) };
    if (digits.startsWith("1") && available.includes("US")) return { country: "US", digits: digits.slice(1, 1 + maxDigits) };
    // "+" or "+9" while typing: wait for more digits before deciding.
    if (digits === "" || digits === "9") return { country: current, digits: "" };
    return { country: current, digits: "", unsupported: `+${digits.slice(0, 3)}` };
  }
  return { country: current, digits: digits.slice(0, maxDigits) };
}

/** "512 555 0100" (US) or "98765 43210" (India), grouped as the digits arrive; more than 10 digits stay ungrouped. */
export function formatLocalDigits(digits: string, country: CallCountry) {
  if (digits.length > 10) return digits;
  if (country === "IN") return digits.length > 5 ? `${digits.slice(0, 5)} ${digits.slice(5)}` : digits;
  if (digits.length > 6) return `${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6)}`;
  if (digits.length > 3) return `${digits.slice(0, 3)} ${digits.slice(3)}`;
  return digits;
}

/** Caret position in the formatted text after `digitCount` digits. */
export function caretAfterDigits(formatted: string, digitCount: number) {
  if (digitCount <= 0) return 0;
  let seen = 0;
  for (let index = 0; index < formatted.length; index += 1) {
    if (/\d/.test(formatted[index])) seen += 1;
    if (seen === digitCount) return index + 1;
  }
  return formatted.length;
}

export function composePhone(country: CallCountry, digits: string): NormalizedPhone | null {
  if (digits.length !== 10) return null;
  return normalizeDemoPhone(`${countries[country].dial}${digits}`);
}

export interface PhoneSuggestion { country: CallCountry; digits: string; display: string }
export interface PhoneCheck {
  /** What is wrong, or null when there is nothing to say yet. */
  problem: string | null;
  /** A likely intended number ("Did you mean +91 98765 43210?"), applied only when the visitor clicks it. */
  suggestion?: PhoneSuggestion;
}

function suggest(country: CallCountry, digits: string, available: CallCountry[]): PhoneSuggestion | undefined {
  if (!available.includes(country)) return undefined;
  const phone = composePhone(country, digits);
  return phone ? { country, digits, display: phone.display } : undefined;
}

/** Checks the local digits for the chosen country. `finished` = the visitor left the field. */
export function checkPhone(country: CallCountry, digits: string, finished: boolean, available: CallCountry[]): PhoneCheck {
  if (!digits) return { problem: null };
  if (digits.length > 10) {
    // A country code or trunk prefix typed as part of the number: offer the number it probably is, never dial it.
    let suggestion: PhoneSuggestion | undefined;
    if (digits.length === 12 && digits.startsWith("91")) suggestion = suggest("IN", digits.slice(2), available);
    else if (digits.length === 11 && digits.startsWith("1")) suggestion = suggest("US", digits.slice(1), available);
    else if (country === "IN" && digits.length === 11 && digits.startsWith("0")) suggestion = suggest("IN", digits.slice(1), available);
    const label = country === "US" ? "a US number" : "an Indian mobile number";
    return { problem: `Too many digits — ${label} has 10.`, suggestion };
  }
  if (country === "US" && /^[01]/.test(digits)) return { problem: "US area codes don't start with 0 or 1." };
  if (country === "US" && digits.length >= 4 && /^[01]/.test(digits.slice(3))) return { problem: "That US number doesn't look right — check the 4th digit." };
  if (country === "IN" && /^[0-5]/.test(digits)) return { problem: "Indian mobile numbers start with 6, 7, 8 or 9." };
  if (digits.length < 10) return { problem: finished ? `${10 - digits.length} more digit${digits.length === 9 ? "" : "s"} needed.` : null };
  if (!composePhone(country, digits)) return { problem: "That number can't get a demo call." };
  return { problem: null };
}
