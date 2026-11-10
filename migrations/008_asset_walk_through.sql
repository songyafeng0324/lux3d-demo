-- T17: official ground cover (grass) that people walk through instead of bumping into.
ALTER TABLE assets ADD COLUMN walk_through boolean NOT NULL DEFAULT false;
