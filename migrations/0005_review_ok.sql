-- "Needs review" is computed from missing data (src/review.ts). This holds the field groups
-- the user marked OK for a flight (JSON array of group names), so they stop being flagged.
ALTER TABLE flights ADD COLUMN review_ok TEXT NOT NULL DEFAULT '[]';
