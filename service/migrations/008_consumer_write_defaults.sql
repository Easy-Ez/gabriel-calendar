-- Pairing no longer sets per-operation flags. Keep existing rows intact.
ALTER TABLE consumers ALTER COLUMN can_rsvp SET DEFAULT false;
