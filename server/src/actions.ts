// Actions for 予定日程付近グルメ (calendar-driven gourmet planner).
//
// Data flow (one retrieval path):
//   refreshSchedule / bootstrap  -> ctx.agent.spawnTask (reads the
//     connected account's Google Calendar via its connector, researches
//     Tabelog on tabelog.com, verifies score >= 3.3 on the page)
//     -> saveCandidates (validates, dedupes, stores)
//   getSchedule reads stored rows only; the client never fetches sources.
//
// Calendar scope: ONLY the connected account's own primary calendar is
// read. Calendars owned by other people (shared / family calendars),
// holiday calendars, and subscribed calendars are never read; other
// people's events never become lunch slots.
//
// Food preferences (preferred genres, lunch budget, souvenir-sweets
// focus) live in the meta store as editable settings
// (getSettings / updateSettings) and are interpolated into every
// refresh research brief, so candidate selection follows them. See
// ADOPTER_CONFIG below for the adopter-specific values (home area,
// route origin stations, frequent cafe stations).

import { defineAction, z, type ActionsModule, type Ctx } from "@hatch/space-sdk";
import { asc, eq, inArray, lt } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import * as schema from "./schema";

/* ================= Adopter configuration =================
 *
 * この公開コピーを自分の環境で使う人が、最初に書き換える場所。
 * 個人設定はすべてここに集約され、コードの他の部分はこの値を参照する。
 *
 * - homeStation / homeAreaLabel: 予定のない日に候補を探す
 *   「ホームエリア」。例: homeStation: "新宿駅", homeAreaLabel: "新宿"
 * - routeOriginStations: 自宅最寄りの出発駅を2つ。行き方（経路）は
 *   この駅を比較して、安い方（同額なら乗換が少ない・早い方）を採用する。
 *   例: ["○○駅", "△△駅"]
 * - frequentCafeStations: よく行く駅を事前登録しておくと、カフェDBの
 *   調査対象として優先的に埋まる。例: ["新宿駅", "東京駅"]
 */
const ADOPTER_CONFIG = {
  homeStation: "○○駅",
  homeAreaLabel: "○○",
  routeOriginStations: ["○○駅", "△△駅"] as string[],
  frequentCafeStations: [] as string[],
};

/* ---------------- Tokyo date helpers ---------------- */

const DAY_MS = 86_400_000;

function tokyoToday(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "01";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function parseDate(value: string): Date {
  return new Date(`${value}T00:00:00Z`);
}

function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(value: string, n: number): string {
  return fmtDate(new Date(parseDate(value).getTime() + n * DAY_MS));
}

/** Monday (YYYY-MM-DD) of the week containing `value`. */
function mondayOf(value: string): string {
  const dow = parseDate(value).getUTCDay(); // 0=Sun
  const delta = dow === 0 ? -6 : 1 - dow;
  return addDays(value, delta);
}

/* ---------------- Optional adopter seed ---------------- */

type SeedCandidate = {
  name: string;
  genre: string;
  score: number;
  priceLabel: string;
  overBudget?: boolean;
  tabelogUrl?: string;
  note?: string;
};
type SeedSlot = {
  date: string;
  eventKey: string;
  eventTitle: string;
  eventStart: string | null;
  eventEnd: string | null;
  allDay: boolean;
  location: string;
  area: string;
  candidates: SeedCandidate[];
};

// Optional first-run seed. The public copy ships EMPTY: a fresh
// install starts with no slots or candidates, and the first refresh
// builds everything from the adopter's own calendar and research.
// Adopters may add their own researched slots here in the SeedSlot
// shape (Tabelog score >= 3.3 only); bootstrap inserts them once.
const SEED: SeedSlot[] = [];

/* ---------------- Refresh task ---------------- */

async function getMeta(ctx: Ctx, key: string): Promise<string | null> {
  const db = ctx.db<typeof schema>();
  const rows = await db.select().from(schema.meta).where(eq(schema.meta.key, key));
  return rows[0]?.value ?? null;
}

async function setMeta(ctx: Ctx, key: string, value: string) {
  const db = ctx.db<typeof schema>();
  await db
    .insert(schema.meta)
    .values({ key, value })
    .onConflictDoUpdate({ target: schema.meta.key, set: { value } });
}

/* ---------------- Tabelog URL normalization (Japanese only) ---------------- */

// The user requires Japanese Tabelog links only. Locale-prefixed URLs
// (tabelog.com/en/…, /cn/…, /tw/…, s.tabelog.com/en/…) are normalized to
// https://tabelog.com/<path without locale segment>. Applied on save, on
// read, and by the stored-data healing pass, so a locale URL can neither
// be stored nor displayed.
function normalizeTabelogUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (!u.hostname.endsWith("tabelog.com")) return url;
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length && /^(en|cn|tw|ko)$/.test(parts[0] ?? "")) parts.shift();
    const path = parts.length ? `/${parts.join("/")}/` : "/";
    return `https://tabelog.com${path}`;
  } catch {
    return url;
  }
}

/* ---------------- Station routes (home stations -> destination) -------- */

// The user's configured home stations (ADOPTER_CONFIG
// .routeOriginStations). For each destination station, all origins are
// compared and the cheaper / more reasonable route is adopted (cheapest
// IC fare first; ties broken by fewer transfers, then faster).
// Fares/times must come from a real route search — never estimated.
// Routes are stored per destination station and reused by every slot
// heading there. An adopter may pre-seed verified routes below; by
// default the seed is empty and the refresh research fills the table.
type RouteLeg = {
  line: string;
  fromStation: string;
  toStation: string;
  stops: number;
  minutes: number;
  note: string;
};
type StationRouteSeed = {
  destStation: string;
  originStation: string;
  fareIcYen: number | null;
  durationMin: number | null;
  transfers: number;
  sourceLabel: string;
  sourceUrl: string | null;
  legs: RouteLeg[];
  note: string;
};

const STATION_ROUTE_SEED: StationRouteSeed[] = [];

/** Insert the verified station routes when a destination has none yet.
 * Existing rows (e.g. re-researched by a refresh with newer fares) are
 * never overwritten. Idempotent; called from healStoredData, which runs
 * on the production paths (refreshSchedule / saveCandidates). */
async function seedStationRoutes(ctx: Ctx): Promise<void> {
  const db = ctx.db<typeof schema>();
  for (const r of STATION_ROUTE_SEED) {
    await db
      .insert(schema.stationRoutes)
      .values({
        destStation: r.destStation,
        originStation: r.originStation,
        fareIcYen: r.fareIcYen,
        durationMin: r.durationMin,
        transfers: r.transfers,
        sourceLabel: r.sourceLabel,
        sourceUrl: r.sourceUrl,
        legsJson: JSON.stringify(r.legs),
        note: r.note,
      })
      .onConflictDoNothing({ target: schema.stationRoutes.destStation });
  }
}

function parseLegs(json: string): RouteLeg[] {
  try {
    const raw = JSON.parse(json) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((l): l is Record<string, unknown> => typeof l === "object" && l !== null)
      .map((l) => ({
        line: typeof l.line === "string" ? l.line : "",
        fromStation: typeof l.fromStation === "string" ? l.fromStation : "",
        toStation: typeof l.toStation === "string" ? l.toStation : "",
        stops: typeof l.stops === "number" ? l.stops : 0,
        minutes: typeof l.minutes === "number" ? l.minutes : 0,
        note: typeof l.note === "string" ? l.note : "",
      }));
  } catch {
    return [];
  }
}

/** Destination station for a slot, from its title/location/area text.
 * Home-area fallback slots map to the configured home station; outing
 * slots match a configured station (home or frequent) named in the
 * text, with or without the 駅 suffix. Returns null when no known
 * station applies (route stays empty until a refresh researches that
 * station). */
function destStationForSlot(s: {
  kind: string;
  eventTitle: string;
  location: string;
  area: string;
}): string | null {
  if (s.kind === "home") return ADOPTER_CONFIG.homeStation || null;
  const text = `${s.eventTitle} ${s.location} ${s.area}`;
  if (
    ADOPTER_CONFIG.homeAreaLabel &&
    text.includes(ADOPTER_CONFIG.homeAreaLabel)
  ) {
    return ADOPTER_CONFIG.homeStation || null;
  }
  for (const station of [
    ADOPTER_CONFIG.homeStation,
    ...ADOPTER_CONFIG.frequentCafeStations,
  ]) {
    if (!station) continue;
    const bare = station.replace(/駅$/, "");
    if (text.includes(station) || (bare !== "" && text.includes(bare))) {
      return station;
    }
  }
  return null;
}

/** Station key for the cafe database: the slot's destination station.
 * Falls back to an explicit 「○○駅」 named in the title/location/area
 * text so new destinations the route table does not know yet still get
 * their own cafe-database entry. */
function stationForSlot(s: {
  kind: string;
  eventTitle: string;
  location: string;
  area: string;
}): string | null {
  const known = destStationForSlot(s);
  if (known) return known;
  const text = `${s.eventTitle} ${s.location} ${s.area}`;
  const m = text.match(/[^\s　・／]{1,12}駅/);
  return m ? m[0] : null;
}

type CafeLocationType = "inside" | "outside" | "unknown";

type StationCafeInput = {
  name: string;
  chainName: string;
  address: string;
  mapUrl: string;
  photoUrl?: string | null;
  sourceLabel?: string;
  sourceUrl?: string | null;
  note: string;
  locationType?: CafeLocationType;
};

/** Upsert cafes into the station-level cafe database. Existing rows are
 * refreshed (address/map/photo/location type/source/research date) but
 * never duplicated. BOTH station-interior (駅中) and outside (駅外)
 * shops are stored (user rule change, 2026-11-15: the interior
 * exclusion is abolished in favour of classification). Also marks the
 * station as researched in cafe_stations so later refreshes skip
 * re-searching it. */
async function upsertStationCafes(
  ctx: Ctx,
  station: string,
  cafesIn: StationCafeInput[],
  fallbackSourceLabel: string,
): Promise<void> {
  const db = ctx.db<typeof schema>();
  const clean = cafesIn.filter((c) => c.mapUrl.startsWith("http"));
  let rank = 0;
  for (const c of clean) {
    const values = {
      station,
      name: c.name,
      chainName: canonicalChainName(c.chainName),
      address: c.address,
      mapUrl: c.mapUrl,
      photoUrl: c.photoUrl ?? null,
      sourceLabel: c.sourceLabel || fallbackSourceLabel,
      sourceUrl: c.sourceUrl ?? null,
      note: c.note,
      locationType: resolveCafeLocationType(c),
      rank: rank++,
      researchedAt: new Date(),
      updatedAt: new Date(),
    };
    await db
      .insert(schema.stationCafes)
      .values(values)
      .onConflictDoUpdate({
        target: [schema.stationCafes.station, schema.stationCafes.name],
        set: {
          chainName: values.chainName,
          address: values.address,
          mapUrl: values.mapUrl,
          photoUrl: values.photoUrl,
          sourceLabel: values.sourceLabel,
          sourceUrl: values.sourceUrl,
          note: values.note,
          locationType: values.locationType,
          researchedAt: values.researchedAt,
          updatedAt: values.updatedAt,
        },
      });
  }
  if (clean.length) {
    await db
      .insert(schema.cafeStations)
      .values({
        station,
        registered: true,
        sourceLabel: fallbackSourceLabel,
        researchedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: schema.cafeStations.station,
        set: { registered: true, researchedAt: new Date() },
      });
  }
}

/** Mirror every stored per-slot cafe into the station cafe database
 * (insert-if-absent, so agent-refreshed rows are never overwritten) and
 * mark those stations researched. This moves the existing researched
 * stations into the database on the production paths
 * (refreshSchedule / saveCandidates / bootstrap). */
async function mirrorCafesToStationDb(ctx: Ctx): Promise<void> {
  const db = ctx.db<typeof schema>();
  const slotRows = await db.select().from(schema.slots);
  const legacy = await db
    .select()
    .from(schema.cafes)
    .orderBy(asc(schema.cafes.rank));
  const bySlot = new Map<number, typeof legacy>();
  for (const c of legacy) {
    const list = bySlot.get(c.slotId) ?? [];
    list.push(c);
    bySlot.set(c.slotId, list);
  }
  for (const s of slotRows) {
    const rows = bySlot.get(s.id) ?? [];
    if (!rows.length) continue;
    const station = stationForSlot(s);
    if (!station) continue;
    let rank = 0;
    for (const c of rows) {
      await db
        .insert(schema.stationCafes)
        .values({
          station,
          name: c.name,
          chainName: c.chainName,
          address: c.address,
          mapUrl: c.mapUrl,
          locationType: resolveCafeLocationType(c),
          photoUrl: null,
          sourceLabel: "既存の枠別調査から移行",
          sourceUrl: null,
          note: c.note,
          rank: rank++,
          researchedAt: s.updatedAt,
          updatedAt: new Date(),
        })
        .onConflictDoNothing({
          target: [schema.stationCafes.station, schema.stationCafes.name],
        });
    }
    await db
      .insert(schema.cafeStations)
      .values({
        station,
        registered: true,
        sourceLabel: "既存の枠別調査から移行",
        researchedAt: s.updatedAt,
      })
      .onConflictDoNothing({ target: schema.cafeStations.station });
    // A pre-registration marker may already exist with researchedAt null
    // (registered before its cafes were mirrored) — this station HAS
    // cafes, so mark it researched.
    const marker = await db
      .select()
      .from(schema.cafeStations)
      .where(eq(schema.cafeStations.station, station));
    if (marker[0] && marker[0].researchedAt == null) {
      await db
        .update(schema.cafeStations)
        .set({
          researchedAt: s.updatedAt,
          sourceLabel: "既存の枠別調査から移行",
        })
        .where(eq(schema.cafeStations.station, station));
    }
  }
}

/** Stations pre-registered as frequent destinations
 * (ADOPTER_CONFIG.frequentCafeStations): their cafes are researched
 * into the cafe database ahead of any trip. They start as
 * registered-but-unresearched and the nightly refresh fills them with
 * top priority. Empty by default — each adopter registers their own. */
const PRE_REGISTERED_CAFE_STATIONS: readonly string[] =
  ADOPTER_CONFIG.frequentCafeStations;

/* ---------------- Cafe database seed ---------------- */

// Optional verified cafe seed, inserted insert-if-absent per
// station+name (agent-researched rows are never overwritten). The
// public copy ships EMPTY: stations are researched by the refresh
// agent from each adopter's own destinations and stored in the
// station cafe database. Adopters may add their own verified shops
// here in the StationCafeSeed shape.
type StationCafeSeed = {
  station: string;
  name: string;
  chainName: string;
  address: string;
  sourceUrl: string;
  note: string;
  // Provenance label override (batches verified on a different date).
  label?: string;
  // 駅中/駅外 classification when the builder judged it explicitly;
  // omitted rows are inferred from name/address/note on insert.
  locationType?: CafeLocationType;
};

const CAFE_DB_SEED_LABEL = "チェーン公式店舗ページ／店舗情報で確認";

const CAFE_DB_SEED: StationCafeSeed[] = [];

function mapsSearchUrl(query: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

/** Insert the verified cafe-database seed (insert-if-absent per
 * station+name) and mark those stations researched. Idempotent; called
 * from healStoredData on the production paths. */
async function seedCafeDatabase(ctx: Ctx): Promise<void> {
  const db = ctx.db<typeof schema>();
  const byStation = new Map<string, StationCafeSeed[]>();
  for (const s of CAFE_DB_SEED) {
    const list = byStation.get(s.station) ?? [];
    list.push(s);
    byStation.set(s.station, list);
  }
  for (const [station, shops] of byStation) {
    // Continue ranks after any rows the station already has (e.g. the
    // mirrored shops）, so seeded shops append
    // instead of colliding with existing ranks.
    const existing = await db
      .select({ rank: schema.stationCafes.rank })
      .from(schema.stationCafes)
      .where(eq(schema.stationCafes.station, station));
    let rank = existing.reduce((m, r) => Math.max(m, r.rank), -1) + 1;
    for (const s of shops) {
      await db
        .insert(schema.stationCafes)
        .values({
          station,
          name: s.name,
          chainName: canonicalChainName(s.chainName),
          address: s.address,
          mapUrl: mapsSearchUrl(`${s.name} ${station}`),
          locationType: s.locationType ?? inferCafeLocationType(s),
          photoUrl: null,
          sourceLabel: s.label ?? CAFE_DB_SEED_LABEL,
          sourceUrl: s.sourceUrl,
          note: s.note,
          rank: rank++,
          researchedAt: new Date(),
          updatedAt: new Date(),
        })
        .onConflictDoNothing({
          target: [schema.stationCafes.station, schema.stationCafes.name],
        });
    }
    const marker = await db
      .select()
      .from(schema.cafeStations)
      .where(eq(schema.cafeStations.station, station));
    if (marker[0] && marker[0].researchedAt == null) {
      await db
        .update(schema.cafeStations)
        .set({ researchedAt: new Date(), sourceLabel: CAFE_DB_SEED_LABEL })
        .where(eq(schema.cafeStations.station, station));
    } else if (!marker[0]) {
      await db.insert(schema.cafeStations).values({
        station,
        registered: true,
        sourceLabel: CAFE_DB_SEED_LABEL,
        researchedAt: new Date(),
      });
    }
  }
}

/** Make sure every pre-registered station exists in cafe_stations as a
 * registered destination (insert-if-absent; researched markers kept). */
async function ensureRegisteredCafeStations(ctx: Ctx): Promise<void> {
  const db = ctx.db<typeof schema>();
  for (const station of PRE_REGISTERED_CAFE_STATIONS) {
    await db
      .insert(schema.cafeStations)
      .values({
        station,
        registered: true,
        sourceLabel: "事前登録した行き先駅",
        researchedAt: null,
      })
      .onConflictDoNothing({ target: schema.cafeStations.station });
  }
}

/* ---------------- Duplicate-slot healing ---------------- */

function normText(s: string): string {
  return s.replace(/[\s　]+/g, "").toLowerCase();
}

/* ---------------- Shop identity (dedupe + exclusion list) ---------------- */

// A shop's identity: the Tabelog restaurant id embedded in its page URL
// (a pure-numeric path segment of 7+ digits, e.g. …/A1304/A130402/13041176/),
// else the normalized Japanese URL, else the normalized shop name.
function shopKey(name: string, tabelogUrl: string | null): string {
  const url = normalizeTabelogUrl(tabelogUrl);
  if (url) {
    const seg = url.split("/").find((p) => /^\d{7,}$/.test(p));
    if (seg) return `tid:${seg}`;
    return `url:${url.replace(/\/$/, "")}`;
  }
  return `name:${normText(name)}`;
}

/** True when two candidate-like rows describe the same shop: same Tabelog
 * identity key, or same normalized name. */
function isSameShop(
  a: { name: string; tabelogUrl: string | null },
  b: { name: string; tabelogUrl: string | null },
): boolean {
  if (shopKey(a.name, a.tabelogUrl) === shopKey(b.name, b.tabelogUrl)) return true;
  const na = normText(a.name);
  const nb = normText(b.name);
  return na.length > 0 && na === nb;
}

/* ---------------- Cafe location classification (駅中 / 駅外) ---------------- */

// RULE CHANGE (user instruction, 2026-11-15): the station-interior
// EXCLUSION is abolished. Every cafe is classified and displayed:
//   "inside"  = 駅中 — inside the ticket gates (改札内), on the station
//               concourse (コンコース内), inside an エキナカ commercial
//               facility, or inside a station-direct underground
//               concourse (駅直結の地下街).
//   "outside" = 駅外 — everything else, INCLUDING shops inside station
//               buildings (駅ビル: ルミネ / アトレ etc.).
//   "unknown" = 未判定 — cannot be judged from the available evidence;
//               shown honestly as 未判定 (never disguised as 駅外) and
//               re-judged on the next research pass.
// Judgement follows the shop's official description / address wording,
// kept with its source on the row.

/** Infer the classification from a shop's own name/address/note text. */
function inferCafeLocationType(c: {
  name: string;
  address: string;
  note: string;
}): CafeLocationType {
  const t = `${c.name} ${c.address} ${c.note}`;
  // An explicit 改札外 (outside the gates) statement wins over facility
  // names — e.g. a shop whose address says 「○○改札外2F」.
  if (/改札外/.test(t)) return "outside";
  if (
    /改札内|駅構内|コンコース|エキナカ|駅ナカ|エチカ|エミオ|エキア|ショッピングパーク|エキュート|改札前/.test(
      t,
    )
  ) {
    return "inside";
  }
  // A real street address means a street-level / station-building shop:
  // both are 駅外 by definition.
  if (c.address.trim().length > 0) return "outside";
  if (/ルミネ|アトレ|サンシャイン|マークシティ|百貨店|ビル|タワー|ホテル/.test(t)) {
    return "outside";
  }
  return "unknown";
}

/** The classification to store for an incoming cafe: the research
 * agent's explicit value wins; "unknown"/absent falls back to
 * inference from the shop's own text. */
function resolveCafeLocationType(c: {
  name: string;
  address: string;
  note: string;
  locationType?: CafeLocationType | null;
}): CafeLocationType {
  if (c.locationType === "inside" || c.locationType === "outside") {
    return c.locationType;
  }
  return inferCafeLocationType(c);
}

/* ---------------- Canonical cafe brand names ---------------- */

// The UI groups each slot's cafes into per-brand pulldowns by the exact
// chainName string, so one brand must always use ONE spelling (user
// instruction, 2026-11-15: 「タリーズ」で統一し「タリーズコーヒー」と
// 混在させない). Research agents have saved variants (タリーズコーヒー
// at one station vs タリーズ everywhere else); canonicalChainName maps
// known variants to the canonical brand name. Applied on every save
// (upsertStationCafes / saveCandidates) and to stored rows by
// healStoredData, so variants can neither persist nor re-enter.
const CHAIN_NAME_CANONICAL: Record<string, string> = {
  "タリーズコーヒー": "タリーズ",
  "タリーズ コーヒー": "タリーズ",
  "スターバックスコーヒー": "スターバックス",
  "スターバックス コーヒー": "スターバックス",
  "ドトールコーヒー": "ドトール",
  "ドトールコーヒーショップ": "ドトール",
  "エクセルシオールカフェ": "エクセルシオール カフェ",
  "カフェドクリエ": "カフェ・ド・クリエ",
  "ルノアール": "喫茶室ルノアール",
  "PRONTO": "プロント",
};

function canonicalChainName(name: string): string {
  const t = name.trim();
  return CHAIN_NAME_CANONICAL[t] ?? t;
}

type HiddenRow = { shopKey: string; name: string; tabelogUrl: string | null };

function matchesHidden(
  c: { name: string; tabelogUrl: string | null },
  hidden: HiddenRow[],
): boolean {
  return hidden.some((h) => isSameShop(c, h));
}

async function loadHidden(ctx: Ctx): Promise<HiddenRow[]> {
  const db = ctx.db<typeof schema>();
  const rows = await db.select().from(schema.hiddenShops);
  return rows.map((r) => ({
    shopKey: r.shopKey,
    name: r.name,
    tabelogUrl: r.tabelogUrl,
  }));
}

/* ---------------- User feedback (own ratings of visited shops) -------- */

// The user's own ratings (user instruction, 2026-11-16), one row per
// shop keyed by its Tabelog URL. Feedback loop rules:
//   rating >= 4.0 → the research brief prioritizes the shop.
//   rating <= 2.5 → the shop is never proposed again (enforced on
//     save, in healing, and on read — exactly like the exclusion
//     list) until the user deletes the rating, which lifts it.
// Matching uses the same shop identity as the exclusion list
// (Tabelog restaurant id / URL / normalized name), so a rating follows
// the shop even if a later research pass saves a slightly different
// URL form for it.
type FeedbackRow = {
  shopName: string;
  tabelogUrl: string;
  rating: number;
  memo: string;
  area: string;
  genre: string;
  photoUrl: string | null;
};

async function loadFeedback(ctx: Ctx): Promise<FeedbackRow[]> {
  const db = ctx.db<typeof schema>();
  const rows = await db.select().from(schema.shopFeedback);
  return rows.map((r) => ({
    shopName: r.shopName,
    tabelogUrl: r.tabelogUrl,
    rating: r.rating,
    memo: r.memo,
    area: r.area,
    genre: r.genre,
    photoUrl: r.photoUrl,
  }));
}

function feedbackFor(
  c: { name: string; tabelogUrl: string | null },
  feedback: FeedbackRow[],
): FeedbackRow | undefined {
  return feedback.find((f) =>
    isSameShop(c, { name: f.shopName, tabelogUrl: f.tabelogUrl }),
  );
}

function isLowRated(
  c: { name: string; tabelogUrl: string | null },
  feedback: FeedbackRow[],
): boolean {
  const f = feedbackFor(c, feedback);
  return f != null && f.rating <= 2.5;
}

/* ---------------- Budget hard exclusion + business hours ---------------- */

// HARD BUDGET RULE (user instruction, 2026-11-14): a shop whose Tabelog
// price range for the relevant meal does not fit inside the settings
// budget is NEVER proposed — no "over budget" flag display. The judgement
// matches the old overBudget flag: the agent's flag counts, and so does
// the upper bound parsed out of the Tabelog price label (e.g.
// "¥6,000〜¥7,999" with a ¥2,000 budget is over). Enforced on save, in the
// stored-data healing (existing over-budget rows are deleted and the
// nightly research refills with in-budget shops), and on read.
function isOverBudgetCandidate(
  c: { priceLabel: string; overBudget: boolean },
  budgetYen: number,
): boolean {
  if (c.overBudget) return true;
  const nums = (c.priceLabel.match(/\d[\d,]*/g) ?? []).map((s) =>
    Number(s.replaceAll(",", "")),
  );
  const max = nums.length ? Math.max(...nums) : null;
  return max != null && Number.isFinite(max) && max > budgetYen;
}

const WEEKDAY_KANJI = ["日", "月", "火", "水", "木", "金", "土"] as const;

function fmtMinutes(min: number): string {
  const h = Math.floor(min / 60) % 24;
  const m = min % 60;
  return `${h}:${String(m).padStart(2, "0")}`;
}

/** Parse "HH:MM～HH:MM" ranges out of a Tabelog hours string. A range
 * whose end is not after its start crosses midnight (end += 24h). */
function parseHourRanges(hoursText: string): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = [];
  const re = /(\d{1,2}):(\d{2})\s*[～~〜\-–—]\s*(\d{1,2}):(\d{2})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(hoursText)) !== null) {
    const start = Number(m[1]) * 60 + Number(m[2]);
    let end = Number(m[3]) * 60 + Number(m[4]);
    if (end <= start) end += 24 * 60;
    ranges.push({ start, end });
  }
  return ranges;
}

/** The window in which the user would actually use the shop in a slot:
 * lunch slots and all-day outings use the lunch window (11:00–14:00);
 * an evening event (start >= 17:00, e.g. a 19:00 class) uses the two
 * hours before the event starts (dinner before the event). */
function usageWindow(slot: {
  eventStart: string | null;
  allDay: boolean;
}): { start: number; end: number } {
  if (!slot.allDay && slot.eventStart) {
    const t = slot.eventStart.match(/T(\d{2}):(\d{2})/);
    if (t) {
      const startMin = Number(t[1]) * 60 + Number(t[2]);
      if (startMin >= 17 * 60) return { start: startMin - 120, end: startMin };
    }
  }
  return { start: 11 * 60, end: 14 * 60 };
}

/** Warning shown on a candidate card when the shop may not be open
 * during the slot's usage window: closed on that weekday, irregular
 * holidays, or no overlap (>= 30 min) between the window and the shop's
 * Tabelog hours. Returns "" when the hours cover the window or cannot
 * be judged (unconfirmed hours are labelled 未確認 by the UI instead —
 * hours are never invented). */
function hoursWarningFor(
  slot: { date: string; eventStart: string | null; allDay: boolean },
  c: { hoursText: string; closedDays: string },
): string {
  const wd = WEEKDAY_KANJI[parseDate(slot.date).getUTCDay()] ?? "";
  const closed = c.closedDays.trim();
  if (closed) {
    if (/不定休/.test(closed)) {
      return "定休日は不定休のため、この日に営業するか要確認です";
    }
    if (!/無休|年中無休/.test(closed) && closed.includes(wd)) {
      return `${wd}曜定休のため、この日は営業していない可能性があります`;
    }
  }
  if (!c.hoursText.trim()) return "";
  const ranges = parseHourRanges(c.hoursText);
  if (!ranges.length) return "";
  const w = usageWindow(slot);
  const covered = ranges.some(
    (r) => Math.min(r.end, w.end) - Math.max(r.start, w.start) >= 30,
  );
  if (covered) return "";
  return `この枠の利用時間帯（${fmtMinutes(w.start)}～${fmtMinutes(w.end)}）は営業時間外の可能性があります`;
}

type SlotIdentity = {
  date: string;
  kind: string;
  eventTitle: string;
  eventStart: string | null;
};

/** True when two slots on the same date describe the same calendar event,
 * even if their eventKeys differ (seed key vs calendar id) or the title was
 * re-typed (e.g. a shortened artist name) — matched by title containment or
 * by identical start time. Distinct same-day events (different titles AND
 * different start times, e.g. a 14:30 appointment vs a 19:00 class)
 * never match. */
function isSameEventSlot(a: SlotIdentity, b: SlotIdentity): boolean {
  if (a.date !== b.date || a.kind !== b.kind) return false;
  if (a.kind === "home") return true;
  const ta = normText(a.eventTitle);
  const tb = normText(b.eventTitle);
  if (ta && tb && (ta === tb || ta.includes(tb) || tb.includes(ta))) return true;
  if (a.eventStart && b.eventStart && a.eventStart === b.eventStart) return true;
  return false;
}

/**
 * Idempotent stored-data healing, run from bootstrap / refreshSchedule /
 * saveCandidates (the client never calls bootstrap directly, so the passes
 * live on paths the nightly cron and the refresh agent actually execute):
 * 0. Enforce the user's exclusion list (shops hidden via the circled-! button are deleted from
 *    every slot) and the home-area weekly no-repeat rule (same shop only
 *    once per Mon–Sun week across that week's home-area slots, meals and
 *    sweets sharing one pool).
 * 1. Normalize every stored Tabelog URL (candidates + articles) to the
 *    Japanese tabelog.com form.
 * 3. Merge duplicate slots for the same date+event into one: children are
 *    unioned (same shop name kept once, longer note wins), empty duplicate
 *    slots are deleted.
 * 4. Cap every slot at 15 meal / 3 sweets candidates, preserving rank
 *    order (display order encodes nearest-station-area-first, so ranks
 *    are never re-sorted by score here). Merges can union a slot past
 *    the save-time caps; this pass trims the overflow until the next
 *    research pass re-saves that slot.
 * 0d also enforces the HARD BUDGET RULE: stored meal candidates over
 *    the settings budget are deleted (the research refills in-budget).
 */
async function healStoredData(ctx: Ctx): Promise<void> {
  const db = ctx.db<typeof schema>();

  // Station routes: make sure the verified per-station routes exist
  // (insert-if-absent; refreshed rows with newer fares are kept).
  await seedStationRoutes(ctx);

  // Cafe database: register the user's pre-registered destination
  // stations, then mirror any per-slot cafes into the station-level
  // database so already-researched stations are served from the DB and
  // never re-searched (insert-if-absent; DB rows win).
  // Order matters: seed + mirror first (they set researched markers for
  // stations that already have cafes), and only then register the
  // remaining pre-registered stations as unresearched — otherwise a
  // null researchedAt marker would block the researched ones.
  await seedCafeDatabase(ctx);
  await mirrorCafesToStationDb(ctx);
  await ensureRegisteredCafeStations(ctx);

  // 0a2) Canonical brand names (user instruction, 2026-11-15): one brand
  // uses one chainName spelling everywhere, so the per-brand pulldowns
  // never split a brand in two (e.g. タリーズ vs タリーズコーヒー).
  // Rewrite any stored variant in both cafe tables.
  {
    const dbCafes = await db.select().from(schema.stationCafes);
    for (const c of dbCafes) {
      const canon = canonicalChainName(c.chainName);
      if (canon !== c.chainName) {
        await db
          .update(schema.stationCafes)
          .set({ chainName: canon })
          .where(eq(schema.stationCafes.id, c.id));
      }
    }
    const slotCafes = await db.select().from(schema.cafes);
    for (const c of slotCafes) {
      const canon = canonicalChainName(c.chainName);
      if (canon !== c.chainName) {
        await db
          .update(schema.cafes)
          .set({ chainName: canon })
          .where(eq(schema.cafes.id, c.id));
      }
    }
  }

  // 0a) Exclusion list: a shop the user hid is removed from every
  // slot and never comes back (saveCandidates also filters on insert).
  const hiddenRows = await loadHidden(ctx);
  if (hiddenRows.length) {
    const stored = await db.select().from(schema.candidates);
    for (const c of stored) {
      if (matchesHidden(c, hiddenRows)) {
        await db.delete(schema.candidates).where(eq(schema.candidates.id, c.id));
      }
    }
  }

  // 0a1) Low user ratings (user instruction, 2026-11-16): a shop the
  // user rated <= 2.5 is removed from every slot and never proposed
  // again while that rating stands (saveCandidates filters on insert
  // and getSchedule filters on read, too). Deleting the rating lifts
  // the exclusion; the next research pass may then pick the shop again.
  const feedbackRows = await loadFeedback(ctx);
  if (feedbackRows.some((f) => f.rating <= 2.5)) {
    const stored = await db.select().from(schema.candidates);
    for (const c of stored) {
      if (isLowRated(c, feedbackRows)) {
        await db.delete(schema.candidates).where(eq(schema.candidates.id, c.id));
      }
    }
  }

  // 0b) Home-area weekly no-repeat: inside one Mon–Sun app week,
  // the home-area fallback slots must not propose the
  // same shop twice — meal and souvenir-sweets candidates share one pool.
  // The earliest day in the week keeps the shop; later duplicates are
  // removed (the next nightly research refills from other shops). A new
  // week starts with a clean slate, so the same shop may return then.
  {
    const ikeSlots = (await db.select().from(schema.slots))
      .filter((s) => s.kind === "home")
      .sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
    const seenByWeek = new Map<string, { name: string; tabelogUrl: string | null }[]>();
    for (const s of ikeSlots) {
      const week = mondayOf(s.date);
      const seen = seenByWeek.get(week) ?? [];
      const rows = (await db
        .select()
        .from(schema.candidates)
        .where(eq(schema.candidates.slotId, s.id)))
        .sort((a, b) => a.rank - b.rank);
      for (const c of rows) {
        if (seen.some((x) => isSameShop(c, x))) {
          await db.delete(schema.candidates).where(eq(schema.candidates.id, c.id));
        } else {
          seen.push({ name: c.name, tabelogUrl: c.tabelogUrl });
        }
      }
      seenByWeek.set(week, seen);
    }
  }

  // 0c0) Station cafe dedupe: the same shop can exist twice under
  // name spellings that differ only by whitespace (e.g. mirrored
  // スターバックスコーヒー… vs seeded スターバックス コーヒー…).
  // Group by (station, whitespace-stripped name) and keep the most
  // complete row (official sourceUrl first, then a photo, then the
  // oldest row), carrying over a known classification when the keeper
  // is still 未判定. Without this, one brand at a busy station can
  // read as more shops than really exist (the same shop counted twice
  // under two name spellings).
  {
    const rows = await db
      .select()
      .from(schema.stationCafes)
      .orderBy(asc(schema.stationCafes.id));
    const groups = new Map<string, typeof rows>();
    for (const r of rows) {
      const key = `${r.station}|${normText(r.name)}`;
      const list = groups.get(key) ?? [];
      list.push(r);
      groups.set(key, list);
    }
    for (const list of groups.values()) {
      if (list.length < 2) continue;
      const keeper = [...list].sort(
        (a, b) =>
          Number(b.sourceUrl != null) - Number(a.sourceUrl != null) ||
          Number(b.photoUrl != null) - Number(a.photoUrl != null) ||
          a.id - b.id,
      )[0];
      if (!keeper) continue;
      if (keeper.locationType === "unknown") {
        const known = list.find((r) => r.locationType !== "unknown");
        if (known) {
          await db
            .update(schema.stationCafes)
            .set({ locationType: known.locationType })
            .where(eq(schema.stationCafes.id, keeper.id));
        }
      }
      for (const r of list) {
        if (r.id !== keeper.id) {
          await db
            .delete(schema.stationCafes)
            .where(eq(schema.stationCafes.id, r.id));
        }
      }
    }
  }

  // 0c) Cafe location classification (rule change, 2026-11-15): the
  // station-interior exclusion is abolished — NOTHING is deleted here.
  // Every stored cafe whose classification is still 未判定 gets judged
  // from its name/address/note; shops that can be judged gain 駅中/駅外,
  // the rest stay 未判定 for the next research pass.
  {
    const dbCafes = await db.select().from(schema.stationCafes);
    for (const c of dbCafes) {
      if (c.locationType === "unknown") {
        const inferred = inferCafeLocationType(c);
        if (inferred !== "unknown") {
          await db
            .update(schema.stationCafes)
            .set({ locationType: inferred })
            .where(eq(schema.stationCafes.id, c.id));
        }
      }
    }
    const storedCafes = await db.select().from(schema.cafes);
    for (const c of storedCafes) {
      if (c.locationType === "unknown") {
        const inferred = inferCafeLocationType(c);
        if (inferred !== "unknown") {
          await db
            .update(schema.cafes)
            .set({ locationType: inferred })
            .where(eq(schema.cafes.id, c.id));
        }
      }
    }
  }

  // 0d) HARD BUDGET RULE (user instruction, 2026-11-14): a meal candidate
  // whose Tabelog price range does not fit the settings budget is deleted
  // outright — never kept with an "over budget" flag. The nightly
  // research refills the gaps with in-budget shops; when an area cannot
  // reach the target count within budget, the shortfall stays visible
  // instead of being padded with over-budget shops. (Sweets rows are
  // judged by their overBudget flag only — the research sets it false;
  // souvenir prices are not the lunch budget.)
  {
    const settings = await getSettings(ctx);
    const stored = await db.select().from(schema.candidates);
    for (const c of stored) {
      const over =
        c.category === "meal"
          ? isOverBudgetCandidate(c, settings.budgetYen)
          : c.overBudget;
      if (over) {
        await db.delete(schema.candidates).where(eq(schema.candidates.id, c.id));
      }
    }
  }

  // 1) URL normalization (shop page URLs and map URLs alike — both are
  // tabelog.com URLs and must stay in the Japanese form).
  const allCands = await db.select().from(schema.candidates);
  for (const c of allCands) {
    const n = normalizeTabelogUrl(c.tabelogUrl);
    if (n !== c.tabelogUrl) {
      await db
        .update(schema.candidates)
        .set({ tabelogUrl: n })
        .where(eq(schema.candidates.id, c.id));
    }
    const nm = normalizeTabelogUrl(c.mapUrl);
    if (nm !== c.mapUrl) {
      await db
        .update(schema.candidates)
        .set({ mapUrl: nm })
        .where(eq(schema.candidates.id, c.id));
    }
  }
  const allArts = await db.select().from(schema.tabelogArticles);
  for (const a of allArts) {
    const n = normalizeTabelogUrl(a.url);
    if (n && n !== a.url) {
      await db
        .update(schema.tabelogArticles)
        .set({ url: n })
        .where(eq(schema.tabelogArticles.id, a.id));
    }
  }

  // 4) Cap candidates per slot (15 meals / 3 sweets), preserving rank
  // order — never re-sort by score, because rank encodes the
  // nearest-station-area-first ordering the research brief produces.
  // The meal target is 10+ per slot (user instruction, 2026-11-14); the
  // cap only trims pathological overflow from slot merges.
  const capRows = await db
    .select()
    .from(schema.candidates)
    .orderBy(asc(schema.candidates.rank));
  const bySlotCap = new Map<number, typeof capRows>();
  for (const c of capRows) {
    const list = bySlotCap.get(c.slotId) ?? [];
    list.push(c);
    bySlotCap.set(c.slotId, list);
  }
  for (const rows of bySlotCap.values()) {
    const keep = [
      ...rows.filter((c) => c.category === "meal").slice(0, 15),
      ...rows.filter((c) => c.category === "sweets").slice(0, 3),
    ];
    const keepIds = new Set(keep.map((c) => c.id));
    for (const c of rows) {
      if (!keepIds.has(c.id)) {
        await db.delete(schema.candidates).where(eq(schema.candidates.id, c.id));
      }
    }
    for (let i = 0; i < keep.length; i++) {
      const row = keep[i];
      if (row && row.rank !== i) {
        await db
          .update(schema.candidates)
          .set({ rank: i })
          .where(eq(schema.candidates.id, row.id));
      }
    }
  }

  // 3) Merge duplicate slots (same date + same event).
  const allSlots = await db
    .select()
    .from(schema.slots)
    .orderBy(asc(schema.slots.id));
  if (allSlots.length < 2) return;
  const candRows = await db.select().from(schema.candidates);
  const cafeRows = await db.select().from(schema.cafes);
  const artRows = await db.select().from(schema.tabelogArticles);
  const childCount = new Map<number, number>();
  for (const r of [...candRows, ...cafeRows, ...artRows]) {
    childCount.set(r.slotId, (childCount.get(r.slotId) ?? 0) + 1);
  }
  const clusters: (typeof allSlots)[] = [];
  for (const s of allSlots) {
    const cluster = clusters.find((cl) => cl[0] && isSameEventSlot(cl[0], s));
    if (cluster) cluster.push(s);
    else clusters.push([s]);
  }
  for (const group of clusters) {
    if (group.length < 2) continue;
    const canonical = [...group].sort(
      (a, b) =>
        (childCount.get(b.id) ?? 0) - (childCount.get(a.id) ?? 0) || a.id - b.id,
    )[0];
    if (!canonical) continue;
    // Fill gaps in the canonical slot's fields from the duplicates.
    const patch: {
      eventEnd?: string | null;
      location?: string;
      area?: string;
      status: "ready" | "researching";
      updatedAt: Date;
    } = { status: canonical.status, updatedAt: new Date() };
    for (const other of group) {
      if (other.id === canonical.id) continue;
      if (!canonical.eventEnd && other.eventEnd && !patch.eventEnd) {
        patch.eventEnd = other.eventEnd;
      }
      if (!canonical.location && other.location && !patch.location) {
        patch.location = other.location;
      }
      if (!canonical.area && other.area && !patch.area) {
        patch.area = other.area;
      }
    }
    // Union the children into the canonical slot.
    const canonCands = candRows.filter((c) => c.slotId === canonical.id);
    const canonCafes = cafeRows.filter((c) => c.slotId === canonical.id);
    const canonArts = artRows.filter((a) => a.slotId === canonical.id);
    for (const other of group) {
      if (other.id === canonical.id) continue;
      for (const c of candRows.filter((x) => x.slotId === other.id)) {
        const dupe = canonCands.find((x) => normText(x.name) === normText(c.name));
        if (dupe) {
          if (c.note.length > dupe.note.length) {
            await db
              .update(schema.candidates)
              .set({ note: c.note })
              .where(eq(schema.candidates.id, dupe.id));
            dupe.note = c.note;
          }
          // A collected map URL is never lost in a merge: if the kept
          // row lacks one and the duplicate has one, carry it over.
          if (!dupe.mapUrl && c.mapUrl) {
            await db
              .update(schema.candidates)
              .set({ mapUrl: c.mapUrl })
              .where(eq(schema.candidates.id, dupe.id));
            dupe.mapUrl = c.mapUrl;
          }
          await db.delete(schema.candidates).where(eq(schema.candidates.id, c.id));
        } else {
          await db
            .update(schema.candidates)
            .set({ slotId: canonical.id })
            .where(eq(schema.candidates.id, c.id));
          canonCands.push({ ...c, slotId: canonical.id });
        }
      }
      for (const c of cafeRows.filter((x) => x.slotId === other.id)) {
        const dupe = canonCafes.find((x) => normText(x.name) === normText(c.name));
        if (dupe) {
          await db.delete(schema.cafes).where(eq(schema.cafes.id, c.id));
        } else {
          await db
            .update(schema.cafes)
            .set({ slotId: canonical.id })
            .where(eq(schema.cafes.id, c.id));
          canonCafes.push({ ...c, slotId: canonical.id });
        }
      }
      for (const a of artRows.filter((x) => x.slotId === other.id)) {
        const dupe = canonArts.find(
          (x) => normalizeTabelogUrl(x.url) === normalizeTabelogUrl(a.url),
        );
        if (dupe) {
          await db
            .delete(schema.tabelogArticles)
            .where(eq(schema.tabelogArticles.id, a.id));
        } else {
          await db
            .update(schema.tabelogArticles)
            .set({ slotId: canonical.id })
            .where(eq(schema.tabelogArticles.id, a.id));
          canonArts.push({ ...a, slotId: canonical.id });
        }
      }
      await db.delete(schema.slots).where(eq(schema.slots.id, other.id));
    }
    // Re-rank the merged candidates preserving their existing rank
    // order (nearest-station-area picks first), meals then sweets.
    const merged = await db
      .select()
      .from(schema.candidates)
      .where(eq(schema.candidates.slotId, canonical.id));
    const meals = merged
      .filter((c) => c.category === "meal")
      .sort((a, b) => a.rank - b.rank);
    const sweets = merged
      .filter((c) => c.category === "sweets")
      .sort((a, b) => a.rank - b.rank);
    const ordered = [...meals, ...sweets];
    for (let i = 0; i < ordered.length; i++) {
      const row = ordered[i];
      if (row && row.rank !== i) {
        await db
          .update(schema.candidates)
          .set({ rank: i })
          .where(eq(schema.candidates.id, row.id));
      }
    }
    patch.status = ordered.length > 0 ? "ready" : canonical.status;
    await db
      .update(schema.slots)
      .set(patch)
      .where(eq(schema.slots.id, canonical.id));
  }
}

/* ---------------- Food preference settings ---------------- */

// Selectable options shown in the settings UI. The defaults are exactly the
// preferences the user handed over from the entertainment app (2026-11-14).
const GENRE_OPTIONS = [
  "イタリアン",
  "中華",
  "ラーメン",
  "そば",
  "ハンバーグ",
  "寿司",
  "和食",
  "洋食",
  "フレンチ",
  "カレー",
  "焼肉",
  "天ぷら",
  "うどん",
  "カフェ",
] as const;

const SWEET_OPTIONS = [
  "チョコ",
  "モンブラン",
  "チーズケーキ",
  "シュークリーム",
  "どら焼き",
  "プリン",
  "和菓子",
  "焼き菓子",
  "マカロン",
] as const;

type FoodSettings = {
  genres: string[];
  budgetYen: number;
  sweetsEnabled: boolean;
  sweets: string[];
};

const DEFAULT_SETTINGS: FoodSettings = {
  genres: ["イタリアン", "中華", "ラーメン", "そば", "ハンバーグ", "寿司", "和食"],
  budgetYen: 2000,
  sweetsEnabled: true,
  sweets: ["チョコ", "モンブラン", "チーズケーキ", "シュークリーム", "どら焼き"],
};

const settingsSchema = z.object({
  genres: z.array(z.string().min(1)).max(30),
  budgetYen: z.number().int().min(0).max(10000),
  sweetsEnabled: z.boolean(),
  sweets: z.array(z.string().min(1)).max(30),
});

function sanitizeSettings(input: FoodSettings): FoodSettings {
  return {
    genres: input.genres.filter((g) => (GENRE_OPTIONS as readonly string[]).includes(g)),
    budgetYen: input.budgetYen,
    sweetsEnabled: input.sweetsEnabled,
    sweets: input.sweets.filter((s) => (SWEET_OPTIONS as readonly string[]).includes(s)),
  };
}

async function getSettings(ctx: Ctx): Promise<FoodSettings> {
  const raw = await getMeta(ctx, "settings_v1");
  if (!raw) return DEFAULT_SETTINGS;
  try {
    const parsed = settingsSchema.safeParse(JSON.parse(raw));
    return parsed.success ? sanitizeSettings(parsed.data) : DEFAULT_SETTINGS;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

async function startRefresh(ctx: Ctx): Promise<boolean> {
  const lastStart = await getMeta(ctx, "refresh_started_at");
  if (lastStart) {
    const age = Date.now() - new Date(lastStart).getTime();
    if (age < 10 * 60 * 1000) return false; // a research task is already running
  }
  const settings = await getSettings(ctx);
  const hidden = await loadHidden(ctx);
  const feedback = await loadFeedback(ctx);
  // Stations already in the cafe database: the refresh agent must NOT
  // re-search these — their cafes are served from the DB. Only stations
  // missing here get researched, growing the database per destination.
  const db = ctx.db<typeof schema>();
  const cafeStationRows = await db.select().from(schema.cafeStations);
  const knownCafeStations = cafeStationRows
    .filter((r) => r.researchedAt != null)
    .map((r) => r.station);
  const pendingCafeStations = cafeStationRows
    .filter((r) => r.registered && r.researchedAt == null)
    .map((r) => r.station);
  const today = tokyoToday();
  const start = mondayOf(today);
  const end = addDays(start, 20); // through Sunday of next week
  await setMeta(ctx, "refresh_started_at", new Date().toISOString());
  const message = [
    "You are refreshing the data of this Muse web artifact (予定日程付近グルメ).",
    "",
    "STEP 1 — Read the user's Google Calendar (use the google_calendar connector CLI). FIRST list the calendars (calendar_list.list) and select ONLY the connected account's own primary calendar (the one the account owns, marked as its primary calendar). Read events from " +
      `${start} to ${end} (Asia/Tokyo) from that calendar ONLY. NEVER read calendars owned by someone else that are merely shared with the account (for example a family member's shared calendar), Japanese-holiday calendars, or any other shared/subscribed calendar. Events that belong to other people are out of scope and must never become slots, even if they appear on a shared calendar. Keep OUTING events only: timed events that have a location, plus all-day events whose title names a place or outing (clinic, concert, exhibition, appointment outside home). IMPORTANT: an event whose TITLE itself contains a place word also counts as an outing even when it has no separate location field — use the place named in the title as its area (example: an event titled \"【定期】 ○○駅前クラス\" is an outing at the place named in its title; use that place as its area). A day may have MORE THAN ONE outing event (e.g. an afternoon appointment plus an evening class): create one slot per outing event and never drop or merge one. Skip pure reminders, dividends, release-date markers, holidays, TV/streaming/sports-viewing events with no outing, and events with no location whose title gives no place.`,
    "STEP 2 — For each outing event, determine the meal area. HIGHEST PRIORITY: a station name written in the event TITLE (e.g. 「○○クリニック　△△駅」 → nearest station △△駅, area △△駅周辺) — the user adds station names to titles, and they override the location field and any broader district. Next: the location field, then a place word in the title. NEAREST-STATION AREA FIRST (applies to EVERY slot whose nearest station is identified — from a title station, the location, or the area): research meal candidates in that station's OWN surrounding district first — for station X that district is the streets immediately around X itself, not a broader neighboring district — and put those picks at the FRONT of the slot's candidate list. Shops in ADJACENT districts are fallbacks only: use them when the station's own district yields too few Tabelog >= 3.3 shops, place them AFTER the station-district picks, and state each one's walking distance from the station in its note.",
    `STEP 3 — For every day in the window that has NO outing event, create one fallback slot around the configured home area: kind "home", eventTitle "${ADOPTER_CONFIG.homeStation}周辺ランチ", area "${ADOPTER_CONFIG.homeAreaLabel}". WEEKLY NO-REPEAT RULE (home-area slots): within one Monday–Sunday week, the home-area fallback slots must NEVER propose the same shop twice — meal candidates and souvenir-sweets candidates share one no-repeat pool, so each day of the week gets a completely different set of shops. A busy home area has plenty of Tabelog >= 3.3 restaurants, so build a distinct set of at least 10 in-budget meal candidates (plus sweets) for EVERY home-area day instead of reusing one list all week. A shop may be proposed again only in a LATER week. Shop identity is the Tabelog restaurant id in the URL plus the shop name. The server also enforces this on save (later duplicates inside the same week are dropped), so do not rely on repeats surviving.`,
    ...(hidden.length
      ? [
          `HIDDEN SHOPS — NEVER PROPOSE (user instruction): the user hid these shops with the circled-! button on the candidate card; they are on a permanent exclusion list and must never be proposed again in ANY slot (Home or event slots, meals or sweets): ${hidden
            .slice(0, 100)
            .map((h) => (h.tabelogUrl ? `${h.name} (${h.tabelogUrl})` : h.name))
            .join("; ")}. The server also filters them out on save, on read, and in its stored-data healing.`,
        ]
      : []),
    ...(feedback.length
      ? [
          `USER FEEDBACK — the user's own ratings of shops they actually visited (user instruction, 2026-11-16; this is the feedback loop for candidate selection — the hard rules above do NOT change: Tabelog >= 3.3 only, the ¥${settings.budgetYen} budget cap, and the Home weekly no-repeat rule all still apply in full). Within those rules: (1) PRIORITIZE shops the user rated >= 4.0 — when such a shop qualifies for a slot's area, include it and place it at the FRONT of that slot's candidate list: ${feedback
            .filter((f) => f.rating >= 4.0)
            .map((f) => `${f.shopName} ★${f.rating.toFixed(1)} (${f.tabelogUrl})${f.memo ? ` — user memo: 「${f.memo}」` : ""}`)
            .join("; ") || "(none yet)"}. (2) NEVER PROPOSE shops the user rated <= 2.5, in ANY slot, while that rating stands: ${feedback
            .filter((f) => f.rating <= 2.5)
            .map((f) => `${f.shopName} ★${f.rating.toFixed(1)} (${f.tabelogUrl})`)
            .join("; ") || "(none yet)"}. The server also filters them out on save, on read, and in its stored-data healing. (3) Mid-range ratings (2.6–3.9) carry no priority or exclusion; their memos are context for genre/taste judgement: ${feedback
            .filter((f) => f.rating > 2.5 && f.rating < 4.0)
            .map((f) => `${f.shopName} ★${f.rating.toFixed(1)}${f.memo ? ` 「${f.memo}」` : ""}`)
            .join("; ") || "(none yet)"}.`,
        ]
      : []),
    `STEP 4 — For each slot, research meal candidates ON tabelog.com: open Tabelog search/list pages for the area, then open each restaurant's Tabelog page and read its Tabelog score there. For evening events (e.g. one starting at 19:00), research dinner options the user can reach BEFORE the event start instead of lunch, but apply the same rules. Include ONLY restaurants whose Tabelog score is >= 3.3 — never use Google or any other site's rating. Aim for AT LEAST 10 meal candidates per slot (10–12 is the target); include fewer only if fewer genuinely qualify WITHIN BUDGET (see the hard budget rule next) — never pad the list with over-budget or sub-3.3 shops. HARD BUDGET RULE (user instruction): the settings budget is ¥${settings.budgetYen}. NEVER include a restaurant whose Tabelog price range for the relevant meal (the lunch price range for lunch slots, the dinner price range for evening-event slots) does not fit within ¥${settings.budgetYen} — for example a shop listed at ¥6,000〜¥7,999 or ¥15,000〜¥19,999 must NOT be saved at all, not even with a flag. Exclude it and keep researching until the slot has 10+ in-budget candidates or the area is genuinely exhausted; the server also deletes over-budget shops on save and in its healing pass. Set overBudget to false for every candidate you save. The user's current food preferences (from the app settings) are: preferred genres ${settings.genres.join(", ") || "(none set)"}. Prefer the preferred genres first, then fill remaining places with other genres that qualify. Save meal candidates with category "meal". BUSINESS HOURS ARE MANDATORY (user instruction): for EVERY candidate (meals AND sweets), read the shop's Tabelog page and copy its business hours into hoursText EXACTLY as Tabelog shows them (e.g. "11:00～14:30／17:00～23:00", including lunch/dinner splits when shown) and its regular closing days into closedDays (e.g. "水曜日", "月曜・火曜", "不定休", "無休"). If the page does not state hours or closing days, send an empty string for that field — the UI then shows 営業時間 未確認. NEVER invent, round, or guess hours or closing days. The server cross-checks hoursText/closedDays against the slot's usage window (lunch window, or the hours before an evening event) and the weekday, and flags shops that may be closed — so accurate hours matter. ORDER MATTERS and the server preserves the array order you send as the display order: put the slot's own nearest-station-district candidates FIRST (Tabelog score descending within that group), then any adjacent-district fallbacks (score descending, walking distance from the station stated in the note). For slots with no station-district distinction, plain Tabelog score descending is the order. Re-saving a slot replaces its candidates wholesale, so a re-researched slot returns to its 10+ meal candidates — never accumulate duplicates. Copy each restaurant's tabelog.com URL exactly as shown in the browser. Also note the lunch price range as shown on Tabelog (priceLabel), the genre, and a short factual note (station distance — measured from the slot's nearest station when a title station exists, 百名店, closure info) only when the page states it. REFILLS: when a slot currently shows fewer than 10 meal candidates because shops were deleted by the user, dropped as over-budget, or dropped as same-week Home duplicates, research replacement shops for it (Tabelog >= 3.3, WITHIN the ¥${settings.budgetYen} budget, not on the hidden list, and — for Home slots — not already used by another Home slot in the same week). PHOTO THUMBNAIL (MANDATORY, user instruction 2026-11-15): for EVERY candidate (meals AND sweets), set photoUrl to a real photo OF THAT SHOP: open the shop's Tabelog page and copy the URL of one of its shop/dish photos shown on the page (the tblg.k-img.com image URL) EXACTLY as shown — never shorten, resize, or rewrite it. If the Tabelog page yields no usable photo, fall back to a real photo of the SAME shop from its official website. If that also fails, fall back to a real photo of the SAME GENRE (e.g. a hamburger dish photo from another Tabelog page) — the candidate still ships, but with a genre photo. NEVER leave photoUrl empty when any of these is reachable, NEVER invent or generate a photo URL, and NEVER reuse one shop's photo for a different shop (the genre fallback is the only exception, and it must be a real photo of the same kind of food). MAP LINK (MANDATORY, user instruction 2026-11-16): for EVERY candidate (meals AND sweets), also set mapUrl to the link destination of the map button on the shop's Tabelog page — the 「大きな地図を見る」 link shown together with the shop's address in the 店舗情報 section. Its href is the shop's own Tabelog map page, of the form https://tabelog.com/<area>/<subarea>/<restaurant-id>/dtlmap/. Copy that href EXACTLY as shown in the browser — tapping it in the app opens the shop's map directly, with no intermediate page. NEVER substitute the shop page URL itself, and NEVER build a Google Maps search URL instead: only the actual map-button link copied from the page counts. If the map link genuinely cannot be obtained for a shop, send mapUrl as null — the card then simply shows no 地図を見る link, which is correct; a substitute link pointing at the wrong place is not.`,
    "STEP 4B — Tabelog articles (MANDATORY — same priority as the meal candidates; a slot saved with an empty articles array is an INCOMPLETE save): for each slot, find 1–3 Tabelog articles （まとめ記事 / matome pages on tabelog.com) relevant to that slot's area and lunch (e.g. 「<area> ランチ まとめ」, 「<area> ハンバーグ 特集」) and save them in the slot's `articles` array. Copy each article's exact title as shown in the browser. URLs must be the JAPANESE tabelog.com form (see the URL rule in STEP 7). Only real Tabelog article pages you actually opened — never invent a title or URL.",
    `STEP 5 — Cafes near the station （駅周辺のカフェ） — STATION DATABASE FIRST (user instruction): cafes live in a per-station database and are researched ONCE per station, then reused forever. Stations ALREADY researched in the cafe database: ${knownCafeStations.length ? knownCafeStations.join(", ") : "(none yet)"}. For a slot whose nearest station is in that list, DO NOT research cafes and DO NOT send a cafes array for that slot (send cafes: [] — the server ignores it and serves the slot from the database). Stations REGISTERED but NOT YET researched (the user's pre-registered frequent destinations — fill these with TOP PRIORITY, before anything else in this step): ${pendingCafeStations.length ? pendingCafeStations.join(", ") : "(none)"}. For every OTHER slot station (a genuinely new destination), research it now so it joins the database. Research rules for a station being researched: BY BRAND around the station (the title station when present, else the station nearest the location/area; the configured home station for fallback slots): for EACH major chain brand — スターバックス, タリーズ, ドトール, カフェ・ド・クリエ, エクセルシオール カフェ, 喫茶室ルノアール, プロント, コメダ珈琲店, ベローチェ, サンマルクカフェ, and any other chain with a shop near that station — list EVERY shop of that brand within walking distance of the station. There is NO cafe cap: the same brand can have several usable shops around one station and the user picks by exact location, so include all of them. LOCATION CLASSIFICATION — 駅中/駅外 (user rule change, 2026-11-15; the old station-interior EXCLUSION is ABOLISHED): include EVERY cafe around the station, inside and outside alike, and classify each one. Set locationType to "inside" (駅中) when the shop is inside the ticket gates （改札内）, on the station concourse （コンコース内）, inside an エキナカ commercial facility, or inside a station-direct underground concourse (駅直結の地下街の中にある店舗). Set locationType to "outside" (駅外) for everything else — street-level shops AND shops inside station buildings (駅ビル such as ルミネ / アトレ count as 駅外). Judge from the shop's official store page / listing wording and keep that source on the row. When the location genuinely cannot be judged, OMIT locationType (the server then infers from name/address/note and otherwise stores 未判定) — never guess a shop into 駅外. Only when NO chain cafe exists near the station at all, add independent （個人経営） cafes instead. Verify each cafe actually exists at that station area (search the chain's official store locator or a map listing; do not guess a branch name). EXHAUSTIVENESS RULE (user instruction, 2026-11-15): for every chain brand, cross-check the shop count against the chain's OFFICIAL store search for that station area and list EVERY shop it returns — station-interior shops included, each classified 駅中 — never stop at the first few shops you happen to find. Reference rule: at a major hub station, the official store search for a single brand can return well over ten shops, split between 駅中 and 駅外 — ALL of them belong in the database; a pass that saved only the first few, or that dropped the 駅中 shops, is a research failure. EVERY cafe MUST have a map link: set mapUrl to a Google Maps search URL that pins the exact shop, built as https://www.google.com/maps/search/?api=1&query= + the shop name and station/area (URL-encoded), or the exact map URL shown in the browser. Also set locationType ("inside" = 駅中 / "outside" = 駅外, judged per the LOCATION CLASSIFICATION rule above; omit only when genuinely unjudgeable), chainName (the chain brand — the UI groups cafes into per-brand pulldowns by this EXACT string, so always use the canonical brand name: スターバックス / タリーズ (NEVER タリーズコーヒー) / ドトール / カフェ・ド・クリエ / エクセルシオール カフェ / 喫茶室ルノアール / プロント / コメダ珈琲店 — or "" for independent shops; the server also canonicalizes known variants on save), address when shown, photoUrl ONLY when an official store page or map listing shows a real photo of that shop and you copy its URL exactly (otherwise null — never invent or generate a photo), sourceLabel (where you verified it + today's date), sourceUrl (the exact page URL you verified on, copied verbatim, or null), and a short factual note (station exit / walking distance, seating or power/Wi-Fi info) only when a source states it. HOW TO SAVE researched stations: send them in the TOP-LEVEL stationCafes array of the saveCandidates call: [{ station, name, chainName, address, mapUrl, photoUrl, sourceLabel, sourceUrl, note, locationType }] — one entry per shop, grouped by station then brand. When a researched station belongs to a slot in this window, ALSO include its shops in that slot's cafes array (same objects, without station) so the slot itself is complete. A registered station you could not finish stays unresearched and will be retried first on the next refresh — never mark it done with invented shops. Cafes have no Tabelog score requirement — never invent a score for them.`,
    ...(settings.sweetsEnabled
      ? [
          `STEP 6 — Souvenir sweets （お土産）: the user buys sweets as souvenirs and cares most about ${settings.sweets.join(", ")}. For each slot, ALSO research up to 3 sweets shops near the slot's area ON tabelog.com (patisserie, chocolate shops, 和菓子 shops) whose Tabelog score is >= 3.3 and that are known for one of those preferred items (e.g. a famous モンブラン, a signature シュークリーム, a well-known チョコレート or どら焼き). Save them in the same slot's candidates array with category "sweets"; set genre to the shop type (e.g. 洋菓子, チョコレート, 和菓子）, priceLabel to the Tabelog price range if shown, overBudget false, hoursText and closedDays copied from the shop's Tabelog page exactly as shown (empty string when the page does not state them — never invent hours), photoUrl under the same photo rules as STEP 4 (the shop's own Tabelog photo first, then its official site, else a real same-genre photo — never an invented URL), mapUrl under the same MAP LINK rule as STEP 4 (the 「大きな地図を見る」 map-button link destination on the shop's Tabelog page, copied exactly; null only when it cannot be obtained — never a substitute URL), and note to name the signature preferred item the shop is known for (only when the page states it). If no qualifying sweets shop is found near an area, save none for that slot — never invent one.`,
        ]
      : []),
    "STEP 7 — Save everything by invoking the artifact action `saveCandidates` on this artifact's slug (see space.json) with { slots: [...], stationCafes: [...] (the per-station cafe database entries from STEP 5), routes: [...] (STEP 8) }. Each slot: date (YYYY-MM-DD), eventKey (the Google Calendar event id if available, else `date + '-' + slugified title` — ALWAYS derive it the same way for the same event on every refresh, and never create a second slot for an event that already has one; the server merges by date+event identity as a backstop), kind ('event' or 'home'), eventTitle, eventStart/eventEnd (local ISO with +09:00, or null for all-day), allDay, location, area, candidates: [{ name, genre, score, priceLabel, overBudget (always false — over-budget shops are excluded, never saved), tabelogUrl, mapUrl (the map-button link destination from the shop's Tabelog page, copied exactly — see the MAP LINK rule in STEP 4; null only when unobtainable), photoUrl (real photo of that shop, copied exactly — see the PHOTO THUMBNAIL rule in STEP 4), note, hoursText, closedDays, category ('meal' or 'sweets') }], cafes: [{ name, chainName, address, mapUrl, note, locationType }], articles: [{ title, url }]. URL RULE (user instruction): every Tabelog URL — restaurant pages AND articles — must be the JAPANESE version: host tabelog.com (never s.tabelog.com) and NO locale path segment (strip /en/, /cn/, /tw/, /ko/ if the browser shows one). The server normalizes URLs on save as a backstop, but send the Japanese form yourself.",
    `STEP 8 — Train routes from home (行き方): the user's home stations are ${ADOPTER_CONFIG.routeOriginStations.join(" and ")} (ADOPTER_CONFIG in server/src/actions.ts). Work PER DESTINATION STATION, not per slot: collect the distinct destination stations of this window's slots (plus any new station a future event implies). For each destination station that has no stored route yet (or whose stored route is older than about 3 months), research the route ONCE on a real route-search service （駅探 ekitan.com, Yahoo!路線情報, NAVITIME or Google Maps): compare ALL configured origins (including the short walk between them when a search treats them as one transfer) and adopt the cheaper / more reasonable plan — lowest IC fare first; on a tie, fewer transfers, then faster. Record ONLY values the search result actually shows: fareIcYen (the IC fare), durationMin (total minutes including transfer wait), transfers, and the legs in order [{ line, fromStation, toStation, stops, minutes, note }] (e.g. origin station → line A → transfer station, transfer to line B → destination station). If a fare or time cannot be confirmed, leave that field null — NEVER invent a fare, time, line, or stop count. Save routes in the same saveCandidates call as a top-level \`routes\` array: [{ destStation, originStation, fareIcYen, durationMin, transfers, sourceLabel (the service you used + the date checked), sourceUrl (the exact search-result page URL, copied verbatim), legs, note (why this origin won, e.g. the other origin's fare) }]. Routes already stored for a station are reused as-is — do not re-search or re-send them every refresh.`,
    "If Tabelog cannot be reached for a slot, still save the slot with an empty candidates array so the UI shows an honest researching state. Do not invent scores, prices, or URLs.",
  ].join("\n");
  try {
    await ctx.agent.spawnTask(message, { expectsAction: "saveCandidates" });
    return true;
  } catch {
    return false;
  }
}

/* ---------------- Shared shapes ---------------- */

const candidateOut = z.object({
  id: z.number(),
  name: z.string(),
  genre: z.string(),
  score: z.number(),
  priceLabel: z.string(),
  overBudget: z.boolean(),
  tabelogUrl: z.string().nullable(),
  // Map URL from the map button on the shop's Tabelog page (dtlmap);
  // null = not yet collected, and the card hides its 地図を見る link.
  mapUrl: z.string().nullable(),
  // Real photo URL of this shop (Tabelog page photo first; see
  // candidateIn). Null only for rows saved before photos were collected.
  photoUrl: z.string().nullable(),
  note: z.string(),
  // Business hours / regular closing days exactly as shown on Tabelog;
  // "" = not confirmed on the page (UI shows 営業時間 未確認）.
  hoursText: z.string(),
  closedDays: z.string(),
  // Server-computed: non-empty when the shop may be closed during this
  // slot's usage window (weekday closing day, 不定休, or hours that do
  // not cover the window). "" = no conflict found.
  hoursWarning: z.string(),
  // The user's own rating of this shop (shop_feedback, matched by
  // Tabelog identity) and their memo; null when not yet rated. The
  // card's rating button shows ★<rating> when present.
  userRating: z.number().nullable(),
  userMemo: z.string().nullable(),
});

const cafeOut = z.object({
  id: z.number(),
  name: z.string(),
  chainName: z.string(),
  address: z.string(),
  mapUrl: z.string(),
  // 駅中 ("inside") / 駅外 ("outside") / 未判定 ("unknown") — see the
  // classification rules at inferCafeLocationType.
  locationType: z.enum(["inside", "outside", "unknown"]),
  note: z.string(),
  // Real shop photo URL (official / map source) when one was verified;
  // null renders a brand tile instead — photos are never fabricated.
  photoUrl: z.string().nullable(),
  // Provenance of the cafe-database row: where it was verified and when,
  // so stale data (closures etc.) can be spotted in the UI.
  sourceLabel: z.string(),
  researchedAt: z.string().nullable(),
});

const articleOut = z.object({
  id: z.number(),
  title: z.string(),
  url: z.string(),
});

const legOut = z.object({
  line: z.string(),
  fromStation: z.string(),
  toStation: z.string(),
  stops: z.number(),
  minutes: z.number(),
  note: z.string(),
});

const routeOut = z.object({
  id: z.number(),
  destStation: z.string(),
  originStation: z.string(),
  // null = the route search could not confirm this value; the UI shows
  // it as unconfirmed instead of a made-up number.
  fareIcYen: z.number().nullable(),
  durationMin: z.number().nullable(),
  transfers: z.number(),
  sourceLabel: z.string(),
  sourceUrl: z.string().nullable(),
  legs: z.array(legOut),
  note: z.string(),
});

const slotOut = z.object({
  id: z.number(),
  kind: z.enum(["event", "home"]),
  eventTitle: z.string(),
  eventStart: z.string().nullable(),
  eventEnd: z.string().nullable(),
  allDay: z.boolean(),
  location: z.string(),
  area: z.string(),
  status: z.enum(["ready", "researching"]),
  candidates: z.array(candidateOut),
  cafes: z.array(cafeOut),
  articles: z.array(articleOut),
  sweets: z.array(candidateOut),
  // Adopted cheapest route from the configured home stations to this
  // slot's nearest station, or null when that station has no researched
  // route yet.
  route: routeOut.nullable(),
  // Cafe database status for this slot's station: the station key, and
  // when its cafes were researched (null = registered but not yet
  // researched, so the panel can say so honestly).
  cafeStation: z.string().nullable(),
  cafeResearchedAt: z.string().nullable(),
});

const legIn = z.object({
  line: z.string().min(1),
  fromStation: z.string().min(1),
  toStation: z.string().min(1),
  stops: z.number().int().min(0).max(60),
  minutes: z.number().int().min(0).max(600),
  note: z.string().default(""),
});

const routeIn = z.object({
  destStation: z.string().min(1),
  originStation: z.string().min(1),
  fareIcYen: z.number().int().min(0).max(100000).nullable().optional(),
  durationMin: z.number().int().min(0).max(1440).nullable().optional(),
  transfers: z.number().int().min(0).max(10).default(0),
  sourceLabel: z.string().default(""),
  sourceUrl: z.string().url().nullable().optional(),
  legs: z.array(legIn).max(6).default([]),
  note: z.string().default(""),
});

const candidateIn = z.object({
  name: z.string().min(1),
  genre: z.string().default(""),
  score: z.number().min(3.3).max(5),
  priceLabel: z.string().default(""),
  overBudget: z.boolean().default(false),
  tabelogUrl: z.string().url().nullable().optional(),
  // Map URL: the link destination of the map button (「大きな地図を
  // 見る」) on the shop's Tabelog page, copied verbatim by the research
  // agent (user instruction, 2026-11-16) — Tabelog's per-shop map page
  // (…/<restaurant-id>/dtlmap/). Null/omitted when it could not be
  // collected: the card then shows no 地図を見る link at all.
  mapUrl: z.string().url().nullable().optional(),
  // Real photo URL of this shop, copied verbatim by the research agent:
  // the shop's own photo on its Tabelog page first, then the same shop's
  // photo on its official site, else a real same-genre photo (user rule,
  // 2026-11-15). Optional only so older saves still parse — the refresh
  // brief requires it for every candidate.
  photoUrl: z.string().url().nullable().optional(),
  note: z.string().default(""),
  // Business hours / regular closing days copied from the shop's
  // Tabelog page; empty string when the page does not state them.
  hoursText: z.string().default(""),
  closedDays: z.string().default(""),
  category: z.enum(["meal", "sweets"]).default("meal"),
});

const cafeIn = z.object({
  name: z.string().min(1),
  chainName: z.string().default(""),
  address: z.string().default(""),
  // Map link is mandatory for cafes — a cafe without one is dropped.
  mapUrl: z.string().url(),
  note: z.string().default(""),
  // Real shop photo URL copied verbatim from an official / map page, or
  // omitted/null when none was verified (never invented).
  photoUrl: z.string().url().nullable().optional(),
  sourceLabel: z.string().default(""),
  sourceUrl: z.string().url().nullable().optional(),
  // 駅中/駅外 classification judged by the research agent from the
  // shop's official description (see STEP 5). Omit when it cannot be
  // judged — the server infers from name/address/note and otherwise
  // stores 未判定 (unknown), never a disguised 駅外.
  locationType: z.enum(["inside", "outside", "unknown"]).optional(),
});

// One cafe-database entry: a shop keyed by its station.
const stationCafeIn = cafeIn.extend({
  station: z.string().min(1),
});

const articleIn = z.object({
  title: z.string().min(1),
  url: z.string().url(),
});

const slotIn = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  eventKey: z.string().min(1),
  kind: z.enum(["event", "home"]),
  eventTitle: z.string().min(1),
  eventStart: z.string().nullable().optional(),
  eventEnd: z.string().nullable().optional(),
  allDay: z.boolean().default(false),
  location: z.string().default(""),
  area: z.string().default(""),
  // Meal target is 10+ per slot (plus up to 3 sweets) — the array cap
  // must not clip the 10-candidate target.
  candidates: z.array(candidateIn).max(24).default([]),
  // No small cap: cafes are researched brand by brand and ALL shops of a
  // brand near the station are saved (user rule, 2026-11-14).
  cafes: z.array(cafeIn).max(60).default([]),
  articles: z.array(articleIn).max(3).default([]),
});

const okResponse = z.object({ ok: z.literal(true) });

/* ---------------- Actions ---------------- */

export const Actions = {
  getSchedule: defineAction({
    description:
      "Returns the two-week lunch schedule: calendar-event slots (or Home fallback slots) with their Tabelog candidates, plus refresh status.",
    request: z.object({}),
    response: z.object({
      today: z.string(),
      lastRefreshedAt: z.string().nullable(),
      refreshStartedAt: z.string().nullable(),
      anyResearching: z.boolean(),
      settings: settingsSchema,
      // Cafe database coverage: every registered destination station and
      // whether its cafes have been researched (null = not yet; the
      // nightly refresh fills those first).
      cafeDbStations: z.array(
        z.object({
          station: z.string(),
          researchedAt: z.string().nullable(),
          cafeCount: z.number(),
        }),
      ),
      weeks: z.array(
        z.object({
          label: z.string(),
          days: z.array(
            z.object({
              date: z.string(),
              isToday: z.boolean(),
              slots: z.array(slotOut),
            }),
          ),
        }),
      ),
    }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const today = tokyoToday();
      const start = mondayOf(today);
      const coreEnd = addDays(start, 20); // Sunday of next week

      const slotRows = await db
        .select()
        .from(schema.slots)
        .orderBy(asc(schema.slots.date), asc(schema.slots.eventStart));
      const slotIds = slotRows.map((s) => s.id);
      const candRows = slotIds.length
        ? await db
            .select()
            .from(schema.candidates)
            .where(inArray(schema.candidates.slotId, slotIds))
            .orderBy(asc(schema.candidates.rank))
        : [];
      const bySlot = new Map<
        number,
        { meals: z.infer<typeof candidateOut>[]; sweets: z.infer<typeof candidateOut>[] }
      >();
      // Final read-side guarantees: a shop on the user's exclusion list
      // is never rendered, and neither is an over-budget meal candidate,
      // even if a stored row somehow survived the save/heal filters.
      const hiddenRows = await loadHidden(ctx);
      const feedbackRows = await loadFeedback(ctx);
      const readSettings = await getSettings(ctx);
      const slotById = new Map(slotRows.map((s) => [s.id, s]));
      for (const c of candRows) {
        if (matchesHidden(c, hiddenRows)) continue;
        // A shop the user rated <= 2.5 is never proposed again (until
        // the rating is deleted) — same read-side guarantee as hidden.
        if (isLowRated(c, feedbackRows)) continue;
        if (
          c.category === "meal" &&
          isOverBudgetCandidate(c, readSettings.budgetYen)
        ) {
          continue;
        }
        const entry = bySlot.get(c.slotId) ?? { meals: [], sweets: [] };
        const slot = slotById.get(c.slotId);
        const out = {
          id: c.id,
          name: c.name,
          genre: c.genre,
          score: c.score,
          priceLabel: c.priceLabel,
          overBudget: c.overBudget,
          tabelogUrl: normalizeTabelogUrl(c.tabelogUrl),
          mapUrl: normalizeTabelogUrl(c.mapUrl),
          photoUrl: c.photoUrl ?? null,
          note: c.note,
          hoursText: c.hoursText,
          closedDays: c.closedDays,
          hoursWarning: slot
            ? hoursWarningFor(
                { date: slot.date, eventStart: slot.eventStart, allDay: slot.allDay },
                c,
              )
            : "",
          userRating: feedbackFor(c, feedbackRows)?.rating ?? null,
          userMemo: feedbackFor(c, feedbackRows)?.memo || null,
        };
        if (c.category === "sweets") entry.sweets.push(out);
        else entry.meals.push(out);
        bySlot.set(c.slotId, entry);
      }
      const cafeRows = slotIds.length
        ? await db
            .select()
            .from(schema.cafes)
            .where(inArray(schema.cafes.slotId, slotIds))
            .orderBy(asc(schema.cafes.rank))
        : [];
      const cafesBySlot = new Map<number, z.infer<typeof cafeOut>[]>();
      for (const c of cafeRows) {
        const list = cafesBySlot.get(c.slotId) ?? [];
        list.push({
          id: c.id,
          name: c.name,
          chainName: canonicalChainName(c.chainName),
          address: c.address,
          mapUrl: c.mapUrl,
          locationType:
            c.locationType === "unknown"
              ? inferCafeLocationType(c)
              : c.locationType,
          note: c.note,
          photoUrl: null,
          sourceLabel: "",
          researchedAt: null,
        });
        cafesBySlot.set(c.slotId, list);
      }
      // Cafe database (station level): when a slot's station has database
      // rows, they REPLACE the per-slot cafes — one research per station,
      // reused by every slot heading there.
      const stationCafeRows = await db
        .select()
        .from(schema.stationCafes)
        .orderBy(asc(schema.stationCafes.rank));
      const cafesByStation = new Map<string, z.infer<typeof cafeOut>[]>();
      for (const c of stationCafeRows) {
        const list = cafesByStation.get(c.station) ?? [];
        list.push({
          id: c.id,
          name: c.name,
          chainName: canonicalChainName(c.chainName),
          address: c.address,
          mapUrl: c.mapUrl,
          locationType:
            c.locationType === "unknown"
              ? inferCafeLocationType(c)
              : c.locationType,
          note: c.note,
          photoUrl: c.photoUrl,
          sourceLabel: c.sourceLabel,
          researchedAt: c.researchedAt.toISOString(),
        });
        cafesByStation.set(c.station, list);
      }
      const cafeStationRows = await db.select().from(schema.cafeStations);
      const cafeResearchedByStation = new Map<string, string | null>();
      for (const r of cafeStationRows) {
        cafeResearchedByStation.set(
          r.station,
          r.researchedAt ? r.researchedAt.toISOString() : null,
        );
      }
      const cafesForSlot = (s: {
        id: number;
        kind: string;
        eventTitle: string;
        location: string;
        area: string;
      }): z.infer<typeof cafeOut>[] => {
        const station = stationForSlot(s);
        if (station) {
          const fromDb = cafesByStation.get(station);
          if (fromDb && fromDb.length) return fromDb;
        }
        return cafesBySlot.get(s.id) ?? [];
      };
      const articleRows = slotIds.length
        ? await db
            .select()
            .from(schema.tabelogArticles)
            .where(inArray(schema.tabelogArticles.slotId, slotIds))
            .orderBy(asc(schema.tabelogArticles.rank))
        : [];
      const articlesBySlot = new Map<number, z.infer<typeof articleOut>[]>();
      for (const a of articleRows) {
        const list = articlesBySlot.get(a.slotId) ?? [];
        list.push({ id: a.id, title: a.title, url: normalizeTabelogUrl(a.url) ?? a.url });
        articlesBySlot.set(a.slotId, list);
      }
      // Station routes are stored once per destination station and
      // attached to every slot heading to that station.
      const routeRows = await db.select().from(schema.stationRoutes);
      const routeByDest = new Map<string, z.infer<typeof routeOut>>();
      for (const r of routeRows) {
        routeByDest.set(r.destStation, {
          id: r.id,
          destStation: r.destStation,
          originStation: r.originStation,
          fareIcYen: r.fareIcYen,
          durationMin: r.durationMin,
          transfers: r.transfers,
          sourceLabel: r.sourceLabel,
          sourceUrl: r.sourceUrl,
          legs: parseLegs(r.legsJson),
          note: r.note,
        });
      }
      const routeFor = (s: {
        kind: string;
        eventTitle: string;
        location: string;
        area: string;
      }): z.infer<typeof routeOut> | null => {
        const dest = destStationForSlot(s);
        return dest ? (routeByDest.get(dest) ?? null) : null;
      };

      const byDate = new Map<string, z.infer<typeof slotOut>[]>();
      let anyResearching = false;
      for (const s of slotRows) {
        if (s.status === "researching") anyResearching = true;
        const list = byDate.get(s.date) ?? [];
        list.push({
          id: s.id,
          kind: s.kind,
          eventTitle: s.eventTitle,
          eventStart: s.eventStart,
          eventEnd: s.eventEnd,
          allDay: s.allDay,
          location: s.location,
          area: s.area,
          status: s.status,
          candidates: bySlot.get(s.id)?.meals ?? [],
          cafes: cafesForSlot(s),
          articles: articlesBySlot.get(s.id) ?? [],
          sweets: bySlot.get(s.id)?.sweets ?? [],
          route: routeFor(s),
          cafeStation: stationForSlot(s),
          cafeResearchedAt: (() => {
            const st = stationForSlot(s);
            return st ? (cafeResearchedByStation.get(st) ?? null) : null;
          })(),
        });
        byDate.set(s.date, list);
      }

      // Extend the window if stored slots reach beyond the core two weeks.
      let end = coreEnd;
      for (const s of slotRows) {
        if (s.date > end && s.date <= addDays(start, 41)) end = s.date;
      }
      // End on the Sunday of the week containing `end`.
      end = addDays(mondayOf(end), 6);

      type Day = { date: string; isToday: boolean; slots: z.infer<typeof slotOut>[] };
      const weeks: { label: string; days: Day[] }[] = [];
      const weekLabels = ["今週", "来週", "再来週", "3週先", "4週先", "5週先"];
      let cursor = start;
      let wi = 0;
      while (cursor <= end) {
        const days: Day[] = [];
        for (let i = 0; i < 7; i++) {
          const date = addDays(cursor, i);
          if (date < today) continue; // past days are not actionable lunch plans
          const slotsForDay = byDate.get(date) ?? [];
          if (date > coreEnd && slotsForDay.length === 0) continue;
          // Event-free day inside the core window: show the home-area
          // fallback slot as an honest researching placeholder until the
          // refresh agent saves the real one.
          if (slotsForDay.length === 0 && date <= coreEnd && date >= today) {
            anyResearching = true;
            days.push({
              date,
              isToday: date === today,
              slots: [
                {
                  id: -1,
                  kind: "home",
                  eventTitle: `${ADOPTER_CONFIG.homeStation}周辺ランチ`,
                  eventStart: null,
                  eventEnd: null,
                  allDay: true,
                  location: "",
                  area: ADOPTER_CONFIG.homeAreaLabel,
                  status: "researching",
                  candidates: [],
                  cafes: cafesByStation.get(ADOPTER_CONFIG.homeStation) ?? [],
                  articles: [],
                  sweets: [],
                  route: routeByDest.get(ADOPTER_CONFIG.homeStation) ?? null,
                  cafeStation: ADOPTER_CONFIG.homeStation,
                  cafeResearchedAt: cafeResearchedByStation.get(ADOPTER_CONFIG.homeStation) ?? null,
                },
              ],
            });
          } else {
            days.push({ date, isToday: date === today, slots: slotsForDay });
          }
        }
        weeks.push({ label: weekLabels[wi] ?? `${wi}週先`, days });
        cursor = addDays(cursor, 7);
        wi++;
      }

      return {
        today,
        lastRefreshedAt: await getMeta(ctx, "last_refreshed_at"),
        refreshStartedAt: await getMeta(ctx, "refresh_started_at"),
        anyResearching,
        settings: await getSettings(ctx),
        cafeDbStations: cafeStationRows
          .filter((r) => r.registered)
          .map((r) => ({
            station: r.station,
            researchedAt: r.researchedAt ? r.researchedAt.toISOString() : null,
            cafeCount: cafesByStation.get(r.station)?.length ?? 0,
          }))
          .sort((a, b) => a.station.localeCompare(b.station, "ja")),
        weeks,
      };
    },
  }),

  refreshSchedule: defineAction({
    description:
      "Starts a background refresh: re-reads the user's Google Calendar and re-researches Tabelog lunch candidates for this week and next week.",
    request: z.object({}),
    response: z.object({ started: z.boolean() }),
    async handler(ctx) {
      // Heal stored data on every refresh trigger (this is the path the
      // nightly cron executes): merge duplicate slots, normalize URLs.
      await healStoredData(ctx);
      const started = await startRefresh(ctx);
      ctx.invalidateQueries();
      return { started };
    },
  }),

  getSettings: defineAction({
    description:
      "Returns the food preference settings (preferred genres, lunch budget, souvenir-sweets preferences) used for candidate research, plus the selectable options.",
    request: z.object({}),
    response: z.object({
      settings: settingsSchema,
      genreOptions: z.array(z.string()),
      sweetOptions: z.array(z.string()),
    }),
    async handler(ctx) {
      return {
        settings: await getSettings(ctx),
        genreOptions: [...GENRE_OPTIONS],
        sweetOptions: [...SWEET_OPTIONS],
      };
    },
  }),

  updateSettings: defineAction({
    description:
      "Saves the food preference settings and starts a re-research so candidate selection follows the new preferences.",
    request: settingsSchema,
    response: z.object({ saved: z.literal(true), refreshStarted: z.boolean() }),
    async handler(ctx, args): Promise<{ saved: true; refreshStarted: boolean }> {
      await setMeta(ctx, "settings_v1", JSON.stringify(sanitizeSettings(args)));
      const refreshStarted = await startRefresh(ctx);
      ctx.invalidateQueries();
      return { saved: true, refreshStarted };
    },
  }),

  hideCandidate: defineAction({
    description:
      "Permanently excludes a shop the user hid with the small circled-! button at the bottom-left of a candidate card: records it in the exclusion list (Tabelog shop identity + name) and removes every stored candidate for that shop from all slots, so it is never proposed again.",
    request: z.object({ candidateId: z.number().int() }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.candidates)
        .where(eq(schema.candidates.id, args.candidateId));
      const target = rows[0];
      if (target) {
        await db
          .insert(schema.hiddenShops)
          .values({
            shopKey: shopKey(target.name, target.tabelogUrl),
            name: target.name,
            tabelogUrl: normalizeTabelogUrl(target.tabelogUrl),
          })
          .onConflictDoNothing({ target: schema.hiddenShops.shopKey });
        // Remove the same shop from every slot it currently appears in.
        const all = await db.select().from(schema.candidates);
        for (const c of all) {
          if (isSameShop(c, target)) {
            await db
              .delete(schema.candidates)
              .where(eq(schema.candidates.id, c.id));
          }
        }
      }
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  getHiddenShops: defineAction({
    description:
      "Returns the user's exclusion list: shops hidden via the circled-! button on a candidate card, which are never proposed again unless restored.",
    request: z.object({}),
    response: z.object({
      shops: z.array(
        z.object({
          id: z.number(),
          name: z.string(),
          tabelogUrl: z.string().nullable(),
          hiddenAt: z.string(),
        }),
      ),
    }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.hiddenShops)
        .orderBy(asc(schema.hiddenShops.createdAt));
      return {
        shops: rows.map((r) => ({
          id: r.id,
          name: r.name,
          tabelogUrl: r.tabelogUrl,
          hiddenAt: r.createdAt.toISOString(),
        })),
      };
    },
  }),

  unhideShop: defineAction({
    description:
      "Removes a shop from the exclusion list, so future refreshes may propose it again (it reappears only when a later research pass picks it).",
    request: z.object({ id: z.number().int() }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const db = ctx.db<typeof schema>();
      await db
        .delete(schema.hiddenShops)
        .where(eq(schema.hiddenShops.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  saveFeedback: defineAction({
    description:
      "Saves the user's own rating of a shop they visited (from the rating button next to the circled-! hide button on a candidate card): one row per shop keyed by its Tabelog URL, upserted so re-rating overwrites. rating is 0.0–5.0 in 0.1 steps; memo is the user's free-text impression; the candidate's genre and photo URL are stored with the rating for the settings history cards/search. Ratings feed the research loop: >= 4.0 prioritizes the shop, <= 2.5 excludes it from future candidates until the rating is deleted.",
    request: z.object({
      tabelogUrl: z.string().url(),
      name: z.string().min(1).max(200),
      rating: z.number().min(0).max(5),
      memo: z.string().max(2000).default(""),
      area: z.string().max(200).default(""),
      // The candidate's genre + real photo URL, saved together with the
      // rating (user instruction, 2026-11-16) so the settings history
      // can render photo cards and be searched by genre. Optional: a
      // caller without candidate data leaves the stored values intact.
      genre: z.string().max(100).default(""),
      photoUrl: z.string().url().nullable().optional(),
    }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const db = ctx.db<typeof schema>();
      const url = normalizeTabelogUrl(args.tabelogUrl) ?? args.tabelogUrl;
      // The slider moves in 0.1 steps; snap defensively so stored
      // values always carry exactly one decimal.
      const rating = Math.round(args.rating * 10) / 10;
      const now = new Date();
      const photoUrl =
        args.photoUrl && /^https:\/\//i.test(args.photoUrl) ? args.photoUrl : null;
      await db
        .insert(schema.shopFeedback)
        .values({
          shopName: args.name,
          tabelogUrl: url,
          rating,
          memo: args.memo,
          area: args.area,
          genre: args.genre,
          photoUrl,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: schema.shopFeedback.tabelogUrl,
          set: {
            shopName: args.name,
            rating,
            memo: args.memo,
            area: args.area,
            // Only overwrite genre/photo when the caller actually has
            // them, so a re-rate never wipes previously stored values.
            ...(args.genre ? { genre: args.genre } : {}),
            ...(photoUrl ? { photoUrl } : {}),
            updatedAt: now,
          },
        });
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  deleteFeedback: defineAction({
    description:
      "Deletes the user's own rating of a shop (by Tabelog URL). Deleting a <= 2.5 rating lifts that shop's exclusion from future candidates; deleting any rating removes its ★ display from the card and its entry from the settings history.",
    request: z.object({ tabelogUrl: z.string().min(1) }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const db = ctx.db<typeof schema>();
      const url = normalizeTabelogUrl(args.tabelogUrl) ?? args.tabelogUrl;
      await db
        .delete(schema.shopFeedback)
        .where(eq(schema.shopFeedback.tabelogUrl, url));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  getFeedback: defineAction({
    description:
      "Returns the user's rating history (shops they visited and rated, with rating, memo, area, genre, photo and rating date), newest first — shown in the settings sheet's 履歴 tab as searchable photo cards and exported to CSV (過去履歴.csv) by the client. Rows rated before genre/photo were stored are backfilled from the candidates table when a matching candidate is still stored (same shop identity), and the backfill is persisted.",
    request: z.object({}),
    response: z.object({
      entries: z.array(
        z.object({
          id: z.number(),
          name: z.string(),
          tabelogUrl: z.string(),
          rating: z.number(),
          memo: z.string(),
          area: z.string(),
          genre: z.string(),
          photoUrl: z.string().nullable(),
          ratedAt: z.string(),
        }),
      ),
    }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.shopFeedback)
        .orderBy(asc(schema.shopFeedback.updatedAt));
      // Backfill genre/photo for rows rated before those columns were
      // stored, from a still-stored candidate of the same shop.
      const needsFill = rows.filter((r) => !r.genre || !r.photoUrl);
      let candidateRows: (typeof schema.candidates.$inferSelect)[] = [];
      if (needsFill.length) {
        candidateRows = await db.select().from(schema.candidates);
      }
      const entries = [];
      for (const r of rows) {
        let genre = r.genre;
        let photoUrl = r.photoUrl;
        if (!genre || !photoUrl) {
          const match = candidateRows.find((c) =>
            isSameShop(
              { name: r.shopName, tabelogUrl: r.tabelogUrl },
              { name: c.name, tabelogUrl: c.tabelogUrl },
            ),
          );
          if (match) {
            if (!genre && match.genre) genre = match.genre;
            if (!photoUrl && match.photoUrl) photoUrl = match.photoUrl;
            if (genre !== r.genre || photoUrl !== r.photoUrl) {
              await db
                .update(schema.shopFeedback)
                .set({ genre, photoUrl })
                .where(eq(schema.shopFeedback.id, r.id));
            }
          }
        }
        entries.push({
          id: r.id,
          name: r.shopName,
          tabelogUrl: r.tabelogUrl,
          rating: r.rating,
          memo: r.memo,
          area: r.area,
          genre,
          photoUrl,
          ratedAt: r.updatedAt.toISOString(),
        });
      }
      return { entries: entries.reverse() };
    },
  }),

  saveCandidates: defineAction({
    description:
      "Saves researched calendar slots and their Tabelog-verified candidates (score >= 3.3 only): 10+ meal candidates per slot (cap 15), up to 3 Tabelog articles, and up to 3 souvenir-sweets candidates per slot. Meal candidates over the settings budget are hard-dropped on save (never stored with a flag), and every candidate carries hoursText/closedDays copied from its Tabelog page (empty when unconfirmed), a photoUrl (the shop's own real photo from its Tabelog page, or the documented fallbacks), and a mapUrl (the link destination of the map button — 「大きな地図を見る」 — on the shop's Tabelog page, i.e. its dtlmap page, copied verbatim; null when not collected, and the card then shows no 地図を見る link rather than a substitute). Cafe chain names are canonicalized on save (タリーズコーヒー → タリーズ) so per-brand groupings never split. Cafes go into the station-level cafe database via the top-level stationCafes array (one entry per shop, keyed by station; map link required, EVERY shop carrying its 駅中/駅外 classification (locationType: inside/outside, unknown only when unjudgeable), ALL shops per brand — station-interior shops are classified 駅中, never excluded) and are reused by every later slot for that station; per-slot cafes arrays are still accepted and mirrored into the same database. Also saves station-level train routes (from the configured home stations, route-search-verified fares only) in the top-level routes array, upserted per destination station. Called by the refresh agent.",
    request: z.object({
      slots: z.array(slotIn).max(60),
      routes: z.array(routeIn).max(20).default([]),
      stationCafes: z.array(stationCafeIn).max(300).default([]),
    }),
    response: z.object({ saved: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      // Cafe database: upsert the researched stations' shops, grouped by
      // station. This is how new destinations (and the pre-registered
      // stations) enter the database exactly once.
      {
        const byStation = new Map<string, StationCafeInput[]>();
        for (const c of args.stationCafes) {
          const list = byStation.get(c.station) ?? [];
          list.push({
            name: c.name,
            chainName: canonicalChainName(c.chainName),
            address: c.address,
            mapUrl: c.mapUrl,
            photoUrl: c.photoUrl ?? null,
            sourceLabel: c.sourceLabel,
            sourceUrl: c.sourceUrl ?? null,
            note: c.note,
            locationType: c.locationType,
          });
          byStation.set(c.station, list);
        }
        for (const [station, list] of byStation) {
          await upsertStationCafes(
            ctx,
            station,
            list,
            `駅周辺カフェ調査（${new Date().toISOString().slice(0, 10)}）`,
          );
        }
      }
      // Station routes: upsert per destination station. Only values the
      // research actually confirmed are stored — a null fare/time stays
      // null and renders as unconfirmed, never as an invented number.
      for (const r of args.routes) {
        const values = {
          destStation: r.destStation,
          originStation: r.originStation,
          fareIcYen: r.fareIcYen ?? null,
          durationMin: r.durationMin ?? null,
          transfers: r.transfers,
          sourceLabel: r.sourceLabel,
          sourceUrl: r.sourceUrl ?? null,
          legsJson: JSON.stringify(r.legs),
          note: r.note,
          updatedAt: new Date(),
        };
        await db
          .insert(schema.stationRoutes)
          .values(values)
          .onConflictDoUpdate({
            target: schema.stationRoutes.destStation,
            set: values,
          });
      }
      const hiddenRows = await loadHidden(ctx);
      const feedbackRows = await loadFeedback(ctx);
      const today = tokyoToday();
      const windowStart = mondayOf(today);
      // Prune slots from past weeks so the view stays current.
      const stale = await db
        .select({ id: schema.slots.id })
        .from(schema.slots)
        .where(lt(schema.slots.date, windowStart));
      if (stale.length) {
        const ids = stale.map((s) => s.id);
        await db.delete(schema.candidates).where(inArray(schema.candidates.slotId, ids));
        await db.delete(schema.cafes).where(inArray(schema.cafes.slotId, ids));
        await db.delete(schema.tabelogArticles).where(inArray(schema.tabelogArticles.slotId, ids));
        await db.delete(schema.slots).where(inArray(schema.slots.id, ids));
      }

      let saved = 0;
      for (const slot of args.slots) {
        let existing = await db
          .select()
          .from(schema.slots)
          .where(eq(schema.slots.eventKey, slot.eventKey));
        // Identity backstop: if the same date already holds a slot for the
        // same event under a different key (seed key vs calendar id, or a
        // re-typed title), save INTO that slot instead of creating a
        // duplicate, and adopt the incoming eventKey for future saves.
        if (!existing[0]) {
          const sameDate = await db
            .select()
            .from(schema.slots)
            .where(eq(schema.slots.date, slot.date));
          const match = sameDate.find((s) =>
            isSameEventSlot(s, {
              date: slot.date,
              kind: slot.kind,
              eventTitle: slot.eventTitle,
              eventStart: slot.eventStart ?? null,
            }),
          );
          if (match) existing = [match];
        }
        let slotId: number;
        const values = {
          date: slot.date,
          kind: slot.kind,
          eventKey: slot.eventKey,
          eventTitle: slot.eventTitle,
          eventStart: slot.eventStart ?? null,
          eventEnd: slot.eventEnd ?? null,
          allDay: slot.allDay,
          location: slot.location,
          area: slot.area,
          status: "ready" as const,
          updatedAt: new Date(),
        };
        if (existing[0]) {
          slotId = existing[0].id;
          await db
            .update(schema.slots)
            .set(values)
            .where(eq(schema.slots.id, slotId));
          await db.delete(schema.candidates).where(eq(schema.candidates.slotId, slotId));
          await db.delete(schema.cafes).where(eq(schema.cafes.slotId, slotId));
          await db.delete(schema.tabelogArticles).where(eq(schema.tabelogArticles.slotId, slotId));
        } else {
          const inserted = await db
            .insert(schema.slots)
            .values({ ...values })
            .returning({ id: schema.slots.id });
          if (!inserted[0]) continue;
          slotId = inserted[0].id;
        }
        // Preserve the agent's array order as the display rank: the
        // research brief orders nearest-station-district picks first
        // (score descending within each group), adjacent-district
        // fallbacks last — a blind score re-sort would undo that.
        // Exclusion list first: a shop the user hid is never stored
        // again, in any slot. HARD BUDGET RULE next: an over-budget meal
        // candidate is dropped here, never stored with a flag (sweets
        // are dropped only when flagged overBudget). (The Home
        // weekly no-repeat rule is enforced by healStoredData at the
        // end of this save.)
        const saveSettings = await getSettings(ctx);
        const visible = slot.candidates.filter(
          (c) =>
            !matchesHidden({ name: c.name, tabelogUrl: c.tabelogUrl ?? null }, hiddenRows) &&
            // A shop the user rated <= 2.5 is never stored again while
            // that rating stands (feedback loop, 2026-11-16).
            !isLowRated({ name: c.name, tabelogUrl: c.tabelogUrl ?? null }, feedbackRows),
        );
        const meals = visible
          .filter(
            (c) =>
              c.category === "meal" &&
              c.score >= 3.3 &&
              !isOverBudgetCandidate(c, saveSettings.budgetYen),
          )
          .slice(0, 15);
        const sweets = visible
          .filter((c) => c.category === "sweets" && c.score >= 3.3 && !c.overBudget)
          .slice(0, 3);
        const cands = [...meals, ...sweets];
        if (cands.length) {
          const stmts: BatchItem<"sqlite">[] = cands.map((c, i) =>
            db.insert(schema.candidates).values({
              slotId,
              category: c.category,
              name: c.name,
              genre: c.genre,
              score: c.score,
              priceLabel: c.priceLabel,
              overBudget: false,
              tabelogUrl: normalizeTabelogUrl(c.tabelogUrl ?? null),
              mapUrl: normalizeTabelogUrl(c.mapUrl ?? null),
              photoUrl: c.photoUrl ?? null,
              note: c.note,
              hoursText: c.hoursText,
              closedDays: c.closedDays,
              rank: i,
            }),
          );
          const [first, ...rest] = stmts;
          if (first) await db.batch([first, ...rest]);
        }
        // Cafes: only rows with a real map link are stored (schema requires
        // mapUrl). No count cap — every shop of every brand near the
        // station is kept (user rule, 2026-11-14) — and BOTH 駅中
        // (station-interior) and 駅外 shops are kept, each with its
        // classification resolved (rule change, 2026-11-15). Rows are
        // stored grouped by brand (first-appearance order, independent
        // shops last) so the UI's per-brand pulldowns read in order.
        const cafeFiltered = slot.cafes
          .filter((c) => c.mapUrl.startsWith("http"))
          .map((c) => ({
            ...c,
            chainName: canonicalChainName(c.chainName),
            locationType: resolveCafeLocationType(c),
          }));
        const brandOrder: string[] = [];
        for (const c of cafeFiltered) {
          if (!brandOrder.includes(c.chainName)) brandOrder.push(c.chainName);
        }
        brandOrder.sort((a, b) => (a === "" ? 1 : 0) - (b === "" ? 1 : 0));
        const cafeRows = cafeFiltered
          .map((c, i) => ({ c, i }))
          .sort(
            (x, y) =>
              brandOrder.indexOf(x.c.chainName) - brandOrder.indexOf(y.c.chainName) ||
              x.i - y.i,
          )
          .map((x) => x.c);
        if (cafeRows.length) {
          const stmts: BatchItem<"sqlite">[] = cafeRows.map((c, i) =>
            db.insert(schema.cafes).values({
              slotId,
              name: c.name,
              chainName: c.chainName,
              address: c.address,
              mapUrl: c.mapUrl,
              locationType: c.locationType,
              note: c.note,
              rank: i,
            }),
          );
          const [first, ...rest] = stmts;
          if (first) await db.batch([first, ...rest]);
          // Mirror into the station cafe database so this station is
          // never researched again — future slots reuse these rows.
          const slotStation = stationForSlot(slot);
          if (slotStation) {
            await upsertStationCafes(
              ctx,
              slotStation,
              cafeRows.map((c) => ({
                name: c.name,
                chainName: c.chainName,
                address: c.address,
                mapUrl: c.mapUrl,
                photoUrl: c.photoUrl ?? null,
                sourceLabel: c.sourceLabel,
                sourceUrl: c.sourceUrl ?? null,
                note: c.note,
                locationType: c.locationType,
              })),
              `駅周辺カフェ調査（${new Date().toISOString().slice(0, 10)}）`,
            );
          }
        }
        // Tabelog articles: only tabelog.com URLs are kept, normalized to
        // the Japanese form.
        const articleRows = slot.articles
          .filter((a) => a.url.includes("tabelog.com"))
          .slice(0, 3);
        if (articleRows.length) {
          const stmts: BatchItem<"sqlite">[] = articleRows.map((a, i) =>
            db.insert(schema.tabelogArticles).values({
              slotId,
              title: a.title,
              url: normalizeTabelogUrl(a.url) ?? a.url,
              rank: i,
            }),
          );
          const [first, ...rest] = stmts;
          if (first) await db.batch([first, ...rest]);
        }
        saved++;
      }
      // Self-heal: merge any duplicate slots this (or an earlier) pass left
      // behind and normalize stored URLs, so duplicates never accumulate.
      await healStoredData(ctx);
      await setMeta(ctx, "last_refreshed_at", new Date().toISOString());
      ctx.invalidateQueries();
      return { saved };
    },
  }),

  bootstrap: defineAction({
    description:
      "First-load bootstrap: heals stored data, seeds any adopter-provided seed slots once, then starts a calendar+Tabelog refresh.",
    request: z.object({}),
    response: z.object({ seeded: z.number(), refreshStarted: z.boolean() }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      let seeded = 0;

      // Ungated, idempotent healing (duplicate-slot merge, Tabelog URL
      // normalization) — runs on every bootstrap, and
      // the same pass also runs from refreshSchedule / saveCandidates,
      // the paths production traffic actually takes.
      await healStoredData(ctx);

      const already = await getMeta(ctx, "seeded_v2");
      if (!already) {
        for (const slot of SEED) {
          const byKey = await db
            .select()
            .from(schema.slots)
            .where(eq(schema.slots.eventKey, slot.eventKey));
          if (byKey[0]) continue;
          // Never re-seed an event that already has a slot under another key.
          const sameDate = await db
            .select()
            .from(schema.slots)
            .where(eq(schema.slots.date, slot.date));
          if (
            sameDate.some((s) =>
              isSameEventSlot(s, {
                date: slot.date,
                kind: "event",
                eventTitle: slot.eventTitle,
                eventStart: slot.eventStart,
              }),
            )
          ) {
            continue;
          }
          const seedSettings = await getSettings(ctx);
          const cands = [...slot.candidates]
            .filter(
              (c) =>
                c.score >= 3.3 &&
                !isOverBudgetCandidate(
                  { priceLabel: c.priceLabel, overBudget: c.overBudget ?? false },
                  seedSettings.budgetYen,
                ),
            )
            .sort((a, b) => b.score - a.score)
            .slice(0, 15);
          const inserted = await db
            .insert(schema.slots)
            .values({
              date: slot.date,
              eventKey: slot.eventKey,
              kind: "event",
              eventTitle: slot.eventTitle,
              eventStart: slot.eventStart,
              eventEnd: slot.eventEnd,
              allDay: slot.allDay,
              location: slot.location,
              area: slot.area,
              status: cands.length > 0 ? "ready" : "researching",
            })
            .returning({ id: schema.slots.id });
          if (!inserted[0]) continue;
          const slotId = inserted[0].id;
          const stmts: BatchItem<"sqlite">[] = cands.map((c, i) =>
            db.insert(schema.candidates).values({
              slotId,
              name: c.name,
              genre: c.genre,
              score: c.score,
              priceLabel: c.priceLabel,
              overBudget: c.overBudget ?? false,
              tabelogUrl: c.tabelogUrl ?? null,
              note: c.note ?? "",
              rank: i,
            }),
          );
          const [first, ...rest] = stmts;
          if (first) await db.batch([first, ...rest]);
          seeded++;
        }
        await setMeta(ctx, "seeded_v2", new Date().toISOString());
        if (seeded > 0) await setMeta(ctx, "last_refreshed_at", new Date().toISOString());
      }
      const refreshStarted = await startRefresh(ctx);
      ctx.invalidateQueries();
      return { seeded, refreshStarted };
    },
  }),

  buildCalendarLinks: defineAction({
    description:
      "Builds a Google Calendar add link and an .ics file body for booking one candidate (lunch, cafe stop, or souvenir-sweets stop) at a chosen date/time.",
    request: z.object({
      name: z.string().min(1),
      area: z.string().default(""),
      tabelogUrl: z.string().nullable().optional(),
      mapUrl: z.string().nullable().optional(),
      purpose: z.enum(["lunch", "cafe", "souvenir"]).default("lunch"),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      startTime: z.string().regex(/^\d{2}:\d{2}$/),
      endTime: z.string().regex(/^\d{2}:\d{2}$/),
    }),
    response: z.object({ googleUrl: z.string(), ics: z.string(), summary: z.string() }),
    async handler(_ctx, args) {
      const summary = `${args.purpose === "souvenir" ? "お土産" : args.purpose === "cafe" ? "カフェ" : "ランチ"}：${args.name}`;
      const compact = (d: string, t: string) => `${d.replaceAll("-", "")}T${t.replace(":", "")}00`;
      const dates = `${compact(args.date, args.startTime)}/${compact(args.date, args.endTime)}`;
      const details = [
        args.area ? `エリア：${args.area}` : "",
        args.tabelogUrl ? `食べログ：${args.tabelogUrl}` : "",
        args.mapUrl ? `地図：${args.mapUrl}` : "",
      ]
        .filter(Boolean)
        .join("\n");
      const params = new URLSearchParams({
        action: "TEMPLATE",
        text: summary,
        dates,
        ctz: "Asia/Tokyo",
      });
      if (details) params.set("details", details);
      if (args.area) params.set("location", args.area);
      const googleUrl = `https://calendar.google.com/calendar/render?${params.toString()}`;

      const esc = (s: string) =>
        s.replaceAll("\\", "\\\\").replaceAll(";", "\\;").replaceAll(",", "\\,").replaceAll("\n", "\\n");
      const stamp = new Date()
        .toISOString()
        .replaceAll("-", "")
        .replaceAll(":", "")
        .replace(/\.\d{3}/, "");
      const ics = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Muse//Yotei Gourmet//JP",
        "BEGIN:VTIMEZONE",
        "TZID:Asia/Tokyo",
        "BEGIN:STANDARD",
        "DTSTART:19700101T000000",
        "TZOFFSETFROM:+0900",
        "TZOFFSETTO:+0900",
        "TZNAME:JST",
        "END:STANDARD",
        "END:VTIMEZONE",
        "BEGIN:VEVENT",
        `UID:${Date.now()}-${Math.random().toString(36).slice(2)}@muse`,
        `DTSTAMP:${stamp}`,
        `DTSTART;TZID=Asia/Tokyo:${compact(args.date, args.startTime)}`,
        `DTEND;TZID=Asia/Tokyo:${compact(args.date, args.endTime)}`,
        `SUMMARY:${esc(summary)}`,
        args.area ? `LOCATION:${esc(args.area)}` : "",
        details ? `DESCRIPTION:${esc(details)}` : "",
        "END:VEVENT",
        "END:VCALENDAR",
      ]
        .filter(Boolean)
        .join("\r\n");
      return { googleUrl, ics, summary };
    },
  }),
} satisfies ActionsModule;
