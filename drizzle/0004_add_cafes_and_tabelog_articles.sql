CREATE TABLE cafes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slot_id INTEGER NOT NULL REFERENCES slots(id),
  name TEXT NOT NULL,
  chain_name TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  map_url TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  rank INTEGER NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE INDEX cafes_slot_idx ON cafes(slot_id);
--> statement-breakpoint
CREATE TABLE tabelog_articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slot_id INTEGER NOT NULL REFERENCES slots(id),
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  rank INTEGER NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE INDEX tabelog_articles_slot_idx ON tabelog_articles(slot_id);
