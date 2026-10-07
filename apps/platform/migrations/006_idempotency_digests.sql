-- Bind each idempotency key to a digest of its request and support bounded retention.
-- Rows written before this migration keep a NULL digest and replay without comparison.
ALTER TABLE idempotency_keys ADD COLUMN IF NOT EXISTS request_digest TEXT;
CREATE INDEX IF NOT EXISTS idempotency_keys_scope_created_at_idx
  ON idempotency_keys (scope, created_at);
