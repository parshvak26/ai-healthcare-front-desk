# Run the demo on your computer

The website works locally with fictional sample data and does not need provider accounts, phone numbers, API keys, or a database. It saves changes in your browser. Calls need the Worker, so they are off in this mode.

This page describes the code on the branch `feat/call-page` (the call page and private demos). The deployed site is not updated yet; see [DEPLOYMENT.md](DEPLOYMENT.md).

## Start the website

1. Install Node.js 24 or newer.
2. Open a terminal in the project folder.
3. Run `npm ci` to install the locked packages. If you already have `node_modules` from an earlier checkout, run `npm install` again: the website now depends on `retell-client-js-sdk` (3.0.2, used for browser calls), and the type-check and build fail without it.
4. Run `npm run dev`.
5. Open the local address printed in the terminal.

## Pages

The website has two screens, selected by the address after `#`:

- `#/` is the call page and the default (an unknown address also opens it). Without a Worker it says that calls are off and offers the staff screen.
- `#/staff` is the **Clinic staff screen**, the sample clinic. Open it with the button on the call page, or add `#/staff` to the address. **Talk to the AI** on the staff screen goes back to the call page.

Back and forward work between the two. The old "Simulate a call" walkthrough no longer exists.

## Explore the sample clinic

- Switch among USA, UAE, Europe, and India.
- Choose the clinic schedule timezone and your own display timezone. Your display time starts at your device's timezone.
- Book, move, or cancel fictional appointments. The patient list has the five sample patients. Names given on voice calls only appear in a private demo that has had calls.
- Review approved admin FAQs, referral status, simulated messages, and the staff follow-up queue.
- On the FAQ page, use **Test a caller question** to see how the approved-answer lookup responds.
- On the Messages page, simulate a patient replying STOP or START.
- Open Settings and select **Reset my demo** to restore the examples, or **Delete my demo data** to remove the copy kept in this browser.

## Check your changes

Run `npm run check`. It type-checks the shared rules, the Worker, and the website, runs the automated tests (`npm test`), and builds the website. The tests cover the shared rules, the Worker routes, the call limits, and the Retell agent files (the prompt and `retell/tools.json` must match the Worker). They use an in-memory stand-in for the database and mocked Retell and Turnstile responses, and never contact Retell, Supabase, or an SMS provider or place a call. The website itself has no automated browser tests; it is type-checked and built.

## Optional local API

The website works on its own with browser local storage. Connecting the local Worker to the shared API needs the Supabase server-side credentials and should use fictional data only.

1. Add `SUPABASE_URL` and `SUPABASE_SECRET_KEY` to the ignored `apps/worker/.dev.vars` file using the example template. The Supabase project must have all three migrations in `supabase/migrations/` applied. Without `20261007000100_healthcare_visitor_workspaces.sql`, `/api/health` reports `databaseConnected: false` and the website falls back to the browser-only copy.
2. Run `npm run dev:api` to start the Worker at `http://localhost:8787` (Wrangler 4.147 or newer is needed for the Worker's compatibility date; `npm ci` installs it).
3. Copy `apps/web/.env.example` to `apps/web/.env.local` and set `VITE_API_BASE_URL=http://localhost:8787`.
4. Restart `npm run dev` so the website connects to the local Worker.

With the local Worker, this browser gets its own private demo (the website keeps a random visitor key in browser storage and sends it as `X-Demo-Visitor`). The staff screen then shows `PRIVATE DEMO · ONLY YOU SEE THIS`. The retention job (a cron trigger of the deployed Worker) deletes it 7 days after last use, or you can remove it at once with **Delete my demo data**.

The Worker reads the non-secret settings in `wrangler.toml` locally too, including `DEMO_CALLS = "on"`. Calls still stay off unless `RETELL_API_KEY` and `TURNSTILE_SECRET_KEY` are also set. Placing a real call from a local website is not supported by default: calls cost money, and the Worker accepts the security-check token only for the host in `TURNSTILE_HOSTNAME` (the GitHub Pages host). Test calls on the deployed site, as described in [DEPLOYMENT.md](DEPLOYMENT.md).

Local Retell secrets are optional and not needed for the demo. If you add them later, use the ignored `apps/worker/.dev.vars` file based on `apps/worker/.dev.vars.example`; never put secrets in the website, Vite variables, or Git. Do not add real patient details, uploaded medical records, or real caller numbers to this demo.

## Demo boundaries

- Appointment, call, and text flows use fictional records only.
- A local copy places no call and sends no SMS. The reminder simulation changes sample message status only.
- Document receipt is represented by a sample status. File contents are not uploaded or stored.
- This project is not a clinic service and must not be used with real health information.
