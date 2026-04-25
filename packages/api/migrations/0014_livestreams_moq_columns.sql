PRAGMA foreign_keys = ON;

ALTER TABLE livestreams ADD COLUMN moq_endpoint TEXT;
ALTER TABLE livestreams ADD COLUMN moq_broadcast TEXT;
