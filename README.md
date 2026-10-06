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
- **"Call me" demo calls.** Like the HVAC site, a visitor can enter a US number or an Indian mobile (+91), tick consent, pass a Cloudflare Turnstile check, and receive one AI call. The Worker asks Retell to call from the shared demo number (+1 512 823 1502) with the Healthcare agent as a one-time override, so the number's own settings (HVAC) are not changed. Limits: 10 visitor calls a day, 3 per IP a day, one per number every 30 minutes, 5 minutes per call; the owner's numbers (`RETELL_TEST_NUMBERS`) are exempt. Only salted hashes of the number and IP are stored. `DEMO_CALLS = "off"` in `wrangler.toml` (or the Cloudflare dashboard) stops new calls at once.
- The Retell agent has ten custom functions (including appointment lookup and confirmation). Its tools only act for calls this Worker started or for allowlisted test numbers.
- Texts and reminders are simulated only. No SMS provider is connected and no text is sent.
- No real patient data or uploaded file contents are used by this public demo, and the demo keeps no call recording or transcript.

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
