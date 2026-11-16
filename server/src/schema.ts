// Drizzle schema for 予定日程付近グルメ.
//
// slots: one lunch-search slot per calendar outing event (or one
// home-area fallback slot per event-free day) inside the visible window.
// candidates: Tabelog-verified lunch candidates for a slot (score >= 3.3).
// meta: small key/value store (last refresh timestamps / status).

import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const slots = sqliteTable("slots", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  // YYYY-MM-DD in Asia/Tokyo.
  date: text("date").notNull(),
  // Stable key: calendar event id when known, else date+title hash from the agent.
  eventKey: text("event_key").notNull().unique(),
  kind: text("kind", { enum: ["event", "home"] }).notNull(),
  eventTitle: text("event_title").notNull(),
  // Local ISO times (Asia/Tokyo, +09:00) for timed events; null for all-day.
  eventStart: text("event_start"),
  eventEnd: text("event_end"),
  allDay: integer("all_day", { mode: "boolean" }).notNull().default(false),
  location: text("location").notNull().default(""),
  area: text("area").notNull().default(""),
  status: text("status", { enum: ["ready", "researching"] })
    .notNull()
    .default("researching"),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const candidates = sqliteTable("candidates", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  slotId: integer("slot_id")
    .notNull()
    .references(() => slots.id),
  // "meal" = lunch/dinner candidates; "sweets" = お土産スイーツ candidates
  // researched against the user's souvenir-sweets preferences.
  category: text("category", { enum: ["meal", "sweets"] })
    .notNull()
    .default("meal"),
  name: text("name").notNull(),
  genre: text("genre").notNull().default(""),
  // Tabelog score, verified on tabelog.com; always >= 3.3.
  score: real("score").notNull(),
  priceLabel: text("price_label").notNull().default(""),
  overBudget: integer("over_budget", { mode: "boolean" })
    .notNull()
    .default(false),
  tabelogUrl: text("tabelog_url"),
  // Map URL for this shop: the link destination of the map button
  // (「大きな地図を見る」) on the shop's Tabelog page — Tabelog's own
  // per-shop map page (…/<restaurant-id>/dtlmap/) — copied verbatim by
  // the research agent (user instruction, 2026-11-16). The card's
  // 「地図を見る」 link points here so the map opens directly. Null =
  // not yet collected: the card then shows NO map link at all (never a
  // substitute link to the shop page).
  mapUrl: text("map_url"),
  // Real photo URL of this shop, copied verbatim by the research agent
  // from the shop's Tabelog page (店舗・料理写真); when the shop's own
  // photo cannot be fetched, the shop's official-site photo, else a real
  // same-genre photo (user rule, 2026-11-15: every candidate card shows
  // a photo). Null only for rows saved before photos were collected —
  // the UI renders a "写真を調査中" tile and the next refresh fills it.
  photoUrl: text("photo_url"),
  note: text("note").notNull().default(""),
  // Business hours exactly as shown on the shop's Tabelog page
  // (e.g. "11:00～14:30／17:00～23:00"); "" = not confirmed on the page.
  // Never invented — the UI shows 営業時間 未確認 when empty.
  hoursText: text("hours_text").notNull().default(""),
  // Regular closing days as shown on Tabelog (e.g. "水曜日", "不定休",
  // "無休"); "" = not confirmed on the page.
  closedDays: text("closed_days").notNull().default(""),
  rank: integer("rank").notNull().default(0),
});

export const cafes = sqliteTable("cafes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  slotId: integer("slot_id")
    .notNull()
    .references(() => slots.id),
  name: text("name").notNull(),
  // Chain brand (スターバックス, タリーズ, ドトール, カフェ・ド・クリエ …)
  // or "" for independent shops.
  chainName: text("chain_name").notNull().default(""),
  address: text("address").notNull().default(""),
  // Map link (Google Maps etc.) — required for every cafe; location matters.
  mapUrl: text("map_url").notNull().default(""),
  // Station location classification (user rule change, 2026-11-15):
  // "inside" = 駅中 (改札内・駅コンコース内・エキナカ商業施設内・
  // 駅直結の地下街コンコース内), "outside" = 駅外 (それ以外。駅ビル内の
  // 店舗はこちら), "unknown" = 未判定 (判定できず、次回調査で判定する。
  // 駅外と誤魔化さない). The old station-interior EXCLUSION is abolished:
  // both inside and outside shops are stored and displayed, grouped by
  // this field within each brand.
  locationType: text("location_type", {
    enum: ["inside", "outside", "unknown"],
  })
    .notNull()
    .default("unknown"),
  note: text("note").notNull().default(""),
  rank: integer("rank").notNull().default(0),
});

export const tabelogArticles = sqliteTable("tabelog_articles", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  slotId: integer("slot_id")
    .notNull()
    .references(() => slots.id),
  title: text("title").notNull(),
  url: text("url").notNull(),
  rank: integer("rank").notNull().default(0),
});

// Shops the user deleted with a left swipe on a candidate card. They are
// never proposed again in any slot: saveCandidates filters them out,
// healStoredData removes stored copies, and getSchedule filters on read.
// Identity is the Tabelog shop id (from the URL) when available, else the
// normalized URL, else the normalized shop name (see shopKey in actions.ts).
export const hiddenShops = sqliteTable("hidden_shops", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  shopKey: text("shop_key").notNull().unique(),
  name: text("name").notNull(),
  tabelogUrl: text("tabelog_url"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// Station-level train routes from the user's configured home stations
// (ADOPTER_CONFIG.routeOriginStations in actions.ts) to each destination
// station. Routes are researched once per destination station and reused
// by every slot heading there (the refresh brief works station by station,
// never re-searching per slot). Only route-search-verified fares/times are
// stored; fareIcYen/durationMin stay null when unconfirmed. The source
// (search provider + page) is kept on the row for fare-revision checks.
export const stationRoutes = sqliteTable("station_routes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  // Destination station, unique — one adopted (cheapest reasonable) route
  // per destination station.
  destStation: text("dest_station").notNull().unique(),
  // Adopted origin: one of the configured home stations (whichever
  // compared cheaper / more reasonable for this destination).
  originStation: text("origin_station").notNull(),
  // IC fare in yen from a real route search; null = unconfirmed.
  fareIcYen: integer("fare_ic_yen"),
  // Total minutes incl. transfer wait, from the same search; null = unconfirmed.
  durationMin: integer("duration_min"),
  transfers: integer("transfers").notNull().default(0),
  sourceLabel: text("source_label").notNull().default(""),
  sourceUrl: text("source_url"),
  // JSON array of legs: [{ line, fromStation, toStation, stops, minutes, note }]
  legsJson: text("legs_json").notNull().default("[]"),
  note: text("note").notNull().default(""),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// Station-level cafe database (user instruction, 2026-11-14 night): cafes
// are researched ONCE per station (area) and reused by every later slot
// heading to that station, instead of being re-searched per slot. The
// per-slot `cafes` table remains as the legacy/import source; rows are
// mirrored into this table by healStoredData and by saveCandidates.
// Identity is (station, name). photoUrl is a real shop photo URL from an
// official / map source when one was verified; null renders a brand tile
// in the UI (photos are never fabricated). sourceLabel/sourceUrl and
// researchedAt are kept so stale rows (closures etc.) can be spotted.
export const stationCafes = sqliteTable("station_cafes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  // Destination station this cafe belongs to, e.g. ○○駅.
  station: text("station").notNull(),
  name: text("name").notNull(),
  chainName: text("chain_name").notNull().default(""),
  address: text("address").notNull().default(""),
  // Map link — required for every cafe; location matters.
  mapUrl: text("map_url").notNull().default(""),
  photoUrl: text("photo_url"),
  // Station location classification — same rule as `cafes.locationType`:
  // "inside" = 駅中, "outside" = 駅外 (駅ビル内を含む), "unknown" = 未判定.
  // Required for every row: saves resolve it from the research agent's
  // explicit value or infer it from name/address/note; rows that cannot
  // be judged stay "unknown" and are re-judged on the next research.
  locationType: text("location_type", {
    enum: ["inside", "outside", "unknown"],
  })
    .notNull()
    .default("unknown"),
  sourceLabel: text("source_label").notNull().default(""),
  sourceUrl: text("source_url"),
  note: text("note").notNull().default(""),
  rank: integer("rank").notNull().default(0),
  researchedAt: integer("researched_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// Stations whose surroundings have been researched for cafes at least
// once. The refresh brief lists these stations and tells the agent NOT
// to re-search them — only stations missing here get researched, so the
// cafe database grows one new destination at a time.
export const cafeStations = sqliteTable("cafe_stations", {
  station: text("station").primaryKey(),
  // True for stations registered as destinations (the user's frequently
  // visited stations are pre-registered, plus every station that gained
  // cafes through a slot). researchedAt stays null while a registered
  // station has not been researched yet — the refresh brief fills those
  // first, so "registered but unresearched" is always visible.
  registered: integer("registered", { mode: "boolean" }).notNull().default(false),
  sourceLabel: text("source_label").notNull().default(""),
  researchedAt: integer("researched_at", { mode: "timestamp_ms" }),
});

// The user's OWN ratings of shops they actually visited (user
// instruction, 2026-11-16): one row per shop, keyed by its Tabelog URL
// (normalized Japanese form), upserted on re-rating. rating is 0.0–5.0
// in 0.1 steps from the card's rating slider; memo is the user's
// free-text impression. This is the feedback loop's memory: the nightly
// research brief reads it (rating >= 4.0 shops are prioritized,
// rating <= 2.5 shops are never proposed again — deleting the row
// lifts that exclusion), and getSchedule attaches userRating/userMemo
// to every candidate of the same shop.
export const shopFeedback = sqliteTable("shop_feedback", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  shopName: text("shop_name").notNull(),
  // Identity of the shop: its Tabelog page URL (UNIQUE, one rating per
  // shop; re-rating overwrites).
  tabelogUrl: text("tabelog_url").notNull().unique(),
  rating: real("rating").notNull(),
  memo: text("memo").notNull().default(""),
  // The slot area the shop was rated from (e.g. ○○駅周辺).
  area: text("area").notNull().default(""),
  // The candidate's genre (うどん, ラーメン …) and real photo URL,
  // copied from the candidate at rating time (user instruction,
  // 2026-11-16) so the settings history can be searched by genre and
  // rendered as photo cards. Rows rated before this column existed are
  // backfilled from the candidates table by getFeedback when a matching
  // candidate is still stored. genre "" / photoUrl null = unknown.
  genre: text("genre").notNull().default(""),
  photoUrl: text("photo_url"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const meta = sqliteTable("meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});
