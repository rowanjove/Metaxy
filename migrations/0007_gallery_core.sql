-- Gallery / Image Bed schema
CREATE TABLE IF NOT EXISTS gallery_images (
  id TEXT PRIMARY KEY,
  object_key TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  width INTEGER,
  height INTEGER,
  hash TEXT,
  created_at INTEGER NOT NULL,
  view_count INTEGER NOT NULL DEFAULT 0,
  last_viewed_at INTEGER,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'deleting'))
);

CREATE INDEX IF NOT EXISTS idx_gallery_images_created_at
  ON gallery_images(status, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_gallery_images_hash
  ON gallery_images(status, hash);

-- R2 deletion intent is durable across request failures. The scheduled cleanup
-- pass must delete from the GALLERY bucket and then remove the matching D1 row.
CREATE TABLE IF NOT EXISTS gallery_object_deletions (
  object_key TEXT PRIMARY KEY,
  image_id TEXT,
  created_at INTEGER NOT NULL,
  not_before INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_attempt_at INTEGER,
  FOREIGN KEY (image_id) REFERENCES gallery_images(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_gallery_object_deletions_due
  ON gallery_object_deletions(not_before, attempts, last_attempt_at, created_at);
