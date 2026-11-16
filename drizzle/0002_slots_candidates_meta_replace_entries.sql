DROP TABLE entries;
--> statement-breakpoint
CREATE TABLE slots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  event_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  event_title TEXT NOT NULL,
  event_start TEXT,
  event_end TEXT,
  all_day INTEGER NOT NULL DEFAULT 0,
  location TEXT NOT NULL DEFAULT '',
  area TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'researching',
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slot_id INTEGER NOT NULL REFERENCES slots(id),
  name TEXT NOT NULL,
  genre TEXT NOT NULL DEFAULT '',
  score REAL NOT NULL,
  price_label TEXT NOT NULL DEFAULT '',
  over_budget INTEGER NOT NULL DEFAULT 0,
  tabelog_url TEXT,
  note TEXT NOT NULL DEFAULT '',
  rank INTEGER NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX slots_date_idx ON slots(date);
--> statement-breakpoint
CREATE INDEX candidates_slot_idx ON candidates(slot_id);
