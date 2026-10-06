# AI Healthcare Front Desk

A low-cost portfolio demo for an AI healthcare front desk. It focuses on administrative work such as appointment scheduling, approved FAQs, referral follow-up, staff requests, and simulated reminders. It does not provide clinical advice.

## Current state

- The product requirements and architecture are documented in `docs/PRD.md` and `docs/ARCHITECTURE.md`.
- **One set of rules for every channel.** Booking, rescheduling, cancelling, confirming, visit outcomes, the waitlist, documents, staff tasks, text preferences, and the reminder job all live in `packages/shared/src/domain.ts`. The staff console, the Cloudflare Worker, and the Retell voice tools call the same functions.
- **The server is the source of truth.** In cloud mode the console sends one validated action at a time to the Worker and shows "confirmed" only after the Worker saves it. A slot taken by someone else is refused with a clear message, never shown as booked. Retries reuse an idempotency key, so a repeated click or voice tool call cannot create a duplicate.
- The console offers real availability (weekday 8 AM–5 PM, 30-minute steps, two fictional providers) for booking and moving appointments, plus confirm, cancel, attended/no-show, search, and a change history.
- Booking adds a simulated confirmation, a 24-hour reminder (when the visit is more than a day away), and — for new patient visits and consultations — a referral checklist item, a staff task, and one 48-hour missing-document follow-up. Simulated texts respect quiet hours (9 AM–8 PM clinic time) and a per-patient STOP/START preference.
- The waitlist hands a cancelled or moved opening to staff as a follow-up task; it never books or texts anyone automatically. Missed visits create a rebooking task.
- The FAQ page includes a "test a caller question" box that runs the same approved-answer lookup as the voice tool: refill requests go to staff, medical and medication questions get the approved safety answer, emergencies get the local-emergency message, and unknown questions are never answered from general knowledge.
- Market and timezone controls cover USA, UAE, Europe, and India. English is the initial language.
- Healthcare uses its own Supabase project and private schema, separate from HVAC. The Worker is the only database client; the browser never receives database credentials.
- The Retell draft agent has ten custom functions (including appointment lookup and confirmation) and is unpublished with no phone number. The Worker only answers allowlisted test numbers, and none are configured, so no call can change demo data.
- Texts and reminders are simulated only. No SMS provider is connected and no text is sent. Live calls and SMS are hard-wired off in the Worker.
- No real patient data, uploaded file contents, phone calls, or texts are used by this public demo.

## Run locally

1. Install Node.js 24 or newer.
2. From this folder, run `npm ci`.
3. Run `npm run dev` and open the local address shown in the terminal. Without an API URL the console keeps a private copy in your browser and uses the same rules.
4. Run `npm run check` to type-check, run the automated tests, and build the website.

The demo's sample records can be restored from Settings. Do not enter real health or personal information.

## Planning documents

- [Product requirements](docs/PRD.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Deployment](docs/DEPLOYMENT.md)
- [Local setup](docs/LOCAL_SETUP.md)
- [Interactive architecture diagram](docs/architecture-diagram.html)
