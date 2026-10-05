
# AI Healthcare Front Desk

A low-cost portfolio demo for an AI healthcare front desk. It focuses on administrative work such as appointment scheduling, approved FAQs, referral follow-up, staff requests, and simulated reminders. It does not provide clinical advice.

## Current state

- The product requirements and architecture are documented in `docs/PRD.md` and `docs/ARCHITECTURE.md`.
- The browser demo works with fictional appointments, staff tasks, referral status, approved FAQs, and simulated call/SMS workflows.
- Booking adds a simulated confirmation, 24-hour appointment reminder, and (when a sample referral is missing) 48-hour follow-up. Rescheduling or completing documents updates the sample queue.
- The demo includes a sample waitlist. Cancelling a matching appointment creates a staff follow-up; it never automatically books or texts someone.
- Market and timezone controls cover USA, UAE, Europe, and India. English is the initial language.
- Healthcare uses its own Supabase project and private schema, separate from HVAC. The migration creates 3 private tables and 5 server-only functions without changing HVAC's `public.sessions` table. The Cloudflare Worker is deployed against Supabase, and its health endpoint confirms the database connection.
- The Retell webhook-signing key is stored as an encrypted Production secret in Cloudflare. The Healthcare draft has eight custom functions configured, including the waitlist, but it is unpublished and has no phone number or allowed test caller.
- Retell custom-function requests include the caller number and current transcript by default. The Worker uses the number for its allowlist, ignores the transcript, and does not log or store either. Retell's own transcript-retention setting is separate and must be reviewed before live calls.
- Texts and reminders are simulated only. No SMS provider is connected and no text is sent.
- No real patient data, uploaded file contents, phone calls, or texts are used by this public demo.

## Run locally

1. Install Node.js 24 or newer.
2. From this folder, run `npm ci`.
3. Run `npm run dev` and open the local address shown in the terminal.
4. To make a production bundle, run `npm run build`.

The demo's sample records can be restored from Settings. Do not enter real health or personal information.

## Planning documents

- [Product requirements](docs/PRD.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Interactive architecture diagram](docs/architecture-diagram.html)
