CREATE TABLE hidden_shops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  tabelog_url TEXT,
  created_at INTEGER NOT NULL
);
