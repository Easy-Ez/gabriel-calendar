ALTER TABLE enrollment_code ADD COLUMN credential_ciphertext text;

CREATE TABLE admin_password (
  singleton boolean PRIMARY KEY CHECK (singleton),
  verifier text NOT NULL
);
