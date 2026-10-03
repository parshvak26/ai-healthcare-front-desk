# Run the demo locally

This project currently runs as a browser-only demo. It uses fictional seed data and saves your changes in this browser's local storage. Phone, SMS, Retell, Supabase, and file storage are not connected.

## Requirements

- Node.js 24 or newer
- npm (included with Node.js)

## Start the website

From the repository folder:

1. Install the pinned dependencies with `npm ci`.
2. Start the local website with `npm run dev`.
3. Open the local address printed in the terminal.

To prepare the static website bundle, run `npm run build`.

## Explore the demo

- Use the market control to switch among USA, UAE, Europe, and India.
- Change the clinic schedule timezone and your display timezone separately.
- Create, move, or cancel fictional appointments.
- Review FAQs, sample referral records, simulated messages, and the staff follow-up queue.
- Use “Simulate a call” to explore appointment and administrative handoff flows.
- Open Settings and choose “Reset sample data” to restore the original examples.

Every interaction is local to this browser. Do not enter real patient details or upload medical documents. No real calls or texts are placed.
