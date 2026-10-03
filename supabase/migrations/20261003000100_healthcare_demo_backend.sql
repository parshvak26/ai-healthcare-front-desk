-- Synthetic demo data only. Tables live in a private schema, separate from HVAC.
BEGIN;

CREATE SCHEMA IF NOT EXISTS healthcare;
REVOKE ALL ON SCHEMA healthcare FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE IF NOT EXISTS healthcare.demo_state_snapshots (
  clinic_id text PRIMARY KEY CHECK (length(clinic_id) BETWEEN 1 AND 80),
  state jsonb NOT NULL CHECK (jsonb_typeof(state) = 'object'),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS healthcare.demo_rate_limits (
  client_hash text PRIMARY KEY CHECK (length(client_hash) = 64 AND client_hash ~ '^[a-f0-9]+$'),
  window_started_at timestamptz NOT NULL DEFAULT now(),
  request_count integer NOT NULL DEFAULT 1 CHECK (request_count >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS healthcare.retell_call_events (
  call_id text NOT NULL CHECK (length(call_id) BETWEEN 1 AND 120),
  event text NOT NULL CHECK (length(event) BETWEEN 1 AND 60),
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (call_id, event)
);

CREATE INDEX IF NOT EXISTS retell_call_events_received_at_idx
  ON healthcare.retell_call_events (received_at);

ALTER TABLE healthcare.demo_state_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE healthcare.demo_rate_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE healthcare.retell_call_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON healthcare.demo_state_snapshots FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON healthcare.demo_rate_limits FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON healthcare.retell_call_events FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.healthcare_consume_demo_rate_limit(
  p_client_hash text,
  p_window_seconds integer
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, healthcare, pg_temp
AS $$
DECLARE
  v_request_count integer;
BEGIN
  IF p_client_hash !~ '^[a-f0-9]{64}$' OR p_window_seconds < 1 OR p_window_seconds > 3600 THEN
    RAISE EXCEPTION 'invalid rate limit input';
  END IF;

  INSERT INTO healthcare.demo_rate_limits (client_hash, window_started_at, request_count, updated_at)
  VALUES (p_client_hash, now(), 1, now())
  ON CONFLICT (client_hash) DO UPDATE SET
    window_started_at = CASE
      WHEN healthcare.demo_rate_limits.window_started_at + make_interval(secs => p_window_seconds) <= now()
        THEN now()
      ELSE healthcare.demo_rate_limits.window_started_at
    END,
    request_count = CASE
      WHEN healthcare.demo_rate_limits.window_started_at + make_interval(secs => p_window_seconds) <= now()
        THEN 1
      ELSE healthcare.demo_rate_limits.request_count + 1
    END,
    updated_at = now()
  RETURNING request_count INTO v_request_count;

  RETURN v_request_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.healthcare_save_demo_state(
  p_clinic_id text,
  p_expected_revision bigint,
  p_state jsonb
) RETURNS TABLE(saved boolean, revision bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, healthcare, pg_temp
AS $$
DECLARE
  v_revision bigint;
BEGIN
  IF length(p_clinic_id) NOT BETWEEN 1 AND 80 OR jsonb_typeof(p_state) <> 'object' THEN
    RAISE EXCEPTION 'invalid demo state input';
  END IF;

  UPDATE healthcare.demo_state_snapshots
  SET state = p_state, revision = demo_state_snapshots.revision + 1, updated_at = now()
  WHERE clinic_id = p_clinic_id AND demo_state_snapshots.revision = p_expected_revision
  RETURNING demo_state_snapshots.revision INTO v_revision;

  IF v_revision IS NULL THEN
    RETURN QUERY SELECT false, p_expected_revision;
  ELSE
    RETURN QUERY SELECT true, v_revision;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.healthcare_read_demo_state(p_clinic_id text)
RETURNS TABLE(state jsonb, revision bigint)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, healthcare, pg_temp
AS $$
  SELECT s.state, s.revision
  FROM healthcare.demo_state_snapshots AS s
  WHERE s.clinic_id = p_clinic_id
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.healthcare_initialize_demo_state(p_clinic_id text, p_state jsonb)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, healthcare, pg_temp
AS $$
BEGIN
  IF length(p_clinic_id) NOT BETWEEN 1 AND 80 OR jsonb_typeof(p_state) <> 'object' THEN
    RAISE EXCEPTION 'invalid demo state input';
  END IF;

  INSERT INTO healthcare.demo_state_snapshots (clinic_id, state, revision)
  VALUES (p_clinic_id, p_state, 1)
  ON CONFLICT (clinic_id) DO NOTHING;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.healthcare_record_retell_call_event(p_call_id text, p_event text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, healthcare, pg_temp
AS $$
BEGIN
  IF length(p_call_id) NOT BETWEEN 1 AND 120 OR length(p_event) NOT BETWEEN 1 AND 60 THEN
    RAISE EXCEPTION 'invalid event input';
  END IF;

  INSERT INTO healthcare.retell_call_events (call_id, event)
  VALUES (p_call_id, p_event)
  ON CONFLICT (call_id, event) DO NOTHING;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.healthcare_consume_demo_rate_limit(text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.healthcare_save_demo_state(text, bigint, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.healthcare_read_demo_state(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.healthcare_initialize_demo_state(text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.healthcare_record_retell_call_event(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.healthcare_consume_demo_rate_limit(text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.healthcare_save_demo_state(text, bigint, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.healthcare_read_demo_state(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.healthcare_initialize_demo_state(text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.healthcare_record_retell_call_event(text, text) TO service_role;

COMMIT;
