// Live test: pulls real records from a real RESO Web API feed into a throwaway local
// Postgres (PGlite) using the real migration and sync code. Nothing is written anywhere else.
//
// Default: Bridge Interactive's public demo dataset ("test"). Override for a real MLS:
//   MLS_BASE_URL=https://api-trestle.corelogic.com/trestle/odata MLS_TOKEN=... npm run live-test
//
// Usage: npm run live-test            (stops after MAX_RECORDS, default 400)
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { syncFeed, type Feed, type Store, type ListingRow } from "../supabase/functions/sync-mls/sync.ts";

const BASE_URL = process.env.MLS_BASE_URL ?? "https://api.bridgedataoutput.com/api/v2/OData/test";
// Bridge's publicly documented demo token for its "test" dataset (not a secret).
const TOKEN = process.env.MLS_TOKEN ?? "6baca547742c6f96a6ff71b138424f21";
const MAX_RECORDS = Number(process.env.MAX_RECORDS ?? 400);
const BACKFILL_FROM = process.env.BACKFILL_FROM ?? "2000-01-01T00:00:00Z";

const db = new PGlite();
await db.exec(`create role authenticated; create table public.anywhere_agents (id uuid primary key, mls_numbers text[]);`);
await db.exec(readFileSync(new URL("../supabase/migrations/20261107000000_mls_listings.sql", import.meta.url), "utf8"));
await db.query(
  `insert into mls_feeds (id, display_name, platform, base_url, auth_type, page_size, backfill_from, is_enabled)
   values ('LIVE_TEST', 'Live test feed', 'other', $1, 'bearer', 100, $2, true)`,
  [BASE_URL, BACKFILL_FROM],
);

let saved = 0;
const store: Store = {
  async upsertListings(rows: ListingRow[]) {
    for (const row of rows) {
      const cols = Object.keys(row);
      const vals = cols.map((c) => (c === "raw" ? JSON.stringify((row as any)[c]) : (row as any)[c]));
      const updates = cols.filter((c) => c !== "feed_id" && c !== "listing_key").map((c) => `${c} = excluded.${c}`);
      await db.query(
        `insert into mls_listings (${cols.join(",")}) values (${cols.map((_, i) => `$${i + 1}`).join(",")})
         on conflict (feed_id, listing_key) do update set ${updates.join(",")}`,
        vals,
      );
    }
    saved += rows.length;
    process.stdout.write(`\rsaved ${saved} records...`);
  },
  async saveWatermark(feedId: string, ts: string) {
    await db.query(`update mls_feeds set last_modification_ts = $1 where id = $2`, [ts, feedId]);
  },
};

// Stop once MAX_RECORDS are saved by wrapping fetch and dropping nextLink.
const limitedFetch: typeof fetch = async (input, init) => {
  const res = await fetch(input, init);
  if (!res.ok || saved + 100 < MAX_RECORDS) return res;
  const json = await res.json();
  delete json["@odata.nextLink"];
  return new Response(JSON.stringify(json), { status: 200, headers: { "Content-Type": "application/json" } });
};

const { rows } = await db.query<any>(`select * from mls_feeds where id = 'LIVE_TEST'`);
const feed: Feed = { ...rows[0], backfill_from: new Date(rows[0].backfill_from).toISOString(), last_modification_ts: null };

console.log(`Feed: ${BASE_URL}`);
const started = Date.now();
const result = await syncFeed(feed, TOKEN, store, Date.now() + 120_000, limitedFetch);
console.log(`\nDone in ${((Date.now() - started) / 1000).toFixed(1)}s: ${result.count} records\n`);

const q = async (sql: string) => (await db.query<any>(sql)).rows;
console.log("Field coverage (non-empty / total):");
console.table(await q(`
  select count(*) as total,
         count(list_agent_full_name) as list_agent_name,
         count(list_agent_email) as list_agent_email,
         count(list_agent_phone) as list_agent_phone,
         count(list_office_name) as list_office,
         count(days_on_market) as dom_from_mls,
         count(close_price) as close_price,
         count(buyer_agent_full_name) as buyer_agent
  from mls_listings`));
console.log("By status:");
console.table(await q(`select standard_status, count(*)::int as n from mls_listings group by 1 order by 2 desc`));
console.log("Sample closed sales:");
console.table(await q(`
  select listing_id, city, list_price::float, close_price::float, dom_effective, list_agent_full_name, buyer_agent_full_name
  from mls_listings_v where close_price is not null order by close_date desc nulls last limit 5`));
