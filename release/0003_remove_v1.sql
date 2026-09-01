-- Release-only cleanup. Keep this outside migrations/ so it is never applied
-- automatically while the v1 Worker can still be serving traffic.
DROP INDEX IF EXISTS idx_cards_active_created_at;
DROP INDEX IF EXISTS idx_cards_archive_date;
DROP TABLE IF EXISTS cards;
