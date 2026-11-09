ALTER TABLE connections
  ADD COLUMN webhook_count bigint NOT NULL DEFAULT 0,
  ADD COLUMN synced_webhook_count bigint NOT NULL DEFAULT 0;

ALTER TABLE notifications
  ADD COLUMN source_webhook_at timestamptz,
  ADD COLUMN webhooks_before_sync bigint,
  ADD COLUMN webhooks_during_sync bigint,
  ADD COLUMN sync_notice_count integer;
