
# AI Healthcare Front Desk — Product Requirements Document

**Status:** Draft for review  
**Version:** 0.1  
**Date:** 2026-10-03  
**Purpose:** Guide the local demo implementation and the next deployment phase.

## 1. Product summary

AI Healthcare Front Desk is a portfolio and demonstration system for a fictional clinic. It helps with front desk work across phone, text, and a web-based staff console: appointment requests and changes, common administrative questions, referral and document collection, reminders, and follow-up tasks.

It must not diagnose, recommend treatment, interpret symptoms, decide clinical urgency, or replace a clinician. Clinical questions and uncertain requests go to clinic staff. The first scheduler is a demo scheduler with synthetic records; there is no EHR connection in this phase.

The public site and repository follow the existing HVAC demo pattern. The public experience is a clearly marked demo, not an operational clinic service. It must use synthetic patient and document content only. A real phone call can still expose a caller's real number or voice, so live phone and text use needs a separate allowlist and retention decision before public activation.

## 2. Decisions already supplied by the owner

- Create this as a separate project, similar to the HVAC project.
- Use a demo scheduler first; do not assume an EHR.
- Include phone calls and text reminders/follow-ups.
- Use demo data.
- Make the project public like HVAC.
- Target the USA, UAE, Europe, and India.
- Start with English across the named markets.
- Include controls for both clinic scheduling timezone and viewer display timezone.
- Limit live calls and texts to the owner's approved test numbers.
- The proposed reminders are accepted: booking confirmation, a reminder 24 hours before the appointment, and one follow-up 48 hours later when requested referral documents are still missing.

## 3. Product goals

1. Let a caller complete routine front desk tasks without waiting for a staff member.
2. Keep bookings, cancellations, reminders, documents, and staff follow-ups consistent across voice, text, and the staff console.
3. Answer only from clinic-approved information.
4. Make it easy to hand work to a person, with a short and useful summary.
5. Make market, locale, phone-number format, date format, and timezone configurable.
6. Keep demo and hosting costs low with mock services locally and free hosting tiers where practical.
7. Make the product visibly and technically clear that it is a demo and does not provide medical care.

## 4. Users and roles

### Patient or caller
Calls or texts the demo clinic to ask administrative questions, request or change an appointment, confirm a visit, submit a referral document, or ask for a person.

### Front desk staff
Reviews appointments, unresolved requests, referrals, failed reminders, and call summaries; takes over tasks that need a person.

### Clinic administrator
Sets clinic locations, hours, service types, appointment lengths, provider availability, approved FAQs, escalation contacts, supported languages, and reminder settings.

### Demo reviewer
Explores seeded examples and runs approved test flows without seeing another reviewer's contact information or real patient information.

## 5. Product boundaries and safety rules

- The assistant handles administrative work only.
- It does not diagnose, interpret symptoms, recommend treatment, advise on medication, or decide whether a symptom is urgent.
- It does not say an appointment is booked until the scheduler confirms the write succeeded.
- It answers clinic-policy questions only from approved clinic content. If a value is missing or stale, it says it does not have that information and offers staff follow-up.
- It does not ask callers to say sensitive medical details aloud. It requests only the information required for the administrative task.
- If a caller describes an emergency, asks for clinical guidance, requests a clinician, or the assistant is unsure, it stops the automated workflow and follows the configured human/emergency handoff message. Emergency wording is static and approved by the clinic; the AI does not triage.
- Every public page and phone greeting says this is a fictional demo and asks users not to share real health or personal information.
- No real patient records, real referrals, real medical documents, or real EHR data are permitted in this demo.
- Do not claim HIPAA, GDPR, UAE health-data, or other regulatory compliance for this demo. A real-patient deployment is a separate project phase requiring selected vendors, hosting region, contracts, security controls, and review.
- Do not record calls by default. Call recording, transcript retention, consent language, and deletion timing are deployment decisions. During the demo, store a minimal summary and event state where possible.

## 6. Functional scope

### 6.1 Clinic setup and market selection

The demo includes a clinic profile with name, locations, hours, holidays, services, staff handoff methods, supported channels, and approved FAQs.

The interface has:

- A **Market** selector for USA, UAE, Europe, or India.
- A **Clinic timezone** selector using IANA timezone names.
- Local date, time, and phone formatting based on the selected market and timezone.
- A clear display of the clinic timezone beside appointment times.
- A language selector only for languages with reviewed UI copy and a published voice agent.

Suggested timezone examples for the first demo: America/New_York, America/Chicago, America/Los_Angeles, Asia/Dubai, Europe/London, Europe/Paris, Europe/Berlin, and Asia/Kolkata. The complete list is a product setting, not a hard-coded assumption. Europe must resolve to a country and timezone because it has many countries, languages, and timezones. India uses Asia/Kolkata; UAE uses Asia/Dubai.

English is the initial language across the named markets. The product must be built so that UI text, FAQ content, phone prompts, dates, and messages can be localized independently. Additional languages can be enabled after the translations and voice prompts are reviewed.

### 6.2 Phone front desk

An inbound Retell voice agent supports:

- Greeting and clear AI/demo disclosure.
- Language selection from enabled languages.
- Clinic hours, locations, parking, accessibility, and contact details.
- New appointment request, appointment confirmation, reschedule, and cancellation.
- Waitlist request when no suitable demo slot is available.
- Appointment preparation and administrative policy answers.
- Referral/document checklist and submission instructions.
- Requests for staff, call-back requests, and message taking.
- Routing for prescription refill requests, medical-record requests, billing/insurance questions, and other matters the demo cannot complete.
- After-hours handling and closure/holiday messaging.
- A concise summary and next step at the end of each supported call.

The agent confirms the caller's intended action before changing an appointment. The scheduler is the final source of truth. Duplicate requests and retries use idempotency keys.

### 6.3 Demo appointment scheduler

The demo scheduler supports:

- Appointment types with length, lead time, and required administrative documents.
- Fake clinic locations and fake provider schedules.
- Search by date range and selected timezone.
- Book, confirm, reschedule, and cancel.
- A waitlist for a preferred date/time range.
- A cancellation opening that can be offered to a waitlisted demo patient.
- Conflict prevention so two requests cannot reserve the same slot.
- A clear status: requested, confirmed, reschedule requested, cancelled, waitlisted, or needs staff review.
- A staff view of upcoming appointments and changes.

No appointment is linked to a real clinician or a real clinic calendar in this phase.

### 6.4 Common questions and approved answers

The demo FAQ set is configurable. Example answers below are templates. The fictional clinic must fill in values before the agent presents them. The assistant must never invent a fee, policy, address, insurance acceptance, availability, preparation step, or medical answer.

| Topic | Example safe answer |
|---|---|
| Clinic hours | “Our listed hours are [approved hours]. I can ask the front desk to confirm holiday hours.” |
| Location and parking | “The clinic is at [approved address]. Parking instructions are [approved instructions]. Would you like me to text the address?” |
| Accepted insurance | “I can share the plans listed by the clinic, but coverage depends on your plan. Please check directly with your insurer or our billing team.” |
| New patient | “I can help request a first appointment and tell you which administrative forms are listed for it.” |
| Appointment confirmation | “I can check the demo schedule. I’ll confirm only after it shows the appointment as booked.” |
| Reschedule or cancel | “I can look up the demo appointment and help change it. If I can’t match it, I’ll ask the front desk to follow up.” |
| Late arrival | “The clinic’s late-arrival policy is [approved policy]. I can also ask staff to contact you.” |
| Referral required | “The clinic lists [approved referral requirement] for this visit. I can explain how to submit a demo document.” |
| Missing document | “I can list the documents the clinic requested and note that you need help sending them.” |
| Visit preparation | “The clinic’s instructions for this appointment are [approved instructions]. I can ask staff if you need something else.” |
| Prescription refill | “I can pass a refill request to the clinic team. I can’t approve or advise on medication.” |
| Medical records | “I can send your request to the records team. I can’t release records through this demo.” |
| Billing question | “I can record a billing question for staff. I can’t confirm a charge or coverage decision.” |
| Clinical question | “I’m only able to help with front desk tasks. I’ll connect you with clinic staff.” |
| Emergency | Use the clinic-approved emergency message. Do not assess symptoms or attempt to triage. |
| Not sure / no answer in FAQ | “I don’t have an approved answer for that. I can ask a staff member to follow up.” |

### 6.5 Referral and document intake

The demo supports a document checklist and a private upload path for clearly synthetic sample files:

- Show which demo documents are requested and their status.
- Upload a demo PDF or image to private storage, with a strict size/type limit.
- Record a file receipt event without displaying the file publicly.
- Let staff mark a document received, incomplete, or needing follow-up.
- Schedule one follow-up 48 hours after a request if the required demo document is still missing.
- Prevent document contents from being interpreted as clinical guidance or used to make clinical decisions.
- Purge demo uploads on a configured short retention schedule.

For the public demo, the preferred default is to accept only supplied synthetic examples or test-number allowlisted uploads. Whether arbitrary file upload is enabled remains an owner decision.

### 6.6 Text messages and follow-ups

Text messages are limited to administrative content:

- Booking confirmation immediately after successful scheduling.
- Appointment reminder 24 hours before the appointment.
- One missing-document follow-up 48 hours after the request.
- Optional staff-request acknowledgement and callback status.
- A clear opt-out path and suppression of future non-essential texts after opt-out.
- Per-appointment deduplication and delivery status.
- Configurable country/market provider, sender number, quiet hours, language, and message templates.

Messages must not contain diagnosis, symptoms, detailed referral contents, or other sensitive medical information. Text only the minimum needed and link to the demo site when more context is needed. Exact provider and country-specific rules are chosen before enabling live SMS.

### 6.7 Staff console

The web console should include:

- Today view: appointments, waitlist, new requests, and work needing attention.
- Appointment search and change history.
- Follow-up task queue with due date, reason, owner, status, and short summary.
- Referral/document checklist and receipt status.
- FAQ and clinic-hours editor with draft/published state.
- Call summaries and action outcomes, without a full recording by default.
- Human handoff and call-back queue.
- Message history showing template, consent, delivery, and opt-out state.
- Demo data reset button for reviewers.
- Visible demo banner and timezone/market indicator.

### 6.8 Additional useful workflows beyond calls and scheduling

These are included in the product direction, with mock behavior in the first demo:

- Appointment waitlist and cancellation opening.
- Pre-visit checklist status.
- Referral/document checklist and missing-item follow-up.
- Callback request and staff task assignment.
- Administrative record-request intake.
- Prescription refill intake routed to staff, with no approval or advice.
- Billing/insurance question intake routed to staff.
- Clinic closure, holiday, and after-hours announcements.
- Multilingual greetings and approved FAQ content.
- Accessibility preferences and interpreter request intake.
- No-show / missed-appointment callback task.
- Patient self-service page for appointment lookup, reschedule/cancel, FAQs, and document status.
- Staff review of unresolved questions and inaccurate FAQ reports.
- Basic activity report: calls, bookings, cancellations, referrals pending, texts delivered, and tasks overdue.
- Future email and web-chat adapters, kept out of the first live-cost phase.

### 6.9 Error and fallback behavior

- If Retell, the scheduler, storage, or messaging provider is unavailable, the system does not claim success.
- It offers a callback or staff follow-up, gives a safe error message, and records a retryable task.
- Webhook retries and duplicate SMS jobs must not create duplicate appointments or messages.
- If a phone call ends before confirmation, mark the request incomplete and offer a staff callback if consent was given.
- If no approved FAQ answer exists, do not use general model knowledge to fill in clinic policy.
- If a timezone is missing or invalid, block booking and ask for staff help.

## 7. User experience

### Public demo
- Landing page explains the demo, supported tasks, markets, and privacy boundary.
- Demo selector controls clinic market, timezone, and test scenario.
- A user can inspect fictional appointments and FAQs without entering real health information.
- A call/test action is clearly marked as a paid live test when real Retell credentials are enabled.
- Live calls and texts are restricted to the owner's approved tester phone numbers.

### Staff workspace
- Responsive browser UI with a clinic selector, timezone indicator, task queue, appointment calendar/list, FAQs, and demo reset.
- Accessible keyboard navigation, clear focus, readable error messages, and mobile-friendly layouts.
- No clinical dashboard, symptom scoring, or diagnosis display.

## 8. Success measures and acceptance criteria

The first reviewable demo is successful when:

1. A fake caller can book, reschedule, cancel, and join a waitlist through the scheduler.
2. The voice agent can complete those flows through the same scheduler API.
3. The agent never claims a write succeeded when the API did not confirm it.
4. The approved FAQ covers at least the topics in Section 6.4 and refuses or escalates clinical questions.
5. A staff member can see appointments, follow-up tasks, document status, and message outcomes.
6. The reminder job sends only one confirmation/reminder/follow-up per qualifying event and respects timezone and quiet-hour settings.
7. Changing market/timezone changes display and scheduling interpretation without changing the stored instant.
8. A failed provider call creates a visible follow-up task instead of losing the request.
9. Public screens, seeded data, sample uploads, and logs contain no real patient records.
10. The demo can be reset without contacting real patients or deleting unrelated HVAC data.
11. Real voice and SMS are disabled by default and protected by test-number allowlists, duration caps, daily limits, and message caps.
12. Setup and deployment can be reproduced from the new repository without secrets committed to Git.

## 9. Phased delivery proposal

### Phase 0 — product and technical design
Review this PRD and architecture, settle market/language/test-number choices, then freeze MVP scope.

### Phase 1 — local demo
Build the web console, fake clinic/scheduler, sample FAQs, synthetic appointments, document checklist, local message/call adapters, and complete admin workflows. No external account required.

### Phase 2 — cloud demo
Deploy the Cloudflare Worker and static UI through GitHub Actions; use a private `healthcare` schema in a separate free Supabase project; seed synthetic data; add a scheduled reminder job. Keep real provider modes off.

### Phase 3 — live voice pilot
Configure a Retell inbound agent and one test number in one chosen market. Enable only approved test numbers, short calls, limited daily usage, and minimal call data retention.

### Phase 4 — SMS pilot
Connect the selected country-capable SMS provider, verify opt-in/opt-out, templates, quiet hours, delivery status, and deduplication using test numbers only.

### Phase 5 — broaden the demo
Enable additional markets, timezones, and reviewed languages; add waitlist, callback, records/refill/billing intake, analytics, and more FAQ content.

### Phase 6 — real clinic readiness (separate scope)
Choose EHR/scheduler, phone/SMS vendors, data-region requirements, access model, retention, legal/contract controls, and security review. The demo must not be used as a real clinic service before this work is complete.

## 10. Decisions still needed before implementation

1. Additional languages beyond English are not selected; add them only after the owner chooses and reviews them.
2. Which European countries are in the first release? “Europe” is not one timezone, phone market, language, or privacy jurisdiction.
3. Should document upload accept only supplied synthetic examples, or arbitrary test files? Recommendation: synthetic examples only for public use.
4. What call-recording/transcript retention is acceptable? Recommendation: recording off; store only a short admin summary and delete it after a short configured period.
5. Which country should be the first live voice/SMS pilot? The owner named four markets; live provider cost and number availability should be checked per country.

## 11. Glossary

- **Demo scheduler:** Fictional data and availability owned by this application; no real EHR or calendar.
- **Clinic timezone:** IANA timezone used to determine when the clinic is open and when appointments/reminders occur.
- **Human handoff:** A staff callback or transfer request with a short administrative summary.
- **Approved FAQ:** Clinic-authored information reviewed before the AI can use it.
- **Synthetic data:** Invented people, appointments, and documents that do not identify real patients.
