-- Add publish_status column for the editorial draft/publish/archive workflow.
-- Separate from the existing `status` column (upload processing state: uploaded/processed)
-- and the `visibility` column (access control: private/unlisted/public).
--
-- publish_status is the gate that editors use to promote videos to the homepage.
-- Only 'published' videos appear in the public GET /api/videos listing.

ALTER TABLE videos ADD COLUMN publish_status TEXT NOT NULL DEFAULT 'draft';

-- Migrate existing data so runtime mapping and admin UI stay consistent:
--   public   → published  (was visible on homepage)
--   unlisted → archived   (was accessible by URL but not listed)
--   private  → draft      (default already set by column DEFAULT above)
UPDATE videos SET publish_status = 'published' WHERE visibility = 'public';
UPDATE videos SET publish_status = 'archived'  WHERE visibility = 'unlisted';

CREATE INDEX IF NOT EXISTS idx_videos_publish_status ON videos(publish_status);
