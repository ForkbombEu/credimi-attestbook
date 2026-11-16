-- Bind each subscription to the deployment webhook signing key it was
-- registered under (issue #119).
--
-- The webhook verification secret is derived, never stored. A subscription
-- whose row carries no key id was registered while delivery was disabled, and a
-- row whose key id differs from the current deployment key belongs to an
-- earlier key (rotation). Neither row was ever given the secret that the
-- current key would sign with, so publication delivery must skip both instead
-- of sending notifications the subscriber cannot verify. The value is a
-- non-secret truncated HMAC fingerprint, never the key or the derived secret.

ALTER TABLE subscriptions ADD COLUMN webhook_key_id TEXT;
