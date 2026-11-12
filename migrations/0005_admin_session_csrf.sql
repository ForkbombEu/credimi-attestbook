-- Session-bound CSRF tokens for cookie-authenticated writes (issue #89).
--
-- A browser session may now authorize the existing provider write routes, so
-- every state-changing request that authenticates with the session cookie must
-- also echo the token issued with that session. The token is not an
-- authenticator: it is accepted only together with the session cookie, which
-- another site cannot read. `GET /api/v1/auth/me` returns it so a reloaded page
-- keeps working, and every login mints a fresh token with the fresh session.
--
-- Rows created before this migration are backfilled with a random token that
-- the browser can read from `GET /api/v1/auth/me`, so a live pre-migration
-- session keeps working for reads and writes instead of failing a write it
-- cannot satisfy. A row whose token is empty (only possible if the backfill is
-- skipped) never matches a presented value.

ALTER TABLE admin_sessions ADD COLUMN csrf_token TEXT NOT NULL DEFAULT '';

UPDATE admin_sessions
   SET csrf_token = lower(hex(randomblob(32)))
 WHERE csrf_token = '';
