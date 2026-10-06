# Contract: Worker API v3, Retell tools and per-call context

Companion to `call-page-plan.md` (read its v2 section first). This file is the source of truth for the interfaces between the web app, the Worker, the database and the Retell agent.

## 1. Visitor header
`X-Demo-Visitor: <43 chars base64url = 32 random bytes>` on every visitor route below.
- Missing → `409 {error:{code:"reload_required", message:"Please reload the page to continue."}}` (old open tabs).
- Malformed → `400 invalid_visitor`.
- `workspace_id = hex(HMAC-SHA256(key = SUPABASE_SECRET_KEY + "|visitor-workspace", data = visitor key))`.
- CORS: `Access-Control-Allow-Headers: Content-Type, X-Request-Id, X-Demo-Visitor`.

## 2. Routes (apiVersion 3)
All errors: `{error:{code, message}}`. Rate limits as today (read bucket for GETs incl. status; write bucket for POSTs).

- `GET /api/health` → `{ok, mode:"synthetic-demo", apiVersion:3, databaseConnected, liveCallsEnabled, liveSmsEnabled:false, demoCalls, privateDemo:{retentionDays:7}, requestId}` where `demoCalls` = `{enabled:true, countries:["US","IN"], fromNumber:"+1 (512) 823-1502", maxMinutes:5, maxCallsPerDay:10, web:{enabled:boolean}}` or `{enabled:false, web:{enabled:false}}`.
- `GET /api/demo/state[?known=<generation>.<revision>]` → `{state, revision, generation, persisted}`; not stored yet → fresh seed with `revision:0, generation:0, persisted:false`; unchanged → `{unchanged:true, revision, generation}`. `generation` = workspace `created_at` in ms.
- `POST /api/demo/actions {action, idempotencyKey}` → `{state, revision, generation, persisted:true, result:{changed, message, appointment?, waitlistItem?, task?}}`.
- `POST /api/appointments/availability {date, appointmentType, timezone, ignoreAppointmentId?}` → `{slots, timezone, demo:true}` (reads the visitor's workspace or the seed).
- `POST /api/demo/forget {}` → `{deleted:true}`; `409 call_in_progress` while a call is active.
- `POST /api/demo-call {phoneNumber, consent:true, turnstileToken, timezone?}` → `{status:"calling", callRef, channel:"phone", country:"US"|"IN", maskedNumber, fromNumber, maxMinutes}`.
  Errors: 400 `consent_required|invalid_phone|verification_required|invalid_request`, 403 `verification_failed`, 403 `number_blocked`, 409 `call_in_progress`, 422 `call_rejected`, 429 `phone_cooldown|ip_daily_limit|daily_limit|demo_busy_creation` (+ `Retry-After`, `retryAfterSeconds`), 503 `demo_calls_off|calls_unavailable|demo_busy`.
- `POST /api/demo-web-call {consent:true, turnstileToken, timezone?}` → `{callRef, channel:"web", callId, accessToken, transport, iceServers, expiresAt, maxMinutes}`. Errors as above plus 503 `web_calls_off`.
- `GET /api/demo-call/status?ref=<uuid>` → `{callRef, channel:"phone"|"web", phase:"ringing"|"connecting"|"live"|"ended"|"unknown", outcome?:"completed"|"time_limit"|"no_answer"|"blocked"|"error", placedAt, startedAt?, endedAt?, maxMinutes, tools:[{tool, ms, ok}]}`; `404 not_found` when the ref is not this visitor's.
- `POST /api/demo-call/release {callRef}` → `{released:boolean}` (only before `call_started`; web calls whose browser could not connect).
- `PUT /api/demo/state` → 410 (unchanged). Webhook paths unchanged.

Outcome mapping from `disconnection_reason`: `user_hangup|agent_hangup|inactivity|call_transfer` → completed; `max_duration_reached` → time_limit; `dial_no_answer|dial_busy|user_declined|voicemail_reached|ivr_reached|error_user_not_joined|registered_call_timeout` → no_answer; `telephony_provider_permission_denied|invalid_destination|dial_failed|marked_as_spam|network_blocked|user_requested_dnc|scam_detected` → blocked; anything else → error. Phase `unknown` when placed > 90 s ago with no `call_started` and no answer from the get-call fallback.

## 3. Per-call Retell request (both channels)
- `metadata`: `{source:"healthcare-web-demo", request_id, workspace:<64 hex>, channel:"phone"|"web", caller_timezone:<IANA>, placed_at:<ms>, max_seconds:"300"}` (Retell metadata may hold numbers; dynamic variables must be strings).
- `retell_llm_dynamic_variables` (strings, **no names**):
  - `clinic_today` ("Wednesday, October 7th, 2026"), `clinic_calendar` (`clinicCalendar(now, clinicTz)`), `clinic_timezone_label` ("Central time")
  - `caller_status` ("new" | "returning": returning = the workspace has ≥ 1 caller name), `caller_booking_count` (upcoming active bookings under caller names, as a string)
  - `call_channel` ("phone" | "browser"), `caller_timezone` (IANA), `caller_time_differs` ("yes" | "no")
  - `emergency_number` ("911" | "112" | "your local emergency number"), `crisis_line` ("988" | "Tele-MANAS on 14416" | "a local crisis line"), `max_minutes` ("5")
- `agent_override`: `agent: {max_call_duration_ms, webhook_url?: RETELL_EVENTS_URL, webhook_events?: ["call_started","call_ended"]}`, `retell_llm: {begin_message}` with:
  - phone + new: "Hi, this is Ava, the AI receptionist at Harbor Health, calling for the demo you requested. It's a demo clinic, so made-up details are fine. How can I help?"
  - browser + new: "Hi, this is Ava, the AI receptionist at Harbor Health. It's a demo clinic, so made-up details are fine. How can I help?"
  - returning (either): "Hi, this is Ava, the AI receptionist at Harbor Health. Welcome back to the demo. Who am I speaking with?"
- Phone: `POST /v2/create-phone-call` with `override_agent_id`, `override_agent_version` (= `RETELL_AGENT_VERSION` as an integer, or "latest_published" when unset), `idempotency_key`. Web: `POST /v3/create-web-call` with `agent_id`, `agent_version` (same rule).
- Caller time zone: phone +91 → `Asia/Kolkata`; phone +1 → the request's `timezone` if it is a valid `America/*` or `Pacific/Honolulu` zone, else `America/Chicago`; web → the request's `timezone` if valid, else `America/Chicago`. Emergency/crisis: phone by country; web by `request.cf.country` (US/IN), else generic.

## 4. Retell custom functions (Worker side)
Every result includes `success` and, when computable, `seconds_left` (= max_seconds − (now − (call.start_timestamp ?? metadata.placed_at))/1000, floored at 0). Business failures → HTTP 200 `{success:false, error, message}`. The clinic zone is always used; a `timezone` argument is accepted and ignored. Appointment summaries for voice: `{reference, reference_spoken, patient, appointment_type, status, start_at, spoken_time, caller_time?, provider, location, documents}`; `caller_time` (e.g. "8 p.m. your time" or "Friday at 8 p.m. your time") only when the caller's zone differs.

| Tool | Args (new; legacy aliases accepted) | Result |
|---|---|---|
| `get_availability` | `appointment_type`, `start_date` (alias `date`), `search_days?` 1–14 (default 1), `time_of_day?` any/morning/afternoon, `earliest_time?` "HH:MM", `provider?` | `{success, searched_from, searched_to, slots:[{start_at, provider, location, spoken, caller_time?}], more_available, message, seconds_left}` |
| `create_appointment` | `patient_name`, `appointment_type`, `start_at`, `provider?` | `{success, reference, reference_spoken, patient_name, appointment, message, seconds_left}` |
| `lookup_appointment` | `booking_reference?` and/or `patient_name?` (alias `verification_name`) | `{success, appointments:[summary…≤5], match:"reference"|"exact"|"first-name"|"fuzzy"|null, message}` |
| `confirm_appointment`, `cancel_appointment` | `booking_reference`, `patient_name` (alias `verification_name`) | `{success, appointment, message}` |
| `reschedule_appointment` | `booking_reference`, `patient_name` (alias), `new_start_at`, `provider?` | `{success, appointment, message}` |
| `join_waitlist` | `patient_name`, `appointment_type`, `preferred_date` | `{success, waitlist_request, message}` |
| `request_staff_followup` | `request_type`, `patient_name?` | `{success, message}` |
| `check_document_status` | `booking_reference`, `patient_name?` (alias `sample_patient_name`) | `{success, appointment_documents, documents, message}` |
| `report_wrong_number` | — | suppresses the dialled number's hash for 30 days; `{success:true, message:"Apologise in one sentence and end the call."}` |
| `search_approved_faq` | kept for compatibility, no longer in tools.json | unchanged |

`booking_reference` accepts "DEMO-4812", "4812", "demo 4812" (`parseBookingReference`). Voice idempotency keys per plan R7.

## 5. Web-app expectations
- Visitor key in `localStorage["caredesk-visitor-v1"]` (memory fallback); rotated after forget.
- Active call reference in `localStorage["caredesk-active-call-v1"]` = `{callRef, channel, placedAt}` (cleared when ended + summary shown and dismissed, or after 15 min).
- `BroadcastChannel("caredesk-demo")` messages: `{type:"call-active", until:<ms>}`, `{type:"state-changed"}`.
- Hash routes `#/` (call page) and `#/staff`.
