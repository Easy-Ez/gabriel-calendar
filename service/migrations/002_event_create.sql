ALTER TABLE consumers ADD COLUMN can_create boolean NOT NULL DEFAULT false;

CREATE TABLE event_creates (
  connection_id uuid NOT NULL REFERENCES connections,
  key_digest text NOT NULL,
  request_digest text NOT NULL,
  event_id text NOT NULL,
  confirmed boolean NOT NULL DEFAULT false,
  PRIMARY KEY (connection_id, key_digest)
);
