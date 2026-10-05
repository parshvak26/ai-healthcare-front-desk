# Hosting and low-cost rollout

## Current state

- The public React website is hosted on GitHub Pages: `https://parshvak26.github.io/ai-healthcare-front-desk/`.
- GitHub Actions builds the website from `main`. It uses the `VITE_API_BASE_URL` repository variable when set, with the demo Worker URL as a default.
- Healthcare uses a separate Supabase project, keeping its service key separate from HVAC. The private schema migration is applied and verified. The Cloudflare Worker now targets the protected Supabase RPC functions; its encrypted Production secret is set, and `/api/health` confirms the database connection. The old D1 migration is retained as history.
- The Cloudflare Worker API is deployed at `https://ai-healthcare-front-desk-api.halo-voice-parshva.workers.dev`. It uses synthetic data, simulates reminders, and accepts Retell events only from configured test numbers.
- Cloudflare persisted observability logs and preview URLs are disabled in the Worker configuration to keep the demo small and avoid unnecessary public preview endpoints. Use `wrangler tail` for temporary diagnostics when needed.
- The Healthcare Retell draft has eight custom functions configured, including the waitlist. It is unpublished and has no phone number; the Worker's caller allowlist is empty, so tool actions are rejected until a test caller is explicitly configured.
- SMS is mock-only. The Worker does not call an SMS provider, and the reminder job only updates fictional message records.

## Step 1 — Website

The `Build and deploy demo website` workflow installs the locked dependencies, builds `apps/web`, and publishes it to GitHub Pages. The repository must use the **GitHub Actions** Pages source. The repository is public so Pages works on the free GitHub plan.

## Step 2 — Private API and database

Use the separate Supabase project for healthcare; do not put the healthcare key in the HVAC Worker. The browser never connects to Supabase; only the Worker holds the server-side key. Access uses service-role-only RPC functions, so the private schema does not need to be exposed through the public API.

1. **Done:** `supabase/migrations/20261003000100_healthcare_demo_backend.sql` is applied in the healthcare Supabase project. It creates only the private `healthcare` schema and its tables/functions.
2. **Done:** The Supabase server-side secret is stored in Cloudflare Production as `SUPABASE_SECRET_KEY`. It is not in GitHub or the website.
3. **Done:** `ai-healthcare-front-desk-api` is deployed from `wrangler.toml` and uses the Supabase-backed Worker source.
4. **Verified:** `/api/health` reports `synthetic-demo`, `databaseConnected: true`, and both live calling and live SMS disabled.
5. **Done:** The website workflow defaults to the Worker URL; no `VITE_API_BASE_URL` override is needed.
6. **Verified:** The public site shows the shared cloud demo and loads its sample data through the Worker.

The Supabase secret is already stored in Cloudflare Production; never put it in GitHub or the website. The Retell webhook-signing key is also stored as an encrypted Cloudflare Production secret. Do not expose either key in chat or source files. The worker's test-number allowlist is still empty, so Retell calls cannot run its tools. Example local secret names are in `apps/worker/.dev.vars.example`.

## Step 3 — Retell voice setup

The Healthcare draft agent and its eight custom functions are configured; the signed webhook key is stored as an encrypted Cloudflare Production secret. The agent has no phone number, and no caller is allowlisted. Keep it unpublished until a test market, number, and spend limit are chosen.

1. **Done:** The separate Healthcare demo agent exists; the HVAC agent is unchanged.
2. **Done:** The prompt and functions in the Retell folder point to the custom-function Worker route.
3. **Done:** Retell signs function requests. The Worker verifies X-Retell-Signature using the server-side API key; do not add a key as a custom request header or expose it to the website.
4. **Pending:** Choose one pilot country, assign a Healthcare phone number, allowlist only your test number, and set a short call-duration and daily limit before any live test.
5. Keep the call-event webhook unconfigured unless a specific event workflow is needed. Do not publish the agent or make a call as part of setup.

**Call data flow:** Retell's default custom-function body includes the caller number and conversation transcript up to the tool call. Retell sends that body to the Cloudflare Worker. The Worker uses the caller number for its allowlist and the call ID for idempotency; it ignores the transcript and does not log or store the number or transcript. Retell's own transcript and recording retention is a separate setting and must be reviewed before live calls. Use fictional details only. See [Retell custom-function request format](https://docs.retellai.com/build/single-multi-prompt/custom-function).

Retell dashboard tests and calls may use account credit. No number has been bought and no live test call has been run. A phone number may add a recurring charge; the owner must review and complete any purchase. The Worker allowlist stays empty until a test number is chosen.

## Step 4 — Text reminders (later)

The app currently records only simulated confirmations, 24-hour appointment reminders, and a missing-document follow-up 48 hours after booking. Live SMS stays off until one market, sender, provider, opt-in wording, opt-out handling, and per-message cost are chosen. Do not enable SMS for all markets based on the demo timezone dropdown alone.

Retell's own A2P SMS add-on for its Twilio numbers is limited to US numbers. Its current published fees are $4 one-time for a low-volume brand or $45 for standard, $15 for the campaign application, then $20/month per number plus $0.01 per text. That makes it a poor fit for a minimal-cost, multi-market reminder system, so the demo does not apply for it. See [Retell's SMS setup and fees](https://docs.retellai.com/deploy/enable-sms).

## Cost approach

- Keep GitHub Pages, Cloudflare Worker, and the existing Supabase project on free tiers for synthetic data.
- Reuse the current Supabase free project rather than create another one. Check its dashboard quotas before increasing usage.
- Current Cloudflare documentation lists 100,000 Worker requests/day on the Free plan. [Cloudflare Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- Retell lists voice AI at $0.07–$0.31/minute. A call can cost money even when used for testing, so live calls stay disabled until the owner explicitly chooses a budget and test number. [Retell pricing](https://www.retellai.com/pricing)
- SMS prices differ sharply by destination. Snapshot checked 2026-10-05: Twilio lists U.S. SMS at $0.0083 per segment plus carrier fees, with A2P 10DLC registration costs and a $1.15/month long-code number; India outbound SMS is listed at $0.0832 per segment. Twilio's UAE guide says two-way SMS is not supported. These are not all-in quotes; check the selected country's current rate and sender rules before setup. [U.S. SMS pricing](https://www.twilio.com/en-us/sms/pricing/us), [India SMS pricing](https://www.twilio.com/en-us/sms/pricing/in), [UAE SMS guidelines](https://www.twilio.com/en-us/guidelines/ae/sms)
- If any dashboard prompts for a paid plan, extra phone number, credit purchase, or paid SMS sender, stop before accepting it.

## Privacy and production boundary

This public portfolio demo contains synthetic data only. Do not enter real patient information, upload real records, or describe this system as compliant for patient care. A real clinic deployment needs its own security review, data-region and vendor selection, contracts, identity/access controls, retention plan, and legal review. GitHub Pages remains the static demo host, not the production clinic service.
