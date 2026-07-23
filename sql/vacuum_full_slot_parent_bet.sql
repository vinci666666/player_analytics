\set ON_ERROR_STOP on

-- 需要獨占表鎖；僅能在 API 與同步器停止時執行，且不可包在交易內。
-- Requires an exclusive lock; run only while the API and synchronizer are stopped, outside a transaction.
VACUUM (FULL, ANALYZE) public.slot_parent_bet;
