# Plan: "Talk to the AI" call page with private visitor demos

Status: draft for review · 2026-10-06 · branch `feat/call-page`

## 0. What we are building (owner decisions, 2026-10-06)

| Topic | Decision |
|---|---|
| Default page | A product-showcase **call page**. The visitor picks a country (US +1 / India +91), types their number and gets a call. A **"Clinic staff screen"** button opens today's console. |
| Caller identity | The agent asks for **any name** the caller likes; that name appears on the staff screen. |
| Privacy | **Private copy of the clinic per visitor**, tied to a random key kept in that browser (not the IP). Deleted **7 days after last use** (last call or console change). |
| Existing patients | Both: the page offers a ready-made patient to play (Maya Patel, DEMO-4812), **and** a later call from the same browser is recognised (names and bookings known). |
| During the call | Status (calling → on the call → ended) and, after the call, a **summary** built from the visitor's private data. No transcript is stored. |
| Fallback | **Talk in the browser** (Retell web call over the microphone). The click-through simulation is removed everywhere. |
| Limits | **One shared budget** for phone + browser calls: 10/day total, 3 per connection/day, 5 min each, one call per phone number per 30 min. Owner phone numbers unlimited; no owner pass for browser calls. |
| Staff screen | Private and editable for everyone (callers or not). The shared clinic is retired. |
| Console call button | Replaced by **"Talk to the AI"**, linking back to the call page. |
| Console name pickers | The 5 sample patients **plus** names the visitor used on their own calls. |
| Guidance | "Try saying" ideas based on what the agent really supports. |
| Look | **Product showcase** (CareDesk demo page aimed at recruiters/clients). |

Non-negotiables carried over: fictional clinic, no clinical advice, server-authoritative writes through `applyDemoAction`, never a false "booked", idempotent retries, no transcripts or phone numbers stored, fail closed on missing config, no spend beyond the agreed caps.

## 1. User journeys

1. **First visit, phone.** Lands on the call page → picks US or India → types local number → ticks consent → Turnstile passes (usually invisibly) → "Call me now". Page shows "Calling +1 (•••) •••-0123…", then "On the call · 01:12" when Retell reports the call started, then "Call ended" with a summary ("Booked: New patient visit for Parshva · Thu Oct 8, 10:15 AM CT · DEMO-1234"), and a primary "Open the clinic staff screen" button.
2. **First visit, browser.** Same page, "Talk in browser" tab → consent + Turnstile → "Start talking" → mic permission → agent greets within ~1 s of connecting. Live panel: timer, 5-minute countdown, mute, end call, voice-level orb. After hang-up: same summary.
3. **Returning visitor (same browser, within 7 days).** The page says "Welcome back — your demo clinic is saved for 7 days" and lists their names/bookings. On a new call the agent greets them ("Is this Parshva?") and already knows their bookings, so "move my appointment to Friday" works without a reference.
4. **Trying an existing patient on the first call.** The "Try saying" panel offers "I'm Maya Patel, visit DEMO-4812 — can I move it to Friday?" and "I'm Samira Khan, can you confirm my visit DEMO-7730?" (seed data in every private copy).
5. **Indian number that doesn't ring / is refused.** Clear message ("Calls to Indian numbers aren't enabled on this demo's phone line yet") with a one-click switch to **Talk in browser**.
6. **Limits reached.** Friendly message with when to try again; browser option shown only if the shared budget isn't exhausted (same budget, so usually both are unavailable) and the staff screen is offered.
7. **Cloud unavailable.** Call page says calls are offline; staff screen still works on a browser-only copy (existing local mode).
8. **Visitor opens the staff screen without calling.** Sees their private sample clinic (seed), can book/cancel/etc. Nothing is stored until their first change.

## 2. UX specification

### 2.1 Routes
Hash routes so GitHub Pages needs no 404 rewrite: `#/` (call page, default) and `#/staff` (console). Unknown hashes → call page. Back/forward work. Document title changes per route.

### 2.2 Call page layout (desktop ≥ 1024 px: two columns; mobile: one column, call card first after a short hero)
- **Top bar:** CareDesk logo · "Fictional demo" pill · right: **"Clinic staff screen →"** (secondary button, always visible).
- **Hero (left):** eyebrow `AI FRONT DESK · LIVE DEMO`; H1 "Call an AI receptionist that actually books the appointment."; one-paragraph pitch; chips: `~5-minute call` `Free` `Fictional clinic` `English`.
- **Call card (right, the primary action):** segmented control **Call my phone | Talk in browser**.
  - Phone: country select (🇺🇸 United States +1 / 🇮🇳 India +91) + local number input with live formatting and validation hint; consent checkbox; Turnstile; CTA "Call me now". Caller ID shown: "We'll call from +1 (512) 823-1502."
  - Browser: "Uses your microphone · works from any country"; consent; Turnstile; CTA "Start talking".
  - Disabled states explain why (security check pending, invalid number, calls off).
- **Live panel (replaces the form):** large status line with aria-live; phase dot; timer; "up to 5 minutes"; phone: "Answer the call from +1 (512) 823-1502"; browser: mute, end, level orb (`prefers-reduced-motion` → static). Hint row: "Changes appear on the staff screen as you talk".
- **After the call:** summary card (each change as a row with icon, name, time, reference; empty → "No changes were made — ask about hours or book a visit next time"), outcome note for unanswered/blocked calls, buttons: **Open the clinic staff screen** (primary), **Call again** (shows cooldown if any).
- **"Try saying" panel:** four groups — *New patient* ("I'd like to book a new-patient visit next week, mornings if possible"), *Existing patient* (Maya/Samira lines, or the visitor's own booking when returning), *Questions* ("What are your hours?", "Is there parking?", "Do you take my insurance?"), *Requests* ("Can someone call me back about a bill?", "I need an interpreter"). Plus "Things it won't do: medical advice, real records".
- **How it works:** three steps (You talk → AI uses the clinic's real scheduling rules → the staff screen updates) and a one-line stack credit (Retell voice agent · Cloudflare Worker · Supabase · React).
- **Privacy note:** "Your phone number is never stored. Names you give are kept only in your private demo for 7 days. [Delete my demo data]".
- **Footer:** fictional-demo disclaimer, emergency line ("In an emergency, call your local emergency number").

### 2.3 Staff screen changes
- Header button "Talk to the AI" (→ `#/`); sidebar assistant card and Overview card link to the call page. `CallDemoModal`, `CallMePanel` and `simulateCall` are removed.
- Indicator: `PRIVATE DEMO · ONLY YOU SEE THIS` (cloud), `BROWSER-ONLY COPY` (fallback/local).
- Events from the visitor's calls in the last 30 minutes get a small "From your call" tag in activity lists.
- Name pickers (booking, waitlist, text preferences) list the 5 samples plus the distinct caller names in the visitor's state.
- Settings: "Data: your private demo · deleted 7 days after last use"; **Reset my demo** (reseed own copy) and **Delete my demo data** (remove it now).
- Footer copy updated (no longer "sample names only").

### 2.4 Quality bar
Keyboard and screen-reader friendly (labels, focus order, aria-live for call status, visible focus); contrast AA; works at 360 px width; no layout shift when the live panel replaces the form; reduced-motion respected; Lighthouse-style budget: call page JS ≤ ~90 KB gzip before the browser-call chunk, which is lazy-loaded.

## 3. Architecture

### 3.1 Visitor key and private workspaces
- Browser: 32 random bytes, base64url (43 chars), stored in `localStorage["caredesk-visitor-v1"]`; if storage is unavailable, kept in memory for the tab (the staff screen then says the demo resets when the tab closes). Sent as header `X-Demo-Visitor` on visitor routes.
- Worker: `workspace_id = hex(HMAC-SHA256(SUPABASE_SECRET_KEY|visitor-workspace, visitorKey))`. The raw key is never stored or logged. Pattern `^[A-Za-z0-9_-]{43}$`; missing/invalid → 400 `visitor_required`.
- **Lazy creation:** reads of an unknown workspace return a fresh seed (`persisted: false`, revision 0) without writing. The first change, or a call request, creates the row from a seed and applies the change.
- **Reminder simulation:** `processDueMessages` runs at the start of every mutation and on every read (in memory), so no cron sweep over all workspaces is needed. The cron only purges.
- **Purge:** cron every 15 minutes deletes workspaces with `last_used_at < now − 7 days` and call-event rows older than 30 days.
- **Abuse/size guards:** at most 3,000 stored workspaces (new ones refused with a friendly "demo is busy" message beyond that); at most 6 new workspaces per IP per hour; state JSON ≤ 300 KB (SQL check); existing per-list limits; at most 20 distinct caller names per workspace.

### 3.2 API v3 (Worker)
`apiVersion` → 3 (the web app requires ≥ 3; otherwise it uses its local copy, as today).

| Route | Auth | Purpose |
|---|---|---|
| `GET /api/health` | — | adds `demoCalls.web.enabled`, `retentionDays: 7` |
| `GET /api/demo/state` | visitor | `{state, revision, persisted}` |
| `POST /api/demo/actions` | visitor | unchanged body; writes only the visitor's workspace |
| `POST /api/appointments/availability` | visitor | reads the visitor's workspace |
| `POST /api/demo/forget` | visitor | deletes the workspace; detaches call rows |
| `POST /api/demo-call` | visitor | phone call; response adds `callRef` |
| `POST /api/demo-web-call` | visitor | browser call; returns `{callRef, callId, accessToken, transport, iceServers, expiresAt, maxMinutes}` |
| `GET /api/demo-call/status?ref=` | visitor | `{phase, outcome?, startedAt?, endedAt?}`; ref must belong to the workspace |
| `PUT /api/demo/state` | — | stays 410 |
| `POST /webhooks/retell/custom-function` | Retell signature | resolves the workspace from signed call metadata |
| `POST /webhooks/retell/events` | Retell signature | records `call_started` / `call_ended` (+ `disconnection_reason`) |

CORS allows the `X-Demo-Visitor` header. Same per-IP read/write rate limits.

### 3.3 Calls
- **Reservation** (one SQL function, advisory lock): channel `phone|web`; phone → 30-min per-number cooldown; both → 3/IP/24 h and 10/UTC day (owner phone numbers exempt); **one active call per workspace** (a placed call < 6 min old without `call_ended` → 409 `call_in_progress`). Failed attempts don't count.
- **Phone:** `POST https://api.retellai.com/v2/create-phone-call` as today, plus `metadata.workspace`, `metadata.channel`, per-call `agent_override.agent.webhook_url` (= this Worker's `/webhooks/retell/events`, derived from the request origin) and `webhook_events: ["call_started","call_ended"]`, `agent_override.retell_llm.begin_message`, and dynamic variables (3.5).
- **Browser:** `POST https://api.retellai.com/v3/create-web-call` (v2 is deprecated on 2026-10-18) with `agent_id`, `agent_version: "latest_published"`, the same metadata/overrides/variables. The access token expires ~30 s after creation, so the browser requests it on click and starts immediately. The browser SDK (`retell-client-js-sdk` 3.x, which pulls in `livekit-client`) is lazy-loaded and prefetched when the browser tab is shown. No idempotency key exists for web calls; the per-workspace active-call check prevents double starts.
- **Trust for tool calls:** signature valid **and** (allowlisted owner caller **or** `agent_id` = ours **and** `metadata.source` = `healthcare-web-demo`). Web calls have no direction; phone calls must be outbound. `metadata.workspace` must be 64 hex; owner inbound calls without metadata use a fixed owner workspace.
- **Status:** `phase` = `ringing` (phone) / `connecting` (web) until `call_started`; `live`; `ended` with `outcome` from `disconnection_reason`: completed (`user_hangup`, `agent_hangup`, `inactivity`), `time_limit` (`max_duration_reached`), `no_answer` (`dial_no_answer`, `dial_busy`, `user_declined`, `voicemail_reached`), `blocked` (`telephony_provider_permission_denied`, `invalid_destination`, `dial_failed`, `marked_as_spam`, `network_blocked`), otherwise `error`. No event 90 s after placing → `unknown` (UI: "If your phone didn't ring, try Talk in browser").
- **Summary:** computed in the browser from the visitor's state: events with channel "Voice assistant" since the call started; booking rows enriched from appointments; staff-task rows via a new optional `taskId` on the event.

### 3.4 Database migration `20261007000100_healthcare_visitor_workspaces.sql` (additive, zero-downtime)
- New table `healthcare.visitor_workspaces(workspace_id text PK hex64, state jsonb ≤ 300 KB, revision bigint, created_at, last_used_at)`, RLS on, no table grants.
- New RPCs (service_role only, SECURITY DEFINER, fixed search_path): `healthcare_read_workspace`, `healthcare_create_workspace` (cap check, idempotent), `healthcare_save_workspace` (revision check, bumps `last_used_at`), `healthcare_touch_workspace`, `healthcare_delete_workspace`, `healthcare_purge_demo_data`.
- `demo_call_requests`: add `channel` (default `phone`), `workspace_id` (nullable hex64); `phone_hash` nullable only for web rows. New functions `healthcare_reserve_demo_call_v2`, `healthcare_finish_demo_call_v2`, `healthcare_demo_call_status`.
- `retell_call_events`: add nullable `detail` (`^[a-z_]{1,60}$`); new `healthcare_record_retell_call_event_v2`.
- Old functions and the shared snapshot row stay untouched, so the live Worker keeps working until the new one is deployed. A later cleanup migration can drop them.

### 3.5 Per-call context for the agent (dynamic variables, all strings)
- `clinic_today` ("Tuesday, October 6, 2026"), `clinic_now` ("9:05 AM Central time"), `clinic_calendar` (next 14 days, one line each: `Wed Oct 7 = 2026-10-07 (open)`), so relative dates are resolved exactly.
- `caller_status` (`new` | `returning`), `caller_names` (comma list or `none`), `caller_bookings` (≤ 5 upcoming active bookings by caller names: name, type, spoken time, reference) or `none`.
- `call_channel` (`phone` | `browser`).
- Begin message override: new caller → "Hi, this is Ava, the AI receptionist at Harbor Health — a demo clinic, so feel free to use made-up details. How can I help you today?"; returning with one known name → "Hi, this is Ava from Harbor Health's demo front desk. Is this {name}?".

## 4. Domain changes (`packages/shared`)
- **Names:** `normalizePersonName` (NFC, trim, collapse spaces, letters/marks/space/apostrophe/hyphen/period only, must contain a letter, 1–60 chars, ≤ 5 words, no digits, "Front desk" reserved; all-lower/all-upper → title case). `isPatientName` = canonical form check. Samples stay valid. Validation (`validateDemoState`) accepts any valid name in every list; `smsPreferences` cap 25; ≤ 20 distinct non-sample names per workspace.
- **Matching:** `foldName` (strip accents, lowercase, letters only) and `namesMatch(query, stored)`: equal folded; or same first name when the query has one word; or edit distance ≤ 1 (≥ 4 letters) / ≤ 2 (≥ 8 letters). Used for verification and lookup. `patientIsBusy` compares folded names.
- **Lookup:** `findAppointment(reference?, name?)` (reference + matching name, or name-only returning upcoming active bookings). Tool `lookup_appointment` accepts either.
- **Availability search:** `searchAvailability({fromDate, days 1–14, partOfDay any|morning|afternoon, appointmentType, timezone, now, limit})` → first open slots across days (≤ 3 per day), with spoken day labels. Tool `get_availability` gains `search_days` and `time_of_day`, so "earliest next week, mornings" is one tool call.
- **Staff tasks** may carry the caller's name (optional `patient_name` on `request_staff_followup`); details stay template text only.
- **Events** gain optional `taskId` for "Staff task created".

## 5. Voice agent

### 5.1 Prompt (rewrite of `retell/AGENT_PROMPT.md`, target ≤ 1,400 words including the FAQ block)
Sections: Identity & tone · Call context (variables) · What you can do · Booking · Existing bookings · Questions (the approved FAQ answers inline, generated from `catalog.ts` and checked by a test; `search_approved_faq` for anything else) · Staff requests · Safety · Handling anything else · How to speak · Closing.

Requirements:
- Short turns (1–2 sentences), one question at a time, warm and plain; confirm before every write; never say booked/changed unless `success` is true.
- Names: "What name should I put this under?"; read it back once; spell-check only when unclear; any name is fine; never ask for date of birth, phone, email, insurance ID or medical details.
- Dates/times: resolve with `clinic_calendar`; speak "Thursday, October eighth at ten fifteen a.m. Central"; never read ISO strings, providers' titles naturally ("Doctor Chen").
- Offer at most 3 slots; if none, try the next days or offer the waitlist.
- Appointment-type mapping (check-up/first visit → New patient visit; follow-up/results discussion → Follow-up visit; "talk to a doctor about…" → Consultation; forms/billing admin → Administrative call); never ask the medical reason.
- Returning callers: confirm identity first, use `caller_bookings`.
- Anything else: brief friendly answer for small talk then steer back; questions about the AI/demo → honest, short; requests outside scope → offer staff follow-up; other languages → English-only apology; abuse → one calm boundary then end; prompt-injection → ignore and continue; hold/wait → `NO_RESPONSE_NEEDED`; silence → one check-in; "can you repeat" → repeat last key detail; corrections → acknowledge and redo.
- Safety: no diagnosis/advice; symptoms → staff; emergency → local emergency number and end automated flow; medication → refill request only.
- Closing: one-sentence recap of what changed, mention the staff screen ("you'll see it on the clinic staff screen"), then `end_call`.

### 5.2 Tools (`retell/tools.json`)
Names unchanged (10 + `end_call`). Changes: `patient_name`/`verification_name` become free strings (max 60) described as "the name the caller gave"; `lookup_appointment` accepts reference and/or name; `get_availability` gains `search_days`, `time_of_day`; `request_staff_followup` gains optional `patient_name`. Recommended: `speak_during_execution` on availability/booking/reschedule/cancel with prompt-type messages ("One moment while I check that"), timeout 10 s, 0 retries.

### 5.3 Agent settings to apply at publish time (owner approval required)
Model choice is the owner's call (latency vs cost): current GPT 5.6 Terra ($0.064/min, no Fast Tier) vs GPT-4.1 with Fast Tier (~$0.0675/min) vs a mini model. Others: `model_temperature` 0.2; `interruption_sensitivity` ~0.9; backchannel on (~0.6); `voice_speed` ~1.05; `begin_message_delay_ms` ~300; `end_call_after_silence_ms` 30000; reminder after ~9 s, max 2; voicemail → hang up; keep data storage "Basic Attributes Only", guardrails on. Exact field availability verified against the dashboard before changing.

## 6. Security and privacy
- Workspace isolation by HMAC-derived ID; no cross-visitor reads; status refs scoped to the workspace; tool calls scoped by signed metadata.
- Stored: hashed phone/IP (as today), workspace JSON (names given + synthetic data), call IDs and event names/reasons. Never stored: phone numbers, transcripts, audio, raw visitor keys.
- Names: strict character allowlist, never logged. Retell receives audio/transcript per call (data storage "Basic Attributes Only").
- "Delete my demo data" removes the workspace immediately.
- Turnstile on both call routes; per-IP and global caps; Origin check; CORS minimal.
- The visitor key is a bearer secret in localStorage: no third-party scripts besides Turnstile and the lazily loaded Retell SDK.

## 7. Testing
- Shared: names (normalize/validate/match), lookup by name, availability search, validation with custom names, limits, events `taskId`.
- Worker (in-memory Supabase + mocked Retell/Turnstile): isolation between two visitor keys; lazy creation; forget; tool calls write to the metadata workspace; web-call route (v3 body, token passthrough, budget shared with phone); active-call guard; status endpoint auth and outcome mapping; events with `disconnection_reason`; purge; CORS header; API v3; old snapshot untouched.
- Prompt/FAQ sync test; tools.json schema test (names free strings, new params).
- Web (Playwright, mocked API, no real calls): call page desktop + 390 px; phone flow ringing → live → ended summary; blocked Indian number → switch to browser; limits; returning visitor; staff screen private indicator, name pickers, delete data; local fallback; reduced motion.
- Manual voice script for the owner (scenario checklist) — no calls are placed by Claude.

## 8. Rollout (each step needs the owner's OK)
1. Apply the migration in Supabase (additive).
2. Deploy the Worker (`npm run deploy:api`). Old prompt keeps working (sample names are still valid).
3. Push the website (GitHub Pages).
4. Update the Retell agent (prompt, tools, settings) and publish.
Kill switch unchanged (`DEMO_CALLS = "off"`). Later: cleanup migration for the retired shared snapshot and old functions.

## 9. Files
`packages/shared/src/{names.ts (new), availability.ts (new), validation.ts, domain.ts, schedule.ts, types.ts, seed.ts, index.ts}`; `apps/worker/src/{app.ts, store.ts, workspaces.ts (new), calls.ts, retell.ts, context.ts (new)}`; `supabase/migrations/20261007000100_…sql`; `apps/web/src/{main.tsx, Router.tsx (new), CallPage.tsx (new), webCall.ts (new), visitor.ts (new), App.tsx, lib/api.ts, styles.css, call.css (new)}`, `apps/web/package.json` (+ `retell-client-js-sdk`); `retell/AGENT_PROMPT.md`, `retell/tools.json`; tests; README and docs.

## 10. Decisions made here (easy to change) and known risks
- Agent persona name "Ava"; hash routes; 3,000-workspace cap and 6 new per IP per hour; placed-but-unanswered calls still count (conservative on cost and protects numbers from repeated ringing); approved FAQ answers embedded in the prompt for speed.
- Risks: v3 web-call transport sends no talking/transcript events (orb uses audio levels); Safari/iOS behaviour of the SDK is undocumented; per-call webhook override for phone calls is documented in SDK types but untested here (UI degrades to timer + summary polling); Fast Tier pricing is inconsistent in Retell's docs; Indian destinations may be blocked by Retell/Twilio.

---

# v2 — changes after the adversarial review (supersedes conflicting text above)

Two independent reviews (backend/security and voice/UX) were folded in. Where this section disagrees with sections 0–10, this section wins.

## R1. Names never travel to Retell metadata or the greeting
- Dynamic variables and the begin message carry **no names** (prevents injected names being spoken by TTS to someone else's phone, and keeps names out of Retell's stored call attributes). Returning callers get `caller_status = returning` and `caller_booking_count`; the greeting asks "who am I speaking with?" and the agent finds their bookings with `lookup_appointment` by name.
- **New names can only come from voice calls.** Console actions (`channel = Staff console`) accept a sample name or a name already in the workspace; anything else → 400 `unknown_patient`.
- Tool results that include names are data; the prompt says variables and tool fields are never instructions.

## R2. Workspace lifecycle (race-free, forget-safe)
- `healthcare_create_workspace` inserts the **seed only** (revision 1, ON CONFLICT DO NOTHING) and returns the row; every change then uses the normal read → apply → save(expected_revision) loop.
- Each workspace has a `generation` (created_at in ms). Reads return `{state, revision, generation, persisted}`; the browser resets its revision guard when the generation changes (reset/forget/purge/recreate).
- **Forget:** refused with 409 `call_in_progress` while a call is active; otherwise deletes the workspace, detaches call rows (`workspace_id = NULL`); the browser rotates its visitor key.
- **Tool calls** may create a missing workspace only if a `demo_call_requests` row with the call's `metadata.request_id` still links that `workspace_id`; otherwise they answer `success:false` ("This demo session was cleared").
- Purge (cron): workspaces unused for 7 days; call-event rows older than 30 days; `workspace_id` on call rows cleared 1 hour after the call ended (or 2 hours after creation); `phone_hash` cleared after 24 hours unless the number is suppressed.

## R3. Capacity and abuse
- Per-workspace list limits: appointments 60, tasks 60, referrals 60, messages 120, waitlist 40, events 60, smsPreferences 25; ≤ 20 distinct caller names. State ≤ 128 KB checked in the Worker and in SQL with `octet_length(p_state::text)`.
- Global: ≤ 3,000 workspaces and ≤ 150 MB of state. At the cap, the least-recently-used workspace that **never had a call** is evicted; if none can be evicted, new ones are refused ("The demo is busy").
- New workspaces: ≤ 6 per client per hour. Client identity for all IP limits = full IPv4, or the **/64 prefix** for IPv6.
- Conditional reads: `GET /api/demo/state?known=<generation>.<revision>` → `{unchanged: true, generation, revision}` without shipping the state (the RPC also skips returning it).
- `processDueMessages` is applied in memory on reads and before each change; the browser also applies it on its own clock, so unchanged reads stay correct.

## R4. Calls
- Order in both call routes: validate → write rate limit → Turnstile → ensure workspace exists → reserve (budget) → Retell → finish.
- Reservation (`healthcare_reserve_demo_call_v2`, same advisory-lock key as v1): suppressed numbers refused (`phone_suppressed`, 30 days after a "wrong number" report); phone cooldown 30 min; 3/client/24 h and 10/UTC day across phone + web (owner numbers exempt); **active call per workspace** = rows `reserved` or `placed` younger than max duration + 90 s without `call_ended` → 409 `call_in_progress`. Rows that never connected don't count: `failed`; web rows with no `call_started` after 2 minutes; calls ending with `error_*`, `registered_call_timeout`, `concurrency_limit_reached` or `error_user_not_joined`.
- A Retell timeout while creating a call is recorded as `unknown` (counts) rather than `failed`.
- **Webhook URL** is an explicit var `RETELL_EVENTS_URL`; when set, both call types send `webhook_url` + `webhook_events: ["call_started","call_ended"]` per call. Events link to the request by `metadata.request_id` (also sets `retell_call_id` if missing). Status falls back to `GET /v2/get-call/{call_id}` at most once every 10 s per call when no event has arrived.
- **Agent version** comes from `RETELL_AGENT_VERSION` (an integer, or `latest_published` when unset) so a Worker is paired with the prompt it was built for.
- **Separate kill switch** `DEMO_WEB_CALLS = "on"` for browser calls (both still need `DEMO_CALLS = "on"`).
- **Browser call order:** click → `getUserMedia` (mic) + resume audio + SDK chunk loaded → `POST /api/demo-web-call` → start within the token's ~30 s. If the SDK fails before connecting, the browser calls `POST /api/demo-call/release` (refused once `call_started` exists).
- Trust: `call_type = web_call` allowed; `phone_call` requires `direction = outbound` (or an allowlisted owner caller). Channel comes from `call_type`, not metadata.
- **Wrong number:** new tool `report_wrong_number` → the Worker suppresses that phone hash for 30 days (no number stored) and the agent apologises and ends the call.
- `/webhooks/retell/events` body limit 1 MB.
- Status outcomes add `registered_call_timeout`, `error_user_not_joined`, `concurrency_limit_reached` → `error`/`no_answer` as appropriate.
- **Tool timing log** ("Under the hood"): the Worker appends `{tool, ms, ok}` (≤ 40 entries) to the call request row; the status endpoint returns it.

## R5. Time zones
- Voice tools no longer take a `timezone`: the Worker always uses the clinic zone (America/Chicago). Old arguments are accepted and ignored for compatibility.
- Dynamic variables add `caller_timezone` (browser zone for web calls; `Asia/Kolkata` for +91, otherwise the US zone from the browser if valid, else America/Chicago) and `emergency_number` (911 for US, 112 for India; browser calls use the visitor's country when known, else "your local emergency number").
- Tool slot results include `spoken` ("Thursday, October 8th at 9:30 a.m.") and, when the caller's zone differs, `caller_time` ("8:00 p.m. your time"). The agent says "Central time" once.
- Staff screen in private mode keeps the market controls (existing behaviour) but defaults "My display time" to the viewer's own zone.

## R6. Conversation design additions
- `seconds_left` in every tool result (from the call's start time if known, else reservation time). Rule: under 60 s → finish the current step, recap in one line, end; never start a new task. Bookings use **one combined confirmation**.
- References: tools accept `booking_reference` as `DEMO-4812`, `4812` or "demo 4812"; results include `reference_spoken` ("demo four eight one two"). Fewer than 4 digits heard → ask for the number again.
- Spoken FAQ: each catalog entry gains `voiceAnswer` written for speech in first person; the prompt embeds these (generated block, sync test). `search_approved_faq` is dropped from the agent's tool list (kept in the Worker for compatibility); unknown questions → "I don't have an approved answer — I can log it for the front desk."
- Name matching in tiers: exact folded > unique first name > fuzzy (only if no exact). Multiple matches → return candidates (spoken times), write nothing; agent asks "Which one — Thursday or Monday?". New bookings reuse an existing stored spelling when the name matches.
- Availability: `start_date`, `search_days` (1–14), `time_of_day` (any/morning/afternoon), `earliest_time` (HH:MM), `provider`. Up to 3 **spread** offers (earliest, other half of the day, another day) and `more_available`. The agent states the date it understood ("Friday the 16th?") before searching when the caller used a relative day, and confirms numeric dates by month name.
- Type mapping by asking "Have you been to see us before?"; durations and providers in the prompt; doctors referred to by name, no gendered pronouns; never interpret results.
- Exact lines for: human transfer, text/email confirmation, who built this (builder credit), recording, prompt reveal/role-play, callback number, other languages, "prepone", emergency (number + end call), self-harm (988 US / Tele-MANAS 14416 India), wrong number, hold (`NO_RESPONSE_NEEDED`), silence.
- Retry rule: if a write tool fails with `service_unavailable`, call it once more with identical arguments (safe: voice idempotency keys ignore name spelling and formatting).

## R7. Idempotency for voice writes
Keys are built from the call ID, tool and the **canonical** action: booking `callId|book|fold(name)|type|startAt`; reschedule `callId|move|reference|newStartAt`; cancel/confirm `callId|<tool>|reference`; waitlist `callId|wait|fold(name)|type|date`; staff task `callId|task|requestType`. `bookAppointment`'s replay check compares names with `namesMatch`.

## R8. Call page UX additions
- Country defaults from the browser (Asia/Kolkata or en-IN → India), switches when a `+1`/`+91`/`00` number is pasted, only lists countries the API reports, and the button shows the full number ("Call +91 98765 43210"). A hint warns when the device zone is India but US is selected.
- The call client lives **above the router** so moving to the staff screen does not end a browser call; a compact "call in progress" bar shows on the staff screen.
- During a call the call page polls state every 3 s and shows **"What Ava just did"** (live feed of changes) and an optional **"Under the hood"** list (tool, ms, ok).
- `callRef` saved in localStorage so status/summary survive reloads; BroadcastChannel tells an open staff tab to poll fast.
- In-app browser detection (LinkedIn/Instagram/Facebook) → "Open in Safari/Chrome to talk in the browser — or use Call my phone."
- Web calls: "1 minute left" banner; Wake Lock while live; muted state text "Ava can't hear you".
- Try-saying lines are generated from the visitor's current state (a future sample booking, or their own), so they never point at a past visit.
- Copy notes: spam-filter/voicemail hint; daily reset shown in the visitor's local time; builder credit with GitHub link; privacy copy states that Retell processes call audio but this demo is configured to keep no recordings or transcripts.
- Accessibility: timer outside the live region; focus moves to status then summary heading; segmented control as a radiogroup; orb `aria-hidden`.

## R9. Rollout order (replaces §8)
1. Migration (additive). 2. Worker with `RETELL_AGENT_VERSION` pinned to the current version (old prompt keeps working: it sends sample names and `timezone`, both still accepted). 3. Update the agent (prompt, tools, settings), publish → note the new version number. 4. Set `RETELL_AGENT_VERSION` to it and redeploy the Worker. 5. Push the website. Old open tabs get 409 `reload_required` instead of a confusing 400.

## R10. Accepted risks (documented)
- `localStorage` is shared by every site on `parshvak26.github.io` (including the HVAC demo), so the visitor key is readable by those pages; data is low-value synthetic data plus self-chosen names, deleted after 7 days.
- Hashes are keyed with a secret derived from `SUPABASE_SECRET_KEY` (as today); linkage columns are scrubbed early (R2).
- No real call is placed during development; Safari/iOS web-call behaviour, the per-call webhook override for phone calls, and Retell latency are verified by the owner's manual test script.
