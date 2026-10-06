# Hosting and low-cost rollout

## Current state

**Live today** (the previous version; nothing from the call page is deployed):

- The public React website is hosted on GitHub Pages: `https://parshvak26.github.io/ai-healthcare-front-desk/`.
- GitHub Actions builds the website from `main`. It uses the `VITE_API_BASE_URL` repository variable when set, with the demo Worker URL as a default. It also passes the public Turnstile site key (`VITE_TURNSTILE_SITE_KEY`, not a secret) with a default.
- Healthcare uses a separate Supabase project, keeping its service key separate from HVAC. The private schema migrations `20261003000100_healthcare_demo_backend.sql` and `20261006000100_healthcare_demo_calls.sql` are applied and verified. The Cloudflare Worker targets the protected Supabase RPC functions; its encrypted Production secret is set, and `/api/health` confirms the database connection. The old D1 migration is retained as history.
- The Cloudflare Worker API is deployed at `https://ai-healthcare-front-desk-api.halo-voice-parshva.workers.dev` (API version 2). It uses synthetic data in one shared demo clinic, simulates reminders, and answers Retell tool calls only for "Call me" calls it started or for configured test numbers.
- Cloudflare persisted observability logs and preview URLs are disabled in the Worker configuration to keep the demo small and avoid unnecessary public preview endpoints. Use `wrangler tail` for temporary diagnostics when needed.
- The Healthcare Retell agent has ten custom functions configured (availability, book, look up, confirm, reschedule, cancel, waitlist, FAQ, staff follow-up, document status), each with a 15-second timeout and no retries. It is published (version 0, "Web call-me demo") but not attached to any phone number. Its tools act only for "Call me" calls this Worker started (signed by Retell, Healthcare agent, this Worker's metadata marker) or for numbers in `RETELL_TEST_NUMBERS`.
- SMS is mock-only. The Worker does not call an SMS provider, and the reminder job only updates fictional message records.

**Implemented on branch `feat/call-page`, not deployed:**

- Website: a call page at `#/` (phone calls to US +1 and India +91 numbers, and browser calls using `retell-client-js-sdk` 3.0.2), the console moved to `#/staff` ("Clinic staff screen"), and a private demo per visitor. The click-through call simulation is removed.
- Worker: API version 3 (routes in [ARCHITECTURE.md](ARCHITECTURE.md) section 8). Visitor demos, one call budget for phone and browser calls, per-call webhooks, wrong-number blocking, and a cron job that only purges. `wrangler.toml` already holds the new settings `DEMO_WEB_CALLS`, `RETELL_EVENTS_URL`, and `RETELL_AGENT_VERSION`.
- Database: `supabase/migrations/20261007000100_healthcare_visitor_workspaces.sql` (additive; not applied). The shared snapshot table and the first-generation call functions stay in place, unused, until a later cleanup migration.
- Retell: `retell/AGENT_PROMPT.md` and `retell/tools.json` describe the next agent version (not published): `report_wrong_number` replaces `search_approved_faq`, 10-second timeouts, and the approved answers inside the prompt.

## Rollout for the call page

Do these five steps in this order. **Each step changes a live system or spends money, so each needs the owner's approval before it is done.** The tests and the build never do any of them. The order matters because the new Worker needs the new database functions, the new website needs the new Worker, and the Worker is pinned to an agent version so it never meets a prompt it was not built for.

1. **Apply the migration.** Apply `supabase/migrations/20261007000100_healthcare_visitor_workspaces.sql` in the healthcare Supabase project. It is additive and runs as one transaction: it creates `healthcare.visitor_workspaces` and new service-role-only functions, and adds columns to `demo_call_requests` and `retell_call_events`. It does not change or drop any function the live Worker calls, and its table changes are additive (new columns, a wider `status` check, `phone_hash` allowed to be empty), so the live site keeps working. Check that `select to_regclass('healthcare.visitor_workspaces');` returns the table name and that `/api/health` still shows `"databaseConnected":true`.
2. **Deploy the Worker, pinned to agent version 0.** Confirm `RETELL_AGENT_VERSION = "0"` in `wrangler.toml` (the value on the branch), then run `npm ci`, `npm run check`, and `npm run deploy:api`. Version 0 is the prompt published now; the new Worker still accepts that prompt's sample names, its `timezone` argument, and `search_approved_faq`. Run the checks under "Verification" below.
3. **Update the Retell agent and publish.** In the Retell dashboard, on the agent "Harbor Health Front Desk Demo":
   - Replace the prompt with the text block in `retell/AGENT_PROMPT.md`.
   - Set the functions from `retell/tools.json`: remove `search_approved_faq`, add `report_wrong_number`, and update the other nine (POST, 10-second timeout, 0 retries, "Payload: args only" off, and the "speak during execution" sentences given there).
   - Apply the "Dashboard settings" listed in `retell/AGENT_PROMPT.md`: temperature, voice speed, interruption and backchannel, denoising, end-of-silence and reminder timing, and **voicemail: hang up**. Data storage stays "Basic Attributes Only", the two guardrails stay on, and the agent gets no webhook URL of its own (each call sends one). The language model is the owner's choice; `AGENT_PROMPT.md` compares the two candidates.
   - Publish, and **write down the new version number**. The Worker is still pinned to 0, so live calls do not change yet.
   - Do not bind the agent to a phone number and do not change the shared number's settings (they belong to the HVAC demo).
4. **Pair the Worker with the new version.** Set `RETELL_AGENT_VERSION` in `wrangler.toml` to the new number (a string such as `"1"`), then run `npm run deploy:api`. From now on phone and browser calls use the new prompt and tools. Keep the pin: a later publish in Retell then changes nothing until the Worker is redeployed with the new number. Repeat the health checks.
5. **Publish the website.** Merge `feat/call-page` into `main` and run `git push origin main`. GitHub Actions type-checks, tests, builds, and publishes to GitHub Pages (see "Setup step 1" below). The site then opens on the call page.

**What visitors see in between.** After step 2 and until step 5, the website live today cannot reach its cloud demo: it sends no visitor key, so the Worker answers `409 reload_required`. A new page load falls back to its browser-only copy with an on-screen notice and no "Call me" panel; a tab that is already open is asked to reload. Nothing breaks, but calls from the website are unavailable, so do steps 2 to 5 in one sitting.

### Before step 2: settings and secrets

- The three new settings are plain variables in `wrangler.toml`, not secrets: `DEMO_WEB_CALLS = "on"`, `RETELL_EVENTS_URL` (this Worker's own `/webhooks/retell/events` URL), and `RETELL_AGENT_VERSION`. Browser calls stay off without `RETELL_EVENTS_URL`.
- No new secrets are needed. Calls stay off unless these Cloudflare secrets exist: `SUPABASE_SECRET_KEY`, `RETELL_API_KEY`, and `TURNSTILE_SECRET_KEY`. `RETELL_TEST_NUMBERS` (the owner's numbers) is optional. `npx wrangler secret list` shows which names are set, never their values. Set a missing one with `npx wrangler secret put <NAME>`; never paste a secret into a file or chat.

### Verification

After step 2, and again after step 4, open `https://ai-healthcare-front-desk-api.halo-voice-parshva.workers.dev/api/health` and confirm:

- `"apiVersion":3`.
- `"databaseConnected":true`. The check reads through a function that only exists after step 1, so it also proves step 1.
- `"liveCallsEnabled":true` and `demoCalls.enabled` is `true`. If it is `false` although `DEMO_CALLS` is `"on"`, a secret or setting is missing or malformed; the Worker fails closed. Check the three secrets above, `RETELL_FROM_NUMBER` (a US number in E.164 form), `RETELL_AGENT_ID`, `RETELL_AGENT_VERSION` (an integer, or unset), `RETELL_EVENTS_URL` (an `https` URL), and the numeric limits (within the ranges below).
- `demoCalls.web.enabled` is `true`. If `demoCalls.enabled` is `true` but this is `false`, `DEMO_WEB_CALLS` is not `"on"` or `RETELL_EVENTS_URL` is missing.
- `privateDemo.retentionDays` is `7`, `demoCalls.maxCallsPerDay` is `10`, and `demoCalls.maxMinutes` is `5`.

After step 5:

- The website opens on the call page with the call form, not "Live calls are off". The staff screen shows `PRIVATE DEMO · ONLY YOU SEE THIS`.
- Place your own test calls (each one costs money): a browser call and a phone call to your own number, which skips the phone limits. Try a new-patient booking, moving Maya Patel's visit `DEMO-4812`, a question about hours, and a callback request. Check the summary on the call page and the "From your call" tags on the staff screen. Then use **Delete my demo data** and confirm the next visit starts from the sample clinic.
- Not yet verified against a live call, so look at these on your test calls: Retell's per-call webhook for phone calls (if no event arrives, the call page still gets the status from Retell, a little slower), browser calls in Safari and on iOS, response speed, and an Indian number (see "Demo calls" below).

### Kill switches and rollback

- `DEMO_CALLS = "off"` stops all new calls, phone and browser. The call page then says calls are off and offers the staff screen.
- `DEMO_WEB_CALLS = "off"` stops only browser calls. "Call my phone" keeps working.
- Change the value in `wrangler.toml` and run `npm run deploy:api`, or edit the variable in the Cloudflare dashboard. A deploy from `wrangler.toml` replaces dashboard values, so change both. The switch applies to the next request; a call already running is not cut off and ends within 5 minutes.
- If the new agent version misbehaves, set `RETELL_AGENT_VERSION` back to `"0"` and redeploy. Version 0 still works with the new Worker.
- The migration needs no rollback: the previous Worker ignores what it adds. If the previous Worker is redeployed, the new website falls back to its browser-only copy because the API is too old.

## Releasing a change (order matters)

The website and the Worker deploy separately. Deploy the **Worker first**, then the website, so the new website never talks to an older API. If the website does reach an older Worker, it detects the API version from `/api/health` (it needs version 3) and falls back to a private browser copy with an on-screen notice instead of breaking. If a release adds a file to `supabase/migrations/`, apply it before deploying the Worker; the call page release does, so follow the rollout above.

From the project folder on your own computer (where Wrangler and GitHub are signed in):

1. `npm ci` and `npm run check` — type-check, tests, and build. No network calls to Retell, Supabase, Turnstile, or any SMS provider are made by the tests, and no call is placed.
2. `npm run deploy:api` — deploys the Worker (free plan; no new resources are created).
3. Open `https://ai-healthcare-front-desk-api.halo-voice-parshva.workers.dev/api/health` and confirm the expected `apiVersion` (3 once the call page is rolled out) and `"databaseConnected":true`.
4. `git push origin main` — GitHub Actions type-checks, tests, builds, and publishes the website.

## Demo calls: settings, secrets, and limits

The Worker can start one AI demo call per request with the Healthcare agent: a phone call from the shared Retell number `+1 512 823 1502` (`override_agent_id` and `override_agent_version`), or, on the call page, a browser call (`agent_id` and `agent_version`). The shared number's Retell configuration, which belongs to the HVAC demo, is never changed. The previous version offers only the phone call, through the "Call me" panel.

One-time setup, needed by the live "Call me" panel and by the call page:

1. **Done (2026-10-06):** Supabase: `supabase/migrations/20261006000100_healthcare_demo_calls.sql` is applied (private `healthcare.demo_call_requests` table, RLS on, no direct table access, service-role-only functions). The limits were checked inside a rolled-back block.
2. **Done (2026-10-06):** Retell: the Healthcare agent is published once (version 0). "Auto create a new draft" is on, so later edits stay in a draft until you publish them.
3. Cloudflare secrets, from this folder:
   - `npx wrangler secret put TURNSTILE_SECRET_KEY` — the secret of the Turnstile widget that already serves `parshvak26.github.io` for the HVAC demo (Cloudflare dashboard → Turnstile → that widget → Settings). The website uses its public site key.
   - `npx wrangler secret put RETELL_TEST_NUMBERS` — your own number(s) in E.164, comma-separated. These skip the phone limits. Optional.
4. `npm run deploy:api`, then confirm `/api/health` shows `"liveCallsEnabled": true`.

### Worker settings

All are plain variables in `wrangler.toml` unless marked secret. A malformed value turns calls off (the Worker fails closed).

| Setting | Value on the branch | Meaning |
|---|---|---|
| `DEMO_CALLS` | `"on"` | Master switch. Anything other than `"on"` means off. |
| `DEMO_WEB_CALLS` | `"on"` | Browser calls. Also needs `DEMO_CALLS = "on"` and `RETELL_EVENTS_URL`. |
| `RETELL_EVENTS_URL` | this Worker's `/webhooks/retell/events` URL | Sent with every call so Retell reports `call_started` and `call_ended` to the Worker. Must be `https`. |
| `RETELL_AGENT_VERSION` | `"0"` | Published agent version the Worker is paired with: an integer. Unset means `latest_published`. |
| `RETELL_FROM_NUMBER` | the shared demo number | Outbound number, a US number in E.164 form. |
| `RETELL_AGENT_ID` | the Healthcare agent | Agent used for both channels. |
| `TURNSTILE_HOSTNAME` | `parshvak26.github.io` | The only host whose security check is accepted. |
| `MAX_CALLS_PER_DAY` | `"10"` (1–1000) | Calls per UTC day, phone and browser together. |
| `MAX_CALLS_PER_IP_PER_DAY` | `"3"` (1–100) | Calls per connection in any 24 hours. |
| `PHONE_COOLDOWN_MINUTES` | `"30"` (1–1440) | Minutes before the same number can get another call. |
| `MAX_CALL_DURATION_SECONDS` | `"300"` (60–600) | Cap for each call; sent to Retell with every call. |
| `CLINIC_TIMEZONE` | unset (America/Chicago) | Optional clinic zone. |
| `SUPABASE_SECRET_KEY`, `RETELL_API_KEY`, `TURNSTILE_SECRET_KEY`, `RETELL_TEST_NUMBERS` | secrets | See "Before step 2". |

The call page's text and some of its messages state the default limits (3 calls per connection, 30 minutes per number). If you change `MAX_CALLS_PER_IP_PER_DAY` or `PHONE_COOLDOWN_MINUTES`, the Worker enforces the new value but that text does not change.

### Limits

Phone and browser calls share one budget. A request is checked in this order and refused at the first failure:

1. The number was reported as a wrong number in the last 30 days (phone only).
2. This browser already has a call that may still be live (see below).
3. The same number was called in the last 30 minutes (phone only).
4. This connection has used its 3 calls in the last 24 hours. A connection is the full IPv4 address, or the /64 prefix of an IPv6 address.
5. The day's 10 calls are used up (the day ends at 00:00 UTC).

The owner's numbers skip checks 1, 3, 4, and 5 and are not counted, for phone calls only. Check 2 applies to everyone, and browser calls have no owner exemption.

A call counts unless there is evidence it never connected: Retell refused to create it, or there was no `call_started` event and the call ended with a connection error (`error_*`, `registered_call_timeout`, `concurrency_limit_reached`, `telephony_provider_permission_denied`, `invalid_destination`, `dial_failed`, or `network_blocked`). Unanswered, declined, and hung-up calls count, and so does a call whose creation timed out at Retell, or a browser call the browser released because it could not connect. A call "may still be live" while it is younger than the call cap plus 90 seconds, has no `call_ended` event, was not released by the browser, and either has started or is younger than 2 minutes. After 2 minutes without a start it stops blocking the next call but still counts.

A wrong-number report (the agent's `report_wrong_number` tool) blocks that number for 30 days. Only the number's keyed hash is kept for that time.

### Retention

The Worker's cron job runs every 15 minutes and only purges; reminders are simulated whenever a private demo is read or changed. It deletes demos unused for 7 days, call events older than 30 days, call records older than 30 days (unless the number is blocked), and old rate-limit counters. It clears a call record's link to its demo 1 hour after the call ended (2 hours after the request at the latest), and clears the phone hash after 24 hours unless the number is blocked. The keyed connection hash stays on the call record until the record is deleted (30 days). The hashes are keyed with a value derived from `SUPABASE_SECRET_KEY`, so rotating that secret orphans existing private demos and the block list; visitors simply start from a fresh sample clinic.

### Cost

Retell lists voice AI at $0.07–$0.31/min (this agent shows about $0.139/min; this changes if the model changes) plus about $0.015/min telephony for phone calls. A 5-minute phone call is roughly $0.77 and a 5-minute browser call roughly $0.70, which has no telephony fee. With 10 calls a day the visitor worst case is about $7.70/day, plus your own test calls.

### India

The number's own "Allowed Outbound Countries" setting already allows all countries, but Retell also applies an account-level country whitelist (often only the US and Canada) that Retell support has to extend; for a Twilio-imported number, Twilio's voice geographic permissions for India apply too. If India is not enabled, an Indian call is either refused up front (the visitor sees a clear message and the attempt does not count towards the limits) or never rings; the call page then offers "Talk in browser", which works from any country. Test with your own Indian number before advertising it. Calls to India usually cost more per minute.

## Setup step 1 — Website

The `Build and deploy demo website` workflow installs the locked dependencies, type-checks, runs the automated tests, builds `apps/web`, and publishes it to GitHub Pages. The repository must use the **GitHub Actions** Pages source. The repository is public so Pages works on the free GitHub plan. The website uses hash routes (`#/` and `#/staff`), so Pages needs no rewrite rules. It is built with `VITE_API_BASE_URL` and the public `VITE_TURNSTILE_SITE_KEY` (the workflow has defaults for both); without the site key the call form cannot pass its security check.

## Setup step 2 — Private API and database

Use the separate Supabase project for healthcare; do not put the healthcare key in the HVAC Worker. The browser never connects to Supabase; only the Worker holds the server-side key. Access uses service-role-only RPC functions, so the private schema does not need to be exposed through the public API.

1. **Done:** `supabase/migrations/20261003000100_healthcare_demo_backend.sql` is applied in the healthcare Supabase project. It creates only the private `healthcare` schema and its tables/functions.
2. **Done:** The Supabase server-side secret is stored in Cloudflare Production as `SUPABASE_SECRET_KEY`. It is not in GitHub or the website.
3. **Done:** `ai-healthcare-front-desk-api` is deployed from `wrangler.toml` and uses the Supabase-backed Worker source.
4. **Verified:** `/api/health` reports `synthetic-demo`, `databaseConnected: true`, and live SMS disabled (live calling was off at that time; "Call me" came later).
5. **Done:** The website workflow defaults to the Worker URL; no `VITE_API_BASE_URL` override is needed.
6. **Verified:** The public site shows the shared cloud demo and loads its sample data through the Worker. The rollout above replaces the shared demo with private demos.
7. **Not applied yet:** `supabase/migrations/20261007000100_healthcare_visitor_workspaces.sql` (rollout step 1).

The Supabase secret is already stored in Cloudflare Production; never put it in GitHub or the website. The Retell webhook-signing key is also stored as an encrypted Cloudflare Production secret. Do not expose either key in chat or source files. Retell calls can run its tools only when the Worker started the call (phone or browser) or the caller is in `RETELL_TEST_NUMBERS`. Example local secret names are in `apps/worker/.dev.vars.example`.

## Setup step 3 — Retell voice setup

The Healthcare agent and its ten custom functions are configured (see `retell/tools.json` and `retell/AGENT_PROMPT.md`; the dashboard still has version 0, and the files describe the next version, see rollout step 3); the signed webhook key is stored as an encrypted Cloudflare Production secret. The agent is published for the website's "Call me" button and has no phone number of its own; it borrows the shared demo number per call.

1. **Done:** The separate Healthcare demo agent exists; the HVAC agent is unchanged.
2. **Done (version 0):** The prompt and functions point to the custom-function Worker route. Each function is POST, 15-second timeout, 0 retries, and "Payload: args only" off. Agent data storage is "Basic Attributes Only", two safety guardrails are on, and the maximum call duration is under 5 minutes. The next version uses a 10-second timeout; each call overrides the agent's maximum duration with `MAX_CALL_DURATION_SECONDS`.
3. **Done:** Retell signs function requests. The Worker verifies X-Retell-Signature using the server-side API key; do not add a key as a custom request header or expose it to the website.
4. **Done:** Outbound pilot: the website's "Call me" button (US and Indian mobiles) from the shared demo number, 5-minute calls, 10 visitor calls a day. Your own numbers go in `RETELL_TEST_NUMBERS` and are exempt from the phone limits. The call page adds browser calls on the same budget.
5. Do not set an agent-level webhook URL. Each call carries its own (`RETELL_EVENTS_URL`, events `call_started` and `call_ended`), signed by Retell and verified by the Worker. Do not bind the Healthcare agent to the shared number; it is used only as a per-call override.

**Call data flow:** Retell's default custom-function body includes the caller number and conversation transcript up to the tool call. Retell sends that body to the Cloudflare Worker. The Worker uses the caller number for its allowlist, the call ID for idempotency, and the call's signed metadata to find the visitor's private demo; it ignores the transcript and does not log or store the number or transcript. Browser calls have no caller number. Call-event bodies can carry the transcript too; the Worker stores only the call ID, the event name, Retell's disconnection reason, and the time. Names the caller gives are stored only in that visitor's private demo (for 7 days), never in Retell's call metadata or variables. Retell's own transcript and recording retention is a separate setting and must be reviewed before live calls. Use fictional details only. See [Retell custom-function request format](https://docs.retellai.com/build/single-multi-prompt/custom-function).

Retell dashboard tests and calls use account credit. No Healthcare number has been bought; the shared demo number's existing monthly charge belongs to the HVAC demo. Any further number purchase is the owner's decision.

## Setup step 4 — Text reminders (later)

The app currently records only simulated confirmations, 24-hour appointment reminders, and a missing-document follow-up 48 hours after booking. Live SMS stays off until one market, sender, provider, opt-in wording, opt-out handling, and per-message cost are chosen. Do not enable SMS for all markets based on the demo timezone dropdown alone.

Retell's own A2P SMS add-on for its Twilio numbers is limited to US numbers. Its current published fees are $4 one-time for a low-volume brand or $45 for standard, $15 for the campaign application, then $20/month per number plus $0.01 per text. That makes it a poor fit for a minimal-cost, multi-market reminder system, so the demo does not apply for it. See [Retell's SMS setup and fees](https://docs.retellai.com/deploy/enable-sms).

## Cost approach

- Keep GitHub Pages, Cloudflare Worker, and the existing Supabase project on free tiers for synthetic data.
- Reuse the current Supabase free project rather than create another one. Check its dashboard quotas before increasing usage. Private demos are capped at 3,000 demos and 150 MB of stored state in total.
- Current Cloudflare documentation lists 100,000 Worker requests/day on the Free plan. [Cloudflare Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- Retell lists voice AI at $0.07–$0.31/minute. Every call costs money, including tests. The visitor budget is capped at 10 calls a day (phone and browser together) of at most 5 minutes; the owner's own numbers are not capped for phone calls. [Retell pricing](https://www.retellai.com/pricing)
- SMS prices differ sharply by destination. Snapshot checked 2026-10-05: Twilio lists U.S. SMS at $0.0083 per segment plus carrier fees, with A2P 10DLC registration costs and a $1.15/month long-code number; India outbound SMS is listed at $0.0832 per segment. Twilio's UAE guide says two-way SMS is not supported. These are not all-in quotes; check the selected country's current rate and sender rules before setup. [U.S. SMS pricing](https://www.twilio.com/en-us/sms/pricing/us), [India SMS pricing](https://www.twilio.com/en-us/sms/pricing/in), [UAE SMS guidelines](https://www.twilio.com/en-us/guidelines/ae/sms)
- If any dashboard prompts for a paid plan, extra phone number, credit purchase, or paid SMS sender, stop before accepting it.

## Privacy and production boundary

This public portfolio demo contains synthetic data only. Do not enter real patient information, upload real records, or describe this system as compliant for patient care. A real clinic deployment needs its own security review, data-region and vendor selection, contracts, identity/access controls, retention plan, and legal review. GitHub Pages remains the static demo host, not the production clinic service.

The visitor key that selects a private demo is stored in the browser's `localStorage`, which every page on `parshvak26.github.io` (including the HVAC demo) can read. It protects synthetic data and self-chosen names only, and the demo is deleted 7 days after last use. This is an accepted limit of the demo.
