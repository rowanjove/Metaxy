CREATE TABLE IF NOT EXISTS cards (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('text', 'link', 'code', 'image')),
  content TEXT,
  image_key TEXT,
  title TEXT,
  lang TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  is_archived INTEGER NOT NULL DEFAULT 0,
  archived_at INTEGER,
  archive_date TEXT,
  archive_salt TEXT,
  archive_iv TEXT,
  archive_ciphertext TEXT,
  archive_blob_iv TEXT,
  archive_blob_key TEXT
);

CREATE INDEX IF NOT EXISTS idx_cards_active_created_at
ON cards (is_archived, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_cards_archive_date
ON cards (archive_date, created_at DESC);
