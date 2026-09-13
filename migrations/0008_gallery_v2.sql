-- Migration 0008: Gallery 2.0 Schema
-- Upload staging sessions
CREATE TABLE IF NOT EXISTS gallery_uploads (
  id TEXT PRIMARY KEY,
  image_id TEXT NOT NULL,
  staging_object_key TEXT NOT NULL UNIQUE,
  thumb_staging_object_key TEXT,
  thumb_expected_size INTEGER,
  filename TEXT NOT NULL,
  expected_size INTEGER NOT NULL,
  expected_content_type TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'prepared'
    CHECK (status IN ('prepared', 'uploading', 'finalizing', 'completed', 'failed', 'expired'))
);

CREATE INDEX IF NOT EXISTS idx_gallery_uploads_expires
  ON gallery_uploads(status, expires_at);

-- Expand gallery_images with Gallery 2.0 metadata
ALTER TABLE gallery_images ADD COLUMN original_size_bytes INTEGER;
ALTER TABLE gallery_images ADD COLUMN thumb_object_key TEXT;
ALTER TABLE gallery_images ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0;
ALTER TABLE gallery_images ADD COLUMN album_id TEXT;
ALTER TABLE gallery_images ADD COLUMN dominant_color TEXT;
ALTER TABLE gallery_images ADD COLUMN metadata_json TEXT;

CREATE INDEX IF NOT EXISTS idx_gallery_images_favorite
  ON gallery_images(status, favorite, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_gallery_images_album
  ON gallery_images(status, album_id, created_at DESC);

-- Gallery Albums
CREATE TABLE IF NOT EXISTS gallery_albums (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  cover_image_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_gallery_albums_updated
  ON gallery_albums(updated_at DESC);
