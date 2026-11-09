ALTER TABLE connect_sessions
  ADD COLUMN callback_started_at timestamptz,
  ADD COLUMN callback_completed_at timestamptz;

ALTER TABLE connections
  ADD COLUMN onboarding_bound_at timestamptz,
  ADD COLUMN onboarding_oauth_ms integer,
  ADD COLUMN onboarding_sync_started_at timestamptz,
  ADD COLUMN onboarding_sync_completed_at timestamptz,
  ADD COLUMN onboarding_watch_started_at timestamptz,
  ADD COLUMN onboarding_watch_completed_at timestamptz,
  ADD COLUMN onboarding_webhook_at timestamptz;
