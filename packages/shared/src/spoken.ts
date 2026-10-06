// Text written for the voice agent to say aloud: dates as words with ordinals, times like "9:30 a.m.", booking
// references digit by digit, and a 14-day calendar so relative dates ("next Friday") resolve exactly.
import { clinicHours } from "./catalog.ts";
import { addDaysToDateKey, localDateKey, localParts, weekdayOfDateKey } from "./time.ts";

const weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const digitWords = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];

export function ordinal(day: number) {
  const tens = day % 100;
  if (tens >= 11 && tens <= 13) return `${day}th`;
  return `${day}${({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[day % 10] ?? "th"}`;
}

/** "Thursday, October 8th" for a YYYY-MM-DD date. */
export function spokenDateKey(date: string) {
  const [, month, day] = date.split("-").map(Number);
  return `${weekdays[weekdayOfDateKey(date)]}, ${months[month - 1]} ${ordinal(day)}`;
}

/** "9 a.m." or "2:30 p.m." in the given zone. */
export function spokenTime(instant: string | number, timeZone: string) {
  const { hour, minute } = localParts(new Date(instant), timeZone);
  const suffix = hour < 12 ? "a.m." : "p.m.";
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  return minute === 0 ? `${hour12} ${suffix}` : `${hour12}:${String(minute).padStart(2, "0")} ${suffix}`;
}

/** "Thursday, October 8th at 9:30 a.m." in the given zone. */
export function spokenDateTime(instant: string | number, timeZone: string) {
  return `${spokenDateKey(localDateKey(new Date(instant), timeZone))} at ${spokenTime(instant, timeZone)}`;
}

/** "DEMO-4812" → "demo four eight one two", so text-to-speech never says "four thousand…". */
export function spokenReference(reference: string) {
  const digits = /^DEMO-(\d{4})$/.exec(reference)?.[1];
  return digits ? `demo ${[...digits].map((digit) => digitWords[Number(digit)]).join(" ")}` : reference;
}

/** Accepts "DEMO-4812", "demo 4812", "4812" or "4 8 1 2"; returns "DEMO-4812" or null. */
export function parseBookingReference(input: unknown) {
  if (typeof input !== "string" || input.length > 40) return null;
  const compact = input.toUpperCase().replace(/[\s.,-]/g, "");
  const match = /^(?:DEMO)?(\d{4})$/.exec(compact);
  return match ? `DEMO-${match[1]}` : null;
}

/**
 * A 14-day calendar in the clinic zone, one line per day: "Thu Oct 8 = 2026-10-08 (open 8 a.m.–5 p.m.)".
 * Passed to the agent so it maps "tomorrow" or "next Friday" to an exact date without doing date maths.
 */
export function clinicCalendar(now: number, timeZone: string, days = 14) {
  const today = localDateKey(now, timeZone);
  const lines: string[] = [];
  for (let offset = 0; offset < days; offset += 1) {
    const date = addDaysToDateKey(today, offset);
    const [, month, day] = date.split("-").map(Number);
    const weekday = weekdayOfDateKey(date);
    const open = (clinicHours.openWeekdays as readonly number[]).includes(weekday);
    const label = offset === 0 ? "today, " : offset === 1 ? "tomorrow, " : "";
    lines.push(`${label}${weekdays[weekday].slice(0, 3)} ${months[month - 1].slice(0, 3)} ${day} = ${date} (${open ? "open 8 a.m. to 5 p.m." : "closed"})`);
  }
  return lines.join("\n");
}

/** "Tuesday, October 6th, 2026" for the clinic's current date. */
export function spokenToday(now: number, timeZone: string) {
  const today = localDateKey(now, timeZone);
  return `${spokenDateKey(today)}, ${today.slice(0, 4)}`;
}
