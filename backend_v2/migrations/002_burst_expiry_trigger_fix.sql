-- Phase 2 migration: fix for the Phase 1 burst auto-expiry trigger.
--
-- Phase 1 fired trg_auto_expire_bursts() BEFORE INSERT OR UPDATE (statement level). On an
-- UPDATE, that trigger expires stale rows first and the outer UPDATE then touches the same
-- rows, which PostgreSQL rejects with
--   "tuple to be updated was already modified by an operation triggered by the current command".
-- That broke both `SELECT auto_expire_bursts()` and
--   `UPDATE burst_sessions SET is_active=false WHERE expires_at < now() AND is_active`
-- whenever something was due to expire, and also ending an already-overdue session.
--
-- The sweep only has to run before INSERTs (to clear stale sessions ahead of the
-- uq_burst_active_target check); UPDATE-time expiry is done by the backend's burst manager.
-- Idempotent.
DROP TRIGGER IF EXISTS trg_burst_sessions_expire ON burst_sessions;
CREATE TRIGGER trg_burst_sessions_expire
    BEFORE INSERT ON burst_sessions
    FOR EACH STATEMENT EXECUTE FUNCTION trg_auto_expire_bursts();
