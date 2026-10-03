# Run the demo on your computer

The website works locally with fictional sample data and does not need provider accounts, phone numbers, API keys, or a database. It saves changes in your browser.

## Start the website

1. Install Node.js 24 or newer.
2. Open a terminal in the project folder.
3. Run `npm ci` to install the locked packages.
4. Run `npm run dev`.
5. Open the local address printed in the terminal.

## Explore the sample clinic

- Switch among USA, UAE, Europe, and India.
- Choose the clinic schedule timezone and your own display timezone.
- Book, move, or cancel fictional appointments.
- Review approved admin FAQs, referral status, simulated messages, and the staff follow-up queue.
- Use **Simulate a call** to explore appointment and staff handoff flows.
- Open Settings and select **Reset sample data** to restore the examples.

## Optional local API

The website works on its own with browser local storage. Connecting the local Worker to the shared API needs the Supabase server-side credentials and should use fictional data only.

1. Add `SUPABASE_URL` and `SUPABASE_SECRET_KEY` to the ignored `apps/worker/.dev.vars` file using the example template.
2. Run `npm run dev:api` to start the Worker at `http://localhost:8787`.
3. Copy `apps/web/.env.example` to `apps/web/.env.local` and set `VITE_API_BASE_URL=http://localhost:8787`.
4. Restart `npm run dev` so the website connects to the local Worker.

Local Retell secrets are optional and not needed for the demo. If you add them later, use the ignored `apps/worker/.dev.vars` file based on `apps/worker/.dev.vars.example`; never put secrets in the website, Vite variables, or Git. Do not add real patient details, uploaded medical records, or real caller numbers to this demo.

## Demo boundaries

- Appointment, call, and text flows use fictional records only.
- No actual call or SMS is sent. The reminder job changes sample message status only.
- Document receipt is represented by a sample status. File contents are not uploaded or stored.
- This project is not a clinic service and must not be used with real health information.
