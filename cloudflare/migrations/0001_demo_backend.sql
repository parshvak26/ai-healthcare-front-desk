-- Synthetic demonstration data only. The Worker is the only database client.
CREATE TABLE IF NOT EXISTS demo_state_snapshots (
  clinic_id TEXT PRIMARY KEY CHECK (length(clinic_id) BETWEEN 1 AND 80),
  state TEXT NOT NULL CHECK (json_valid(state) AND json_type(state) = 'object'),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS demo_rate_limits (
  client_hash TEXT PRIMARY KEY CHECK (length(client_hash) = 64 AND client_hash NOT GLOB '*[^a-f0-9]*'),
  window_started_at INTEGER NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 1 CHECK (request_count >= 0),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS retell_call_events (
  call_id TEXT NOT NULL CHECK (length(call_id) BETWEEN 1 AND 120),
  event TEXT NOT NULL CHECK (length(event) BETWEEN 1 AND 60),
  received_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (call_id, event)
);

CREATE INDEX IF NOT EXISTS retell_call_events_received_at_idx ON retell_call_events (received_at);
