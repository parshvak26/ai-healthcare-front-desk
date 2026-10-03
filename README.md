
# AI Healthcare Front Desk

A low-cost portfolio demo for an AI healthcare front desk. It focuses on administrative work such as appointment scheduling, approved FAQs, referral follow-up, staff requests, and simulated reminders. It does not provide clinical advice.

## Current state

- The product requirements and architecture are documented in `docs/PRD.md` and `docs/ARCHITECTURE.md`.
- The browser demo works with fictional appointments, staff tasks, referral status, approved FAQs, and simulated call/SMS workflows.
- Booking adds a simulated confirmation, 24-hour appointment reminder, and (when a sample referral is missing) 48-hour follow-up. Rescheduling or completing documents updates the sample queue.
- Market and timezone controls cover USA, UAE, Europe, and India. English is the initial language.
- A Cloudflare Worker API and D1 migration are included. A separate D1 demo database has been created; its migration and Worker deployment are the remaining cloud setup steps.
- Retell tool contracts are prepared, but live calling is off. The signed-in Retell workspace currently shows the service as deactivated, so no calls can be placed.
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
