CREATE TABLE connections (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL,
  calendar_id text NOT NULL,
  refresh_ciphertext text,
  status text NOT NULL CHECK (status IN ('active', 'auth_required', 'disconnected')),
  sync_token text,
  last_sync_at timestamptz,
  last_webhook_at timestamptz,
  sync_due_at timestamptz NOT NULL DEFAULT now(),
  sync_retry_at timestamptz NOT NULL DEFAULT now(),
  watch_retry_at timestamptz NOT NULL DEFAULT now(),
  revision bigint NOT NULL DEFAULT 0,
  synced_revision bigint NOT NULL DEFAULT 0,
  pruned_through bigint NOT NULL DEFAULT 0,
  UNIQUE (owner_id, calendar_id)
);

CREATE TABLE connect_sessions (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL,
  state_digest text NOT NULL UNIQUE,
  status text NOT NULL CHECK (status IN ('pending', 'processing', 'connected', 'failed')),
  connection_id uuid REFERENCES connections,
  expires_at timestamptz NOT NULL
);

CREATE TABLE channels (
  id uuid PRIMARY KEY,
  connection_id uuid NOT NULL REFERENCES connections,
  token_digest text NOT NULL,
  resource_id text,
  expires_at timestamptz NOT NULL,
  last_message numeric(20, 0) NOT NULL DEFAULT 0
);
CREATE INDEX channels_connection ON channels (connection_id, expires_at);

CREATE TABLE events (
  connection_id uuid NOT NULL REFERENCES connections,
  event_id text NOT NULL,
  pending boolean NOT NULL,
  snapshot jsonb NOT NULL,
  PRIMARY KEY (connection_id, event_id)
);
CREATE INDEX events_pending ON events (connection_id, event_id) WHERE pending;

CREATE TABLE notifications (
  seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  connection_id uuid NOT NULL REFERENCES connections,
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  payload jsonb NOT NULL
);
CREATE INDEX notifications_delivery ON notifications (connection_id, seq);
CREATE INDEX notifications_retention ON notifications (connection_id, observed_at);

CREATE TABLE consumers (
  id uuid PRIMARY KEY,
  connection_id uuid NOT NULL REFERENCES connections,
  grant_digest text NOT NULL UNIQUE,
  can_rsvp boolean NOT NULL,
  checkpoint bigint NOT NULL,
  revoked boolean NOT NULL DEFAULT false
);
