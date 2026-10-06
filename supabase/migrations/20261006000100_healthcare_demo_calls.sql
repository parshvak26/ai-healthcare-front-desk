-- Outbound "Call me" demo calls for the Healthcare site. Stores only salted hashes of the phone number and
-- client IP (never the number itself), so limits can be enforced without keeping contact details.
-- Rows older than 30 days are deleted automatically. Private schema; service-role RPC access only.
BEGIN;

CREATE TABLE IF NOT EXISTS healthcare.demo_call_requests (
  id uuid PRIMARY KEY,
  phone_hash text NOT NULL CHECK (phone_hash ~ '^[a-f0-9]{64}$'),
  ip_hash text NOT NULL CHECK (ip_hash ~ '^[a-f0-9]{64}$'),
  owner_number boolean NOT NULL DEFAULT false,
  status text NOT NULL CHECK (status IN ('reserved', 'placed', 'failed')),
  retell_call_id text CHECK (retell_call_id IS NULL OR length(retell_call_id) BETWEEN 1 AND 128),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS demo_call_requests_phone_idx ON healthcare.demo_call_requests (phone_hash, created_at DESC);
CREATE INDEX IF NOT EXISTS demo_call_requests_ip_idx ON healthcare.demo_call_requests (ip_hash, created_at DESC);
CREATE INDEX IF NOT EXISTS demo_call_requests_created_idx ON healthcare.demo_call_requests (created_at);

ALTER TABLE healthcare.demo_call_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON healthcare.demo_call_requests FROM PUBLIC, anon, authenticated, service_role;

-- Atomically checks the limits and reserves one call. Owner (allowlisted) numbers skip every limit and do not
-- count towards the public daily cap. Failed attempts never count.
CREATE OR REPLACE FUNCTION public.healthcare_reserve_demo_call(
  p_request_id uuid,
  p_phone_hash text,
  p_ip_hash text,
  p_owner boolean,
  p_phone_cooldown_minutes integer,
  p_max_calls_per_ip_per_day integer,
  p_max_calls_per_day integer
) RETURNS TABLE(allowed boolean, reason text, retry_after_seconds integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, healthcare, pg_temp
AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_since timestamptz;
  v_count integer;
BEGIN
  IF p_request_id IS NULL
    OR p_phone_hash !~ '^[a-f0-9]{64}$' OR p_ip_hash !~ '^[a-f0-9]{64}$' OR p_owner IS NULL
    OR p_phone_cooldown_minutes NOT BETWEEN 1 AND 1440
    OR p_max_calls_per_ip_per_day NOT BETWEEN 1 AND 100
    OR p_max_calls_per_day NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'invalid demo call input';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('healthcare_reserve_demo_call'));
  DELETE FROM healthcare.demo_call_requests WHERE created_at < v_now - interval '30 days';

  IF NOT p_owner THEN
    SELECT max(r.created_at) INTO v_since
      FROM healthcare.demo_call_requests AS r
     WHERE r.phone_hash = p_phone_hash AND r.status <> 'failed'
       AND r.created_at > v_now - make_interval(mins => p_phone_cooldown_minutes);
    IF v_since IS NOT NULL THEN
      RETURN QUERY SELECT false, 'phone_cooldown'::text,
        greatest(1, ceil(extract(epoch FROM (v_since + make_interval(mins => p_phone_cooldown_minutes) - v_now)))::integer);
      RETURN;
    END IF;

    SELECT count(*)::integer, min(r.created_at) INTO v_count, v_since
      FROM healthcare.demo_call_requests AS r
     WHERE r.ip_hash = p_ip_hash AND r.status <> 'failed' AND NOT r.owner_number
       AND r.created_at > v_now - interval '24 hours';
    IF v_count >= p_max_calls_per_ip_per_day THEN
      RETURN QUERY SELECT false, 'ip_daily_limit'::text,
        greatest(1, ceil(extract(epoch FROM (v_since + interval '24 hours' - v_now)))::integer);
      RETURN;
    END IF;

    SELECT count(*)::integer INTO v_count
      FROM healthcare.demo_call_requests AS r
     WHERE r.status <> 'failed' AND NOT r.owner_number
       AND r.created_at >= date_trunc('day', v_now AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
    IF v_count >= p_max_calls_per_day THEN
      RETURN QUERY SELECT false, 'daily_limit'::text,
        greatest(1, ceil(extract(epoch FROM ((date_trunc('day', v_now AT TIME ZONE 'UTC') + interval '1 day') AT TIME ZONE 'UTC' - v_now)))::integer);
      RETURN;
    END IF;
  END IF;

  INSERT INTO healthcare.demo_call_requests (id, phone_hash, ip_hash, owner_number, status, created_at, updated_at)
  VALUES (p_request_id, p_phone_hash, p_ip_hash, p_owner, 'reserved', v_now, v_now);
  RETURN QUERY SELECT true, NULL::text, 0;
END;
$$;

CREATE OR REPLACE FUNCTION public.healthcare_finish_demo_call(p_request_id uuid, p_status text, p_call_id text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, healthcare, pg_temp
AS $$
BEGIN
  IF p_request_id IS NULL OR p_status NOT IN ('placed', 'failed')
    OR (p_call_id IS NOT NULL AND length(p_call_id) NOT BETWEEN 1 AND 128) THEN
    RAISE EXCEPTION 'invalid demo call update';
  END IF;
  UPDATE healthcare.demo_call_requests
     SET status = p_status, retell_call_id = p_call_id, updated_at = now()
   WHERE id = p_request_id AND status = 'reserved';
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.healthcare_reserve_demo_call(uuid, text, text, boolean, integer, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.healthcare_finish_demo_call(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.healthcare_reserve_demo_call(uuid, text, text, boolean, integer, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.healthcare_finish_demo_call(uuid, text, text) TO service_role;

COMMIT;
