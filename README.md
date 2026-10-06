# AI Healthcare Front Desk

A low-cost portfolio demo for an AI healthcare front desk. It focuses on administrative work such as appointment scheduling, approved FAQs, referral follow-up, staff requests, and simulated reminders. It does not provide clinical advice.

## Current state

- The product requirements and architecture are documented in `docs/PRD.md` and `docs/ARCHITECTURE.md`.
- **Implemented, not deployed yet.** The branch `feat/call-page` adds a call page, a private demo for every visitor, and browser calls (described below). None of it is live: the deployed website, Worker, database, and Retell agent still run the previous version. Moving to the new version is the five-step rollout in `docs/DEPLOYMENT.md`, and every step needs the owner's approval.

| Part | Live today | On `feat/call-page` (not deployed) |
|---|---|---|
| Website | Console with a "Call me" panel and one shared demo clinic | Call page at `#/`, clinic staff screen at `#/staff`, a private demo per visitor |
| Worker | API version 2 | API version 3 |
| Supabase | Migrations `20261003000100` and `20261006000100` applied | Adds `20261007000100_healthcare_visitor_workspaces.sql` (not applied) |
| Retell agent | Published version 0, with `search_approved_faq` | New prompt and tools in `retell/` (not published) |

### Call page (implemented, not deployed)

- **Talk to the AI.** The website opens on a call page (`#/`). A visitor can get a phone call (US +1 or India +91) or talk in the browser (a Retell web call over the microphone, using `retell-client-js-sdk` 3.0.2, loaded only when "Talk in browser" is shown). Both need consent and a Cloudflare Turnstile check. Ava, the AI receptionist of the fictional Harbor Health clinic, answers. Phone calls come from the shared demo number (+1 512 823 1502) with the Healthcare agent as a one-time override, so the number's own settings (HVAC) are not changed.
- **Clinic staff screen.** The console moved to `#/staff`. Its "Talk to the AI" buttons link back to the call page. The click-through call simulation is removed. A browser call keeps running when the visitor opens the staff screen, and a small bar shows the call.
- **A private demo for every visitor.** A random key kept in the browser (sent as the `X-Demo-Visitor` header) selects the visitor's own copy of the clinic. The Worker turns the key into a workspace ID with an HMAC and never stores or logs the key. Calls and staff-screen changes only affect that copy. It is deleted 7 days after last use. **Delete my demo data** (on the call page and in Settings) deletes it at once, unless a call is active. **Reset my demo** restores the sample records. The shared demo clinic is retired.
- **Names.** A caller can give any name: letters in any script, spaces, apostrophes, hyphens, and periods, no digits. New names can only come from voice calls. The staff screen offers the five sample patients plus the names used on the visitor's own calls. Names are never sent to Retell as call data or in the greeting.
- **Call status and summary.** Retell reports `call_started` and `call_ended` to a per-call webhook (`RETELL_EVENTS_URL`); if no event arrives, the Worker asks Retell for the call's status. The page shows calling, on the call, and ended. After the call it shows a summary built in the browser from the visitor's own private demo, and an "Under the hood" list of tool timings. No transcript is stored.
- **Limits.** One budget is shared by phone and browser calls: 10 a day (UTC day), 3 per connection in any 24 hours, 5 minutes per call, one call per phone number every 30 minutes, and one active call per browser. A call counts unless there is evidence it never connected. The owner's numbers (`RETELL_TEST_NUMBERS`) skip the phone limits only; the one-active-call rule applies to everyone, and browser calls have no owner exemption.
- **Wrong number.** If the person who answers says they did not ask for the call, the agent calls `report_wrong_number` and that number is blocked for 30 days (only its hash is kept).
- **Switches.** `DEMO_CALLS = "off"` stops all new calls at once. `DEMO_WEB_CALLS = "off"` stops only browser calls. Both are set in `wrangler.toml` (or the Cloudflare dashboard).
- **Voice agent.** Ten custom functions: `search_approved_faq` is replaced by `report_wrong_number`, and the approved answers are in the prompt. The Worker sends per-call context (dates, a 14-day calendar, new or returning caller, time zone, emergency number) as variables. The tools only act for calls this Worker started or for allowlisted owner numbers, on the private demo named in the call's signed metadata. `RETELL_AGENT_VERSION` pins the published agent version the Worker is paired with.
- **Data.** No phone number, transcript, or recording is stored. Keyed hashes of the number and the connection are kept to enforce the limits (the number hash is cleared after 24 hours, or kept for 30 days after a wrong-number report). Retell processes call audio; the agent is set to "Basic Attributes Only" data storage.

### Front desk and staff screen

- **Live today: "Call me".** The current console has a "Call me" panel: one AI call to a US or Indian number from the shared demo number, 10 visitor calls a day, 3 per IP a day, one per number every 30 minutes, 5 minutes per call. The call page replaces it.
- **One set of rules for every channel.** Booking, rescheduling, cancelling, confirming, visit outcomes, the waitlist, documents, staff tasks, text preferences, and the reminder simulation all live in `packages/shared/src/domain.ts`. The staff screen, the Cloudflare Worker, and the Retell voice tools call the same functions.
- **The server is the source of truth.** In cloud mode the staff screen sends one validated action at a time to the Worker and shows "confirmed" only after the Worker saves it. A slot taken by someone else is refused with a clear message, never shown as booked. Retries reuse an idempotency key, so a repeated click or voice tool call cannot create a duplicate.
- The staff screen offers real availability (weekday 8 AM–5 PM, 30-minute steps, two fictional providers) for booking and moving appointments, plus confirm, cancel, attended/no-show, search, and a change history. Changes made by the voice assistant in the last 30 minutes are tagged "From your call".
- Booking adds a simulated confirmation, a 24-hour reminder (when the visit is more than a day away), and — for new patient visits and consultations — a referral checklist item, a staff task, and one 48-hour missing-document follow-up. Simulated texts respect quiet hours (9 AM–8 PM clinic time) and a per-patient STOP/START preference.
- The waitlist hands a cancelled or moved opening to staff as a follow-up task; it never books or texts anyone automatically. Missed visits create a rebooking task.
- The FAQ page includes a "test a caller question" box that runs the approved-answer lookup: refill requests go to staff, medical and medication questions get the approved safety answer, emergencies get the local-emergency message, and unknown questions are never answered from general knowledge. The voice agent's prompt carries a spoken version of each approved answer, and a test keeps the two in sync.
- Market and timezone controls cover USA, UAE, Europe, and India. English is the initial language.
- Healthcare uses its own Supabase project and private schema, separate from HVAC. The Worker is the only database client; the browser never receives database credentials.
- Texts and reminders are simulated only. No SMS provider is connected and no text is sent.
- No real patient data or uploaded file contents are used by this public demo, and the demo keeps no call recording or transcript.

## Run locally

1. Install Node.js 24 or newer.
2. From this folder, run `npm ci`. If you already have `node_modules` from an earlier checkout, run `npm install` again: the website now depends on `retell-client-js-sdk`.
3. Run `npm run dev` and open the local address shown in the terminal. The call page (`#/`) opens first. Without an API URL, calls are off, and the clinic staff screen (`#/staff`) keeps a private copy in your browser and uses the same rules.
4. Run `npm run check` to type-check, run the automated tests, and build the website.

The demo's sample records can be restored from Settings (**Reset my demo**). Do not enter real health or personal information.

## Planning documents

- [Product requirements](docs/PRD.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Deployment](docs/DEPLOYMENT.md)
- [Local setup](docs/LOCAL_SETUP.md)
- [Interactive architecture diagram](docs/architecture-diagram.html) (shows the target system; not yet updated for the call page)
- [Call page plan](docs/plans/call-page-plan.md) and [API contract](docs/plans/call-page-contract.md): written before the code. Where they differ from the code, the code and the documents above are right.
