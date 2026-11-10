CREATE TABLE enrollment_code (
  singleton boolean PRIMARY KEY CHECK (singleton),
  revision uuid NOT NULL,
  credential_digest text NOT NULL,
  rotated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE connect_sessions
  ALTER COLUMN owner_id SET DEFAULT '',
  ADD COLUMN enrollment_revision uuid,
  ADD COLUMN credential_digest text,
  ADD COLUMN redeemed_at timestamptz;
