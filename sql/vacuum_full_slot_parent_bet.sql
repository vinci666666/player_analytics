\set ON_ERROR_STOP on

-- Requires an exclusive table lock. Run only while the API and synchronizer
-- are stopped. Do not wrap VACUUM FULL in a transaction.
VACUUM (FULL, ANALYZE) public.slot_parent_bet;
