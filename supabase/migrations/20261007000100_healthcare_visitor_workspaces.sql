-- Private demo clinics ("visitor workspaces") for the call page, and browser (web) calls on the same call budget.
--
-- Additive and zero-downtime: the Worker that is live today keeps calling the functions created by the two earlier
-- migrations, and none of them is changed or dropped here. The new Worker only uses the functions created below
-- (`_v2` where an older function with the same purpose exists). A later cleanup migration can drop the retired
-- shared snapshot and the v1 call functions.
--
-- Same rules as before: private schema, row level security on, no table grants, and every public function is
-- SECURITY DEFINER with a fixed search_path, callable only by the service role (the Worker).
BEGIN;

-- ---------------------------------------------------------------------------------------------------------------
-- 1. Tables and columns
-- ---------------------------------------------------------------------------------------------------------------

-- One private copy of the fictional clinic per browser. workspace_id is an HMAC of the visitor's random key
-- computed by the Worker, so the raw key is never stored. state_bytes mirrors octet_length(state::text) so the
-- global size cap can be checked without reading every state.
CREATE TABLE IF NOT EXISTS healthcare.visitor_workspaces (
  workspace_id text PRIMARY KEY CHECK (workspace_id ~ '^[a-f0-9]{64}$'),
  state jsonb NOT NULL CHECK (jsonb_typeof(state) = 'object' AND octet_length(state::text) <= 131072),
  state_bytes integer NOT NULL CHECK (state_bytes BETWEEN 2 AND 131072),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_used_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  had_call boolean NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS visitor_workspaces_last_used_idx ON healthcare.visitor_workspaces (last_used_at);

ALTER TABLE healthcare.visitor_workspaces ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON healthcare.visitor_workspaces FROM PUBLIC, anon, authenticated, service_role;

-- Call requests gain a channel (phone or browser), the workspace they were made for (cleared soon after the call),
-- a "wrong number" suppression date, a short tool timing log ({tool, ms, ok}, no arguments or results), and
-- released_at (the browser could not connect: frees the "one call at a time" slot, but the call still counts).
-- phone_hash becomes nullable: browser calls have no number, and purge clears it after 24 hours.
ALTER TABLE healthcare.demo_call_requests
  ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'phone',
  ADD COLUMN IF NOT EXISTS workspace_id text,
  ADD COLUMN IF NOT EXISTS suppressed_until timestamptz,
  ADD COLUMN IF NOT EXISTS tool_log jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS status_checked_at timestamptz,
  ADD COLUMN IF NOT EXISTS released_at timestamptz,
  ALTER COLUMN phone_hash DROP NOT NULL;

ALTER TABLE healthcare.demo_call_requests
  DROP CONSTRAINT IF EXISTS demo_call_requests_status_check,
  ADD CONSTRAINT demo_call_requests_status_check CHECK (status IN ('reserved', 'placed', 'failed', 'unknown')),
  DROP CONSTRAINT IF EXISTS demo_call_requests_channel_check,
  ADD CONSTRAINT demo_call_requests_channel_check CHECK (channel IN ('phone', 'web')),
  DROP CONSTRAINT IF EXISTS demo_call_requests_web_has_no_phone,
  ADD CONSTRAINT demo_call_requests_web_has_no_phone CHECK (channel = 'phone' OR phone_hash IS NULL),
  DROP CONSTRAINT IF EXISTS demo_call_requests_workspace_check,
  ADD CONSTRAINT demo_call_requests_workspace_check CHECK (workspace_id IS NULL OR workspace_id ~ '^[a-f0-9]{64}$'),
  DROP CONSTRAINT IF EXISTS demo_call_requests_tool_log_check,
  ADD CONSTRAINT demo_call_requests_tool_log_check CHECK (jsonb_typeof(tool_log) = 'array' AND jsonb_array_length(tool_log) <= 40);

CREATE INDEX IF NOT EXISTS demo_call_requests_workspace_idx
  ON healthcare.demo_call_requests (workspace_id, created_at DESC) WHERE workspace_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS demo_call_requests_call_id_idx
  ON healthcare.demo_call_requests (retell_call_id) WHERE retell_call_id IS NOT NULL;

-- Call events keep Retell's disconnection_reason (a short snake_case code) and when the event happened.
ALTER TABLE healthcare.retell_call_events
  ADD COLUMN IF NOT EXISTS detail text,
  ADD COLUMN IF NOT EXISTS occurred_at timestamptz;

ALTER TABLE healthcare.retell_call_events
  DROP CONSTRAINT IF EXISTS retell_call_events_detail_check,
  ADD CONSTRAINT retell_call_events_detail_check CHECK (detail IS NULL OR detail ~ '^[a-z_]{1,60}$');

-- ---------------------------------------------------------------------------------------------------------------
-- 2. Private helpers (not exposed through the API: the healthcare schema has no grants)
-- ---------------------------------------------------------------------------------------------------------------

-- Signatures from an earlier draft of this migration whose arguments or result changed. Dropping them lets this
-- file apply over that draft too; none of them is used by the deployed (v1) Worker.
DROP FUNCTION IF EXISTS healthcare.demo_call_counts(healthcare.demo_call_requests, timestamptz);
DROP FUNCTION IF EXISTS public.healthcare_demo_call_status(uuid, text);

-- A workspace's generation is its creation time in milliseconds. The browser resets its revision guard when it
-- changes (the workspace was deleted and recreated).
CREATE OR REPLACE FUNCTION healthcare.workspace_generation(p_created_at timestamptz)
RETURNS bigint
LANGUAGE sql
STABLE
SET search_path = pg_catalog, healthcare, pg_temp
AS $$
  SELECT floor(extract(epoch FROM p_created_at) * 1000)::bigint
$$;

-- True when a call request counts towards the shared budget and the per-number cooldown. Fails closed: a request
-- counts unless there is positive evidence that no call ever connected, namely
--   (a) status 'failed': Retell refused to create the call, so none exists; or
--   (b) no call_started event, and a call_ended whose reason says the call never connected (the browser never
--       joined, the number could not be dialled, or a provider error).
-- A request with call_started always counts. A call_ended with any other reason (user_hangup, dial_no_answer,
-- user_declined, …) counts even without call_started: the phone rang or the call ran. Requests still 'reserved',
-- 'unknown', or released by the browser count until such evidence arrives.
CREATE OR REPLACE FUNCTION healthcare.demo_call_counts(r healthcare.demo_call_requests)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, healthcare, pg_temp
AS $$
  SELECT r.status <> 'failed'
    AND NOT (
      NOT EXISTS (SELECT 1 FROM healthcare.retell_call_events AS s
                   WHERE s.call_id = r.retell_call_id AND s.event = 'call_started')
      AND EXISTS (
        SELECT 1 FROM healthcare.retell_call_events AS e
         WHERE e.call_id = r.retell_call_id AND e.event = 'call_ended'
           AND (e.detail LIKE 'error\_%'
                OR e.detail IN ('error_user_not_joined', 'registered_call_timeout', 'concurrency_limit_reached',
                                'telephony_provider_permission_denied', 'invalid_destination', 'dial_failed', 'network_blocked'))
      )
    )
$$;

-- Until when a call request blocks the visitor's next call ("one call at a time"), or NULL if it does not (it is
-- refused or failed, or Retell reported call_ended). It blocks for at most the maximum call length plus 90
-- seconds; if it never reported call_started, for at most 2 minutes (a phone that never rang, or a browser that
-- never joined); and if the browser released it, for 45 seconds after creation, until its access token can no
-- longer be used. A released call still counts towards the budget (demo_call_counts).
CREATE OR REPLACE FUNCTION healthcare.demo_call_active_until(r healthcare.demo_call_requests, p_max_call_seconds integer)
RETURNS timestamptz
LANGUAGE sql
STABLE
SET search_path = pg_catalog, healthcare, pg_temp
AS $$
  SELECT CASE
    WHEN r.status NOT IN ('reserved', 'placed', 'unknown')
      OR EXISTS (SELECT 1 FROM healthcare.retell_call_events AS e
                  WHERE e.call_id = r.retell_call_id AND e.event = 'call_ended') THEN NULL
    ELSE least(
      r.created_at + make_interval(secs => p_max_call_seconds + 90),
      CASE WHEN NOT EXISTS (SELECT 1 FROM healthcare.retell_call_events AS e
                             WHERE e.call_id = r.retell_call_id AND e.event = 'call_started')
           THEN r.created_at + interval '120 seconds' END,
      CASE WHEN r.released_at IS NOT NULL THEN r.created_at + interval '45 seconds' END
    )
  END
$$;

-- True while a call may still be live (both channels): see demo_call_active_until.
CREATE OR REPLACE FUNCTION healthcare.demo_call_active(r healthcare.demo_call_requests, p_now timestamptz, p_max_call_seconds integer)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, healthcare, pg_temp
AS $$
  SELECT coalesce(healthcare.demo_call_active_until(r, p_max_call_seconds) > p_now, false)
$$;

REVOKE ALL ON FUNCTION healthcare.workspace_generation(timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION healthcare.demo_call_counts(healthcare.demo_call_requests) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION healthcare.demo_call_active_until(healthcare.demo_call_requests, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION healthcare.demo_call_active(healthcare.demo_call_requests, timestamptz, integer) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------------------------------------------
-- 3. Workspaces
-- ---------------------------------------------------------------------------------------------------------------

-- Reads one workspace. When the caller already holds this generation and revision, the state is not returned
-- (unchanged = true), so polling does not ship the same JSON again. No row means "not stored yet".
CREATE OR REPLACE FUNCTION public.healthcare_read_workspace(
  p_workspace_id text,
  p_known_generation bigint DEFAULT NULL,
  p_known_revision bigint DEFAULT NULL
) RETURNS TABLE(state jsonb, revision bigint, generation bigint, unchanged boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, healthcare, pg_temp
AS $$
  SELECT CASE WHEN x.unchanged THEN NULL ELSE x.state END, x.revision, x.generation, x.unchanged
    FROM (
      SELECT w.state, w.revision, healthcare.workspace_generation(w.created_at) AS generation,
             coalesce(healthcare.workspace_generation(w.created_at) = p_known_generation
                      AND w.revision = p_known_revision, false) AS unchanged
        FROM healthcare.visitor_workspaces AS w
       WHERE w.workspace_id = p_workspace_id
    ) AS x
$$;

-- Stores a fresh seed (revision 1) if the workspace does not exist yet, and returns the stored row either way;
-- changes are then applied with the normal read → apply → save loop. created = true only for the request that
-- inserted it.
--
-- Capacity: at most p_max_workspaces rows and p_max_total_bytes of state. At the cap, the least recently used
-- workspace that never had a call is evicted; if there is none, the request is refused with reason 'demo_busy'.
-- With p_request_id (tool calls), the workspace may only be recreated while that call request still links it
-- (reason 'not_linked' otherwise), so a demo deleted with "forget" is not brought back by a late tool call.
CREATE OR REPLACE FUNCTION public.healthcare_create_workspace(
  p_workspace_id text,
  p_state jsonb,
  p_max_workspaces integer,
  p_max_total_bytes bigint,
  p_request_id uuid DEFAULT NULL,
  p_had_call boolean DEFAULT false
) RETURNS TABLE(created boolean, reason text, state jsonb, revision bigint, generation bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, healthcare, pg_temp
AS $$
DECLARE
  v_bytes integer;
  v_count integer;
  v_total bigint;
  v_victim text;
  v_evicted integer := 0;
  v_inserted integer;
BEGIN
  IF NOT coalesce(p_workspace_id ~ '^[a-f0-9]{64}$', false)
    OR p_state IS NULL OR jsonb_typeof(p_state) <> 'object'
    OR p_max_workspaces IS NULL OR p_max_workspaces NOT BETWEEN 1 AND 100000
    OR p_max_total_bytes IS NULL OR p_max_total_bytes NOT BETWEEN 131072 AND 10737418240 THEN
    RAISE EXCEPTION 'invalid workspace input';
  END IF;
  v_bytes := octet_length(p_state::text);
  IF v_bytes > 131072 THEN
    RAISE EXCEPTION 'workspace state too large';
  END IF;

  -- Already stored (for example, a concurrent first write won): hand back the stored copy.
  RETURN QUERY
    SELECT false, NULL::text, w.state, w.revision, healthcare.workspace_generation(w.created_at)
      FROM healthcare.visitor_workspaces AS w WHERE w.workspace_id = p_workspace_id;
  IF FOUND THEN
    RETURN;
  END IF;

  IF p_request_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM healthcare.demo_call_requests AS r WHERE r.id = p_request_id AND r.workspace_id = p_workspace_id
  ) THEN
    RETURN QUERY SELECT false, 'not_linked'::text, NULL::jsonb, NULL::bigint, NULL::bigint;
    RETURN;
  END IF;

  -- One creator at a time, so two requests cannot both squeeze under the cap.
  PERFORM pg_advisory_xact_lock(hashtext('healthcare_create_workspace'));
  LOOP
    SELECT count(*)::integer, coalesce(sum(w.state_bytes), 0)::bigint INTO v_count, v_total
      FROM healthcare.visitor_workspaces AS w;
    EXIT WHEN v_count < p_max_workspaces AND v_total + v_bytes <= p_max_total_bytes;

    SELECT w.workspace_id INTO v_victim
      FROM healthcare.visitor_workspaces AS w
     WHERE NOT w.had_call AND w.workspace_id <> p_workspace_id
     ORDER BY w.last_used_at
     LIMIT 1
     FOR UPDATE SKIP LOCKED;
    IF v_victim IS NULL OR v_evicted >= 20 THEN
      RETURN QUERY SELECT false, 'demo_busy'::text, NULL::jsonb, NULL::bigint, NULL::bigint;
      RETURN;
    END IF;
    DELETE FROM healthcare.visitor_workspaces AS w WHERE w.workspace_id = v_victim;
    UPDATE healthcare.demo_call_requests AS r SET workspace_id = NULL WHERE r.workspace_id = v_victim;
    v_evicted := v_evicted + 1;
  END LOOP;

  INSERT INTO healthcare.visitor_workspaces AS w (workspace_id, state, state_bytes, revision, created_at, last_used_at, had_call)
  VALUES (p_workspace_id, p_state, v_bytes, 1, clock_timestamp(), clock_timestamp(), coalesce(p_had_call, false))
  ON CONFLICT (workspace_id) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  RETURN QUERY
    SELECT v_inserted = 1, NULL::text, w.state, w.revision, healthcare.workspace_generation(w.created_at)
      FROM healthcare.visitor_workspaces AS w WHERE w.workspace_id = p_workspace_id;
END;
$$;

-- Saves a new state if the stored revision is still the expected one, and marks the workspace as used now.
-- reason: 'conflict' (someone saved first), 'missing' (deleted meanwhile) or 'demo_busy' (growing this state
-- would take the total over the size cap). The Worker re-reads and retries on conflict or missing.
CREATE OR REPLACE FUNCTION public.healthcare_save_workspace(
  p_workspace_id text,
  p_expected_revision bigint,
  p_state jsonb,
  p_max_total_bytes bigint
) RETURNS TABLE(saved boolean, reason text, revision bigint, generation bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, healthcare, pg_temp
AS $$
DECLARE
  v_bytes integer;
  v_old_bytes integer;
  v_total bigint;
  v_revision bigint;
  v_generation bigint;
BEGIN
  IF NOT coalesce(p_workspace_id ~ '^[a-f0-9]{64}$', false) OR p_expected_revision IS NULL
    OR p_state IS NULL OR jsonb_typeof(p_state) <> 'object'
    OR p_max_total_bytes IS NULL OR p_max_total_bytes NOT BETWEEN 131072 AND 10737418240 THEN
    RAISE EXCEPTION 'invalid workspace input';
  END IF;
  v_bytes := octet_length(p_state::text);
  IF v_bytes > 131072 THEN
    RAISE EXCEPTION 'workspace state too large';
  END IF;

  SELECT w.state_bytes INTO v_old_bytes FROM healthcare.visitor_workspaces AS w WHERE w.workspace_id = p_workspace_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'missing'::text, NULL::bigint, NULL::bigint;
    RETURN;
  END IF;
  IF v_bytes > v_old_bytes THEN
    SELECT coalesce(sum(w.state_bytes), 0)::bigint INTO v_total FROM healthcare.visitor_workspaces AS w;
    IF v_total - v_old_bytes + v_bytes > p_max_total_bytes THEN
      RETURN QUERY SELECT false, 'demo_busy'::text, NULL::bigint, NULL::bigint;
      RETURN;
    END IF;
  END IF;

  UPDATE healthcare.visitor_workspaces AS w
     SET state = p_state, state_bytes = v_bytes, revision = w.revision + 1, last_used_at = clock_timestamp()
   WHERE w.workspace_id = p_workspace_id AND w.revision = p_expected_revision
  RETURNING w.revision, healthcare.workspace_generation(w.created_at) INTO v_revision, v_generation;

  IF v_revision IS NULL THEN
    RETURN QUERY
      SELECT false, 'conflict'::text, w.revision, healthcare.workspace_generation(w.created_at)
        FROM healthcare.visitor_workspaces AS w WHERE w.workspace_id = p_workspace_id;
    IF NOT FOUND THEN
      RETURN QUERY SELECT false, 'missing'::text, NULL::bigint, NULL::bigint;
    END IF;
    RETURN;
  END IF;
  RETURN QUERY SELECT true, NULL::text, v_revision, v_generation;
END;
$$;

-- Marks a workspace as used now (it is kept for 7 days after its last use) and, optionally, as having had a call
-- (such workspaces are never evicted to make room).
CREATE OR REPLACE FUNCTION public.healthcare_touch_workspace(p_workspace_id text, p_had_call boolean)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, healthcare, pg_temp
AS $$
BEGIN
  IF NOT coalesce(p_workspace_id ~ '^[a-f0-9]{64}$', false) THEN
    RAISE EXCEPTION 'invalid workspace input';
  END IF;
  UPDATE healthcare.visitor_workspaces AS w
     SET last_used_at = clock_timestamp(), had_call = w.had_call OR coalesce(p_had_call, false)
   WHERE w.workspace_id = p_workspace_id;
  RETURN FOUND;
END;
$$;

-- "Delete my demo data": removes the workspace and detaches its call requests. Refused while one of its calls may
-- still be live. Takes the reservation lock, so it cannot interleave with a reservation for the same workspace.
CREATE OR REPLACE FUNCTION public.healthcare_delete_workspace(p_workspace_id text, p_max_call_seconds integer)
RETURNS TABLE(deleted boolean, reason text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, healthcare, pg_temp
AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
BEGIN
  IF NOT coalesce(p_workspace_id ~ '^[a-f0-9]{64}$', false)
    OR p_max_call_seconds IS NULL OR p_max_call_seconds NOT BETWEEN 60 AND 3600 THEN
    RAISE EXCEPTION 'invalid workspace input';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('healthcare_reserve_demo_call'));

  IF EXISTS (
    SELECT 1 FROM healthcare.demo_call_requests AS r
     WHERE r.workspace_id = p_workspace_id AND healthcare.demo_call_active(r, v_now, p_max_call_seconds)
  ) THEN
    RETURN QUERY SELECT false, 'call_in_progress'::text;
    RETURN;
  END IF;

  DELETE FROM healthcare.visitor_workspaces AS w WHERE w.workspace_id = p_workspace_id;
  UPDATE healthcare.demo_call_requests AS r SET workspace_id = NULL, updated_at = v_now WHERE r.workspace_id = p_workspace_id;
  RETURN QUERY SELECT true, NULL::text;
END;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- 4. Calls (phone and browser share one budget)
-- ---------------------------------------------------------------------------------------------------------------

-- Atomically checks the limits and reserves one call, under the same advisory lock as the v1 function so the two
-- Workers cannot both take the last slot during the rollout. In order:
--   1. phone_suppressed: the number reported "wrong number" within the suppression period (owner numbers exempt);
--   2. call_in_progress: this workspace already has a call that may be live (everyone, owner included);
--   3. phone_cooldown: the same number was called recently (owner exempt);
--   4. ip_daily_limit: this client already used its calls in the last 24 hours (owner exempt);
--   5. daily_limit: the UTC day's calls are used up (owner exempt).
-- Browser calls never get the owner exemption. Only requests proven never to have connected are free (demo_call_counts).
-- On success the workspace is marked as used and as having had a call, so it is never evicted to make room.
CREATE OR REPLACE FUNCTION public.healthcare_reserve_demo_call_v2(
  p_request_id uuid,
  p_channel text,
  p_workspace_id text,
  p_phone_hash text,
  p_ip_hash text,
  p_owner boolean,
  p_phone_cooldown_minutes integer,
  p_max_calls_per_ip_per_day integer,
  p_max_calls_per_day integer,
  p_max_call_seconds integer
) RETURNS TABLE(allowed boolean, reason text, retry_after_seconds integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, healthcare, pg_temp
AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_owner boolean := coalesce(p_owner, false) AND p_channel = 'phone';
  v_since timestamptz;
  v_count integer;
BEGIN
  IF p_request_id IS NULL OR p_channel IS NULL OR p_channel NOT IN ('phone', 'web')
    OR NOT coalesce(p_workspace_id ~ '^[a-f0-9]{64}$', false)
    OR NOT coalesce(p_ip_hash ~ '^[a-f0-9]{64}$', false)
    OR (p_channel = 'phone' AND NOT coalesce(p_phone_hash ~ '^[a-f0-9]{64}$', false))
    OR (p_channel = 'web' AND p_phone_hash IS NOT NULL)
    OR p_owner IS NULL
    OR p_phone_cooldown_minutes IS NULL OR p_phone_cooldown_minutes NOT BETWEEN 1 AND 1440
    OR p_max_calls_per_ip_per_day IS NULL OR p_max_calls_per_ip_per_day NOT BETWEEN 1 AND 100
    OR p_max_calls_per_day IS NULL OR p_max_calls_per_day NOT BETWEEN 1 AND 1000
    OR p_max_call_seconds IS NULL OR p_max_call_seconds NOT BETWEEN 60 AND 3600 THEN
    RAISE EXCEPTION 'invalid demo call input';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('healthcare_reserve_demo_call'));
  DELETE FROM healthcare.demo_call_requests AS r
   WHERE r.created_at < v_now - interval '30 days' AND (r.suppressed_until IS NULL OR r.suppressed_until <= v_now);

  IF p_channel = 'phone' AND NOT v_owner THEN
    SELECT max(r.suppressed_until) INTO v_since
      FROM healthcare.demo_call_requests AS r
     WHERE r.phone_hash = p_phone_hash AND r.suppressed_until > v_now;
    IF v_since IS NOT NULL THEN
      RETURN QUERY SELECT false, 'phone_suppressed'::text,
        least(2592000, greatest(1, ceil(extract(epoch FROM (v_since - v_now)))::integer));
      RETURN;
    END IF;
  END IF;

  -- Retry-After = when the last blocking call stops blocking.
  SELECT max(healthcare.demo_call_active_until(r, p_max_call_seconds)) INTO v_since
    FROM healthcare.demo_call_requests AS r
   WHERE r.workspace_id = p_workspace_id AND healthcare.demo_call_active(r, v_now, p_max_call_seconds);
  IF v_since IS NOT NULL THEN
    RETURN QUERY SELECT false, 'call_in_progress'::text,
      greatest(1, ceil(extract(epoch FROM (v_since - v_now)))::integer);
    RETURN;
  END IF;

  IF NOT v_owner THEN
    IF p_channel = 'phone' THEN
      SELECT max(r.created_at) INTO v_since
        FROM healthcare.demo_call_requests AS r
       WHERE r.phone_hash = p_phone_hash
         AND r.created_at > v_now - make_interval(mins => p_phone_cooldown_minutes)
         AND healthcare.demo_call_counts(r);
      IF v_since IS NOT NULL THEN
        RETURN QUERY SELECT false, 'phone_cooldown'::text,
          greatest(1, ceil(extract(epoch FROM (v_since + make_interval(mins => p_phone_cooldown_minutes) - v_now)))::integer);
        RETURN;
      END IF;
    END IF;

    SELECT count(*)::integer, min(r.created_at) INTO v_count, v_since
      FROM healthcare.demo_call_requests AS r
     WHERE r.ip_hash = p_ip_hash AND NOT r.owner_number
       AND r.created_at > v_now - interval '24 hours'
       AND healthcare.demo_call_counts(r);
    IF v_count >= p_max_calls_per_ip_per_day THEN
      RETURN QUERY SELECT false, 'ip_daily_limit'::text,
        greatest(1, ceil(extract(epoch FROM (v_since + interval '24 hours' - v_now)))::integer);
      RETURN;
    END IF;

    SELECT count(*)::integer INTO v_count
      FROM healthcare.demo_call_requests AS r
     WHERE NOT r.owner_number
       AND r.created_at >= date_trunc('day', v_now AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
       AND healthcare.demo_call_counts(r);
    IF v_count >= p_max_calls_per_day THEN
      RETURN QUERY SELECT false, 'daily_limit'::text,
        greatest(1, ceil(extract(epoch FROM ((date_trunc('day', v_now AT TIME ZONE 'UTC') + interval '1 day') AT TIME ZONE 'UTC' - v_now)))::integer);
      RETURN;
    END IF;
  END IF;

  INSERT INTO healthcare.demo_call_requests (id, channel, workspace_id, phone_hash, ip_hash, owner_number, status, created_at, updated_at)
  VALUES (p_request_id, p_channel, p_workspace_id, CASE WHEN p_channel = 'phone' THEN p_phone_hash END, p_ip_hash, v_owner, 'reserved', v_now, v_now);
  UPDATE healthcare.visitor_workspaces AS w SET had_call = true, last_used_at = v_now WHERE w.workspace_id = p_workspace_id;
  RETURN QUERY SELECT true, NULL::text, 0;
END;
$$;

-- Records what happened when the Worker asked Retell to create the call. 'unknown' (Retell did not answer in time)
-- still counts towards the budget. A call ID that already arrived through an event is kept.
CREATE OR REPLACE FUNCTION public.healthcare_finish_demo_call_v2(p_request_id uuid, p_status text, p_call_id text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, healthcare, pg_temp
AS $$
BEGIN
  IF p_request_id IS NULL OR p_status IS NULL OR p_status NOT IN ('placed', 'failed', 'unknown')
    OR (p_call_id IS NOT NULL AND length(p_call_id) NOT BETWEEN 1 AND 120) THEN
    RAISE EXCEPTION 'invalid demo call update';
  END IF;
  UPDATE healthcare.demo_call_requests AS r
     SET status = p_status, retell_call_id = coalesce(r.retell_call_id, p_call_id), updated_at = clock_timestamp()
   WHERE r.id = p_request_id AND r.status = 'reserved';
  RETURN FOUND;
END;
$$;

-- Stores a call_started / call_ended event (only the opaque call ID, the event name, Retell's disconnection
-- reason and when it happened). With p_request_id (from the call's signed metadata) the event is linked to its
-- call request: the call ID is filled in if missing, and a call that really started is placed and active again,
-- even if Retell's create call timed out ('unknown') or the browser had released it.
CREATE OR REPLACE FUNCTION public.healthcare_record_retell_call_event_v2(
  p_call_id text,
  p_event text,
  p_detail text,
  p_request_id uuid,
  p_occurred_at timestamptz
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, healthcare, pg_temp
AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_occurred timestamptz := CASE
    WHEN p_occurred_at BETWEEN clock_timestamp() - interval '1 day' AND clock_timestamp() + interval '5 minutes' THEN p_occurred_at
  END;
BEGIN
  IF p_call_id IS NULL OR length(p_call_id) NOT BETWEEN 1 AND 120
    OR NOT coalesce(p_event ~ '^[a-z_]{1,60}$', false)
    OR (p_detail IS NOT NULL AND p_detail !~ '^[a-z_]{1,60}$') THEN
    RAISE EXCEPTION 'invalid event input';
  END IF;

  INSERT INTO healthcare.retell_call_events AS e (call_id, event, detail, occurred_at, received_at)
  VALUES (p_call_id, p_event, p_detail, v_occurred, v_now)
  ON CONFLICT (call_id, event) DO UPDATE
    SET detail = coalesce(e.detail, EXCLUDED.detail), occurred_at = coalesce(e.occurred_at, EXCLUDED.occurred_at);

  IF p_request_id IS NOT NULL THEN
    UPDATE healthcare.demo_call_requests AS r
       SET retell_call_id = coalesce(r.retell_call_id, p_call_id),
           status = CASE WHEN p_event = 'call_started' AND r.status IN ('failed', 'unknown') THEN 'placed' ELSE r.status END,
           released_at = CASE WHEN p_event = 'call_started' THEN NULL ELSE r.released_at END,
           updated_at = v_now
     WHERE r.id = p_request_id AND (r.retell_call_id IS NULL OR r.retell_call_id = p_call_id);
  END IF;
  RETURN true;
END;
$$;

-- Status of one call for the call page. Matches on the request ID and the caller's workspace, so a visitor can
-- only see their own calls (no row = not found).
CREATE OR REPLACE FUNCTION public.healthcare_demo_call_status(p_request_id uuid, p_workspace_id text)
RETURNS TABLE(
  channel text, status text, retell_call_id text, placed_at timestamptz, started_at timestamptz,
  ended_at timestamptz, end_reason text, tool_log jsonb, status_checked_at timestamptz, released_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, healthcare, pg_temp
AS $$
  SELECT r.channel, r.status, r.retell_call_id, r.created_at,
         coalesce(s.occurred_at, s.received_at), coalesce(e.occurred_at, e.received_at), e.detail,
         r.tool_log, r.status_checked_at, r.released_at
    FROM healthcare.demo_call_requests AS r
    LEFT JOIN healthcare.retell_call_events AS s ON s.call_id = r.retell_call_id AND s.event = 'call_started'
    LEFT JOIN healthcare.retell_call_events AS e ON e.call_id = r.retell_call_id AND e.event = 'call_ended'
   WHERE r.id = p_request_id AND r.workspace_id = p_workspace_id
$$;

-- Lets the status endpoint ask Retell directly (get-call) at most once every p_min_seconds per call, when no
-- event has arrived. Returns true for the one request that may ask now.
CREATE OR REPLACE FUNCTION public.healthcare_claim_demo_call_status_check(p_request_id uuid, p_workspace_id text, p_min_seconds integer)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, healthcare, pg_temp
AS $$
BEGIN
  IF p_request_id IS NULL OR p_min_seconds IS NULL OR p_min_seconds NOT BETWEEN 1 AND 3600 THEN
    RAISE EXCEPTION 'invalid status check input';
  END IF;
  UPDATE healthcare.demo_call_requests AS r
     SET status_checked_at = clock_timestamp()
   WHERE r.id = p_request_id AND r.workspace_id = p_workspace_id AND r.retell_call_id IS NOT NULL
     AND (r.status_checked_at IS NULL OR r.status_checked_at <= clock_timestamp() - make_interval(secs => p_min_seconds));
  RETURN FOUND;
END;
$$;

-- The browser could not connect a browser call (for example the SDK failed to load): 45 seconds after creation,
-- when its access token can no longer be used, the request stops blocking the visitor's next call. It still counts
-- towards the budget. Refused once the call has started; a later call_started undoes the release.
CREATE OR REPLACE FUNCTION public.healthcare_release_demo_call(p_request_id uuid, p_workspace_id text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, healthcare, pg_temp
AS $$
BEGIN
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'invalid release input';
  END IF;
  UPDATE healthcare.demo_call_requests AS r
     SET released_at = coalesce(r.released_at, clock_timestamp()), updated_at = clock_timestamp()
   WHERE r.id = p_request_id AND r.workspace_id = p_workspace_id AND r.channel = 'web'
     AND r.status IN ('reserved', 'placed', 'unknown')
     AND NOT EXISTS (SELECT 1 FROM healthcare.retell_call_events AS e
                      WHERE e.call_id = r.retell_call_id AND e.event = 'call_started');
  RETURN FOUND;
END;
$$;

-- "Wrong number" (the agent's report_wrong_number tool): the dialled number's hash is refused for p_days. Only the
-- hash is kept, and purge leaves it in place until the suppression ends.
CREATE OR REPLACE FUNCTION public.healthcare_suppress_demo_call_number(p_request_id uuid, p_call_id text, p_days integer)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, healthcare, pg_temp
AS $$
DECLARE
  v_until timestamptz := clock_timestamp() + make_interval(days => p_days);
BEGIN
  IF p_request_id IS NULL OR p_call_id IS NULL OR length(p_call_id) NOT BETWEEN 1 AND 120
    OR p_days IS NULL OR p_days NOT BETWEEN 1 AND 90 THEN
    RAISE EXCEPTION 'invalid suppression input';
  END IF;
  UPDATE healthcare.demo_call_requests AS r
     SET suppressed_until = greatest(coalesce(r.suppressed_until, v_until), v_until), updated_at = clock_timestamp()
   WHERE r.id = p_request_id AND r.channel = 'phone' AND r.phone_hash IS NOT NULL
     AND (r.retell_call_id IS NULL OR r.retell_call_id = p_call_id);
  RETURN FOUND;
END;
$$;

-- Appends one {tool, ms, ok} entry to the call's "Under the hood" log (at most 40 entries; later ones are dropped).
CREATE OR REPLACE FUNCTION public.healthcare_append_demo_call_tool_log(
  p_request_id uuid,
  p_call_id text,
  p_tool text,
  p_ms integer,
  p_ok boolean
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, healthcare, pg_temp
AS $$
BEGIN
  IF p_request_id IS NULL OR p_call_id IS NULL OR length(p_call_id) NOT BETWEEN 1 AND 120
    OR NOT coalesce(p_tool ~ '^[a-z_]{1,40}$', false)
    OR p_ms IS NULL OR p_ms NOT BETWEEN 0 AND 600000 OR p_ok IS NULL THEN
    RAISE EXCEPTION 'invalid tool log input';
  END IF;
  UPDATE healthcare.demo_call_requests AS r
     SET tool_log = r.tool_log || jsonb_build_array(jsonb_build_object('tool', p_tool, 'ms', p_ms, 'ok', p_ok))
   WHERE r.id = p_request_id AND (r.retell_call_id IS NULL OR r.retell_call_id = p_call_id)
     AND jsonb_array_length(r.tool_log) < 40;
  RETURN FOUND;
END;
$$;

-- True while a call request still links this workspace (used before a tool call reads a missing workspace).
CREATE OR REPLACE FUNCTION public.healthcare_demo_call_linked(p_request_id uuid, p_workspace_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, healthcare, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM healthcare.demo_call_requests AS r WHERE r.id = p_request_id AND r.workspace_id = p_workspace_id
  )
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- 5. Retention (run by the Worker's cron every 15 minutes)
-- ---------------------------------------------------------------------------------------------------------------

-- Deletes workspaces unused for 7 days and call events older than 30 days; unlinks call requests from their
-- workspace 1 hour after the call ended (or 2 hours after the request); clears phone hashes after 24 hours unless
-- the number is suppressed; deletes call requests older than 30 days (unless still suppressed) and stale
-- rate-limit counters.
CREATE OR REPLACE FUNCTION public.healthcare_purge_demo_data()
RETURNS TABLE(
  workspaces_deleted integer, call_events_deleted integer, call_links_cleared integer,
  phone_hashes_cleared integer, call_requests_deleted integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, healthcare, pg_temp
AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_workspaces integer;
  v_events integer;
  v_links integer;
  v_hashes integer;
  v_requests integer;
BEGIN
  WITH gone AS (
    DELETE FROM healthcare.visitor_workspaces AS w WHERE w.last_used_at < v_now - interval '7 days' RETURNING w.workspace_id
  ), unlinked AS (
    UPDATE healthcare.demo_call_requests AS r SET workspace_id = NULL
      FROM gone WHERE r.workspace_id = gone.workspace_id RETURNING r.id
  )
  SELECT count(*)::integer INTO v_workspaces FROM gone;

  DELETE FROM healthcare.retell_call_events AS e WHERE e.received_at < v_now - interval '30 days';
  GET DIAGNOSTICS v_events = ROW_COUNT;

  UPDATE healthcare.demo_call_requests AS r
     SET workspace_id = NULL
   WHERE r.workspace_id IS NOT NULL
     AND (r.created_at < v_now - interval '2 hours'
          OR EXISTS (SELECT 1 FROM healthcare.retell_call_events AS e
                      WHERE e.call_id = r.retell_call_id AND e.event = 'call_ended'
                        AND e.received_at < v_now - interval '1 hour'));
  GET DIAGNOSTICS v_links = ROW_COUNT;

  UPDATE healthcare.demo_call_requests AS r
     SET phone_hash = NULL
   WHERE r.phone_hash IS NOT NULL AND r.created_at < v_now - interval '24 hours'
     AND (r.suppressed_until IS NULL OR r.suppressed_until <= v_now);
  GET DIAGNOSTICS v_hashes = ROW_COUNT;

  DELETE FROM healthcare.demo_call_requests AS r
   WHERE r.created_at < v_now - interval '30 days' AND (r.suppressed_until IS NULL OR r.suppressed_until <= v_now);
  GET DIAGNOSTICS v_requests = ROW_COUNT;

  DELETE FROM healthcare.demo_rate_limits AS l WHERE l.updated_at < v_now - interval '1 day';

  RETURN QUERY SELECT v_workspaces, v_events, v_links, v_hashes, v_requests;
END;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- 6. Privileges: the Worker (service role) only
-- ---------------------------------------------------------------------------------------------------------------

REVOKE ALL ON FUNCTION public.healthcare_read_workspace(text, bigint, bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.healthcare_create_workspace(text, jsonb, integer, bigint, uuid, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.healthcare_save_workspace(text, bigint, jsonb, bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.healthcare_touch_workspace(text, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.healthcare_delete_workspace(text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.healthcare_reserve_demo_call_v2(uuid, text, text, text, text, boolean, integer, integer, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.healthcare_finish_demo_call_v2(uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.healthcare_record_retell_call_event_v2(text, text, text, uuid, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.healthcare_demo_call_status(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.healthcare_claim_demo_call_status_check(uuid, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.healthcare_release_demo_call(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.healthcare_suppress_demo_call_number(uuid, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.healthcare_append_demo_call_tool_log(uuid, text, text, integer, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.healthcare_demo_call_linked(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.healthcare_purge_demo_data() FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.healthcare_read_workspace(text, bigint, bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.healthcare_create_workspace(text, jsonb, integer, bigint, uuid, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.healthcare_save_workspace(text, bigint, jsonb, bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.healthcare_touch_workspace(text, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.healthcare_delete_workspace(text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.healthcare_reserve_demo_call_v2(uuid, text, text, text, text, boolean, integer, integer, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.healthcare_finish_demo_call_v2(uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.healthcare_record_retell_call_event_v2(text, text, text, uuid, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.healthcare_demo_call_status(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.healthcare_claim_demo_call_status_check(uuid, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.healthcare_release_demo_call(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.healthcare_suppress_demo_call_number(uuid, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.healthcare_append_demo_call_tool_log(uuid, text, text, integer, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.healthcare_demo_call_linked(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.healthcare_purge_demo_data() TO service_role;

COMMIT;
