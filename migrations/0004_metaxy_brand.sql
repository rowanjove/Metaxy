UPDATE settings
SET value = '之间门', updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE key = 'site_name' AND value = 'PocketRelay';
