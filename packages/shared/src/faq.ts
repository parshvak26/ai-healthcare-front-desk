// Approved-answer lookup shared by the voice tool and the staff console. It never generates text: it either
// returns a published answer or says that no approved answer exists. Safety routing runs before matching.
import { faqEntries } from "./catalog.ts";
import type { FaqEntry } from "./catalog.ts";
import type { RequestType } from "./types.ts";

export interface FaqSearchResult {
  approved: boolean;
  handoff: boolean;
  answer: string;
  faqId?: string;
  question?: string;
  /** Staff task the assistant should offer, when one fits. */
  suggestedRequest?: RequestType;
  /** True when the caller should be told to contact local emergency services. */
  emergency?: boolean;
}

const emergencyPattern = /\b(emergenc\w*|ambulance|911|999|112|unconscious|not breathing|can'?t breathe|cannot breathe|chest pain|overdos\w*|suicid\w*|kill (myself|themselves|himself|herself)|severe bleeding|stroke|heart attack|seizure)\b/;
const clinicalPattern = /\b(symptom\w*|diagnos\w*|treat\w*|dose|doses|dosage|side effects?|pain\w*|fever\w*|bleed\w*|rash\w*|sick|illness|infect\w*|allerg\w*|pregnan\w*|vaccin\w*|test results?|lab results?|should i take|can i take|stop taking|interact\w*|condition|disease|injur\w*|hurt\w*|cough\w*|headache\w*|nause\w*|dizz\w*)\b/;
const refillPattern = /\b(refill\w*|renew\w*|repeat prescription|prescription request|run(ning)? out of)\b/;
const medicationPattern = /\b(medicat\w*|medicine\w*|prescri\w*|drug\w*|pill\w*|tablet\w*|antibiotic\w*)\b/;

const stopwords = new Set([
  "a", "an", "and", "are", "as", "at", "be", "can", "could", "do", "does", "for", "from", "get", "have", "how", "i", "i'm",
  "if", "in", "is", "it", "me", "my", "need", "of", "on", "or", "please", "should", "so", "that", "the", "there", "this",
  "to", "want", "we", "what", "when", "which", "who", "will", "with", "would", "you", "your", "about", "any", "just", "know",
  "tell", "like", "some", "much", "many", "our", "us", "am", "was", "were", "has", "had", "help", "hi", "hello", "thanks",
]);

function entry(id: string): FaqEntry {
  const found = faqEntries.find((item) => item.id === id);
  if (!found) throw new Error(`Missing approved FAQ entry: ${id}`);
  return found;
}

function result(item: FaqEntry, extra: Partial<FaqSearchResult> = {}): FaqSearchResult {
  return { approved: true, handoff: false, answer: item.answer, faqId: item.id, question: item.question, ...extra };
}

export function searchApprovedFaq(rawQuestion: string): FaqSearchResult {
  const query = rawQuestion.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 200);
  if (emergencyPattern.test(query)) return result(entry("emergency"), { handoff: true, emergency: true, suggestedRequest: "callback" });
  if (clinicalPattern.test(query)) return result(entry("clinical"), { handoff: true, suggestedRequest: "callback" });
  if (refillPattern.test(query)) return result(entry("refill"), { handoff: true, suggestedRequest: "refill" });
  // Any other medication question is clinical by default: the assistant must not advise about medicine.
  if (medicationPattern.test(query)) return result(entry("clinical"), { handoff: true, suggestedRequest: "callback" });

  const tokens = (query.match(/[a-z0-9']+/g) || []).filter((token) => token.length > 1 && !stopwords.has(token));
  let best: { item: FaqEntry; score: number } | undefined;
  for (const item of faqEntries) {
    if (!item.keywords.length) continue;
    const question = item.question.toLowerCase();
    let score = 0;
    for (const token of tokens) {
      if (item.keywords.some((keyword) => token === keyword || (keyword.length >= 4 && token.startsWith(keyword)))) score += 3;
      else if (token.length >= 4 && question.includes(token)) score += 1;
    }
    if (score > (best?.score ?? 0)) best = { item, score };
  }
  if (best && best.score >= 3) {
    const suggested: Partial<Record<string, RequestType>> = { records: "records", billing: "billing", insurance: "billing", accessibility: "accessibility", contact: "callback", documents: "documents", referral: "documents" };
    return result(best.item, { suggestedRequest: suggested[best.item.id] });
  }
  return {
    approved: false,
    handoff: true,
    answer: "I don't have an approved answer for that. I can ask the front desk to follow up.",
    suggestedRequest: "faq",
  };
}

/**
 * The approved answers as the voice agent says them. This exact block is pasted into the agent prompt between
 * the FAQ markers in retell/AGENT_PROMPT.md; a test keeps the two in sync.
 */
export function voiceFaqPromptBlock() {
  return faqEntries.map((item) => `- "${item.question}" → ${item.voiceAnswer}`).join("\n");
}
