// End-to-end test: real Postgres (PGlite) with the real migration, a mock RESO Web API
// server with paging, and the real sync loop. No MLS credentials or network needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { syncFeed, type Feed, type Store, type ListingRow } from "../supabase/functions/sync-mls/sync.ts";

// ---------- mock RESO server ----------
type Rec = Record<string, unknown>;
let records: Rec[] = [];
let failNextRequest = false;
let requests = 0;

const server = http.createServer((req, res) => {
  requests++;
  // The sync must only ever read from the MLS.
  assert.equal(req.method, "GET", `sync sent a ${req.method} request to the MLS`);
  const url = new URL(req.url!, "http://localhost");
  if (req.headers.authorization !== "Bearer test-token") {
    res.writeHead(401).end("unauthorized");
    return;
  }
  if (failNextRequest) {
    failNextRequest = false;
    res.writeHead(503, { "Retry-After": "0" }).end("try again");
    return;
  }
  const filter = url.searchParams.get("$filter") ?? "";
  const m = filter.match(/^ModificationTimestamp ge (\S+)$/);
  assert.ok(m, `unexpected filter: ${filter}`);
  const since = new Date(m[1]).getTime();
  const top = Number(url.searchParams.get("$top"));
  const skip = Number(url.searchParams.get("$skip") ?? 0);
  const matching = records
    .filter((r) => new Date(r.ModificationTimestamp as string).getTime() >= since)
    .sort((a, b) => String(a.ModificationTimestamp).localeCompare(String(b.ModificationTimestamp)));
  const page = matching.slice(skip, skip + top);
  const body: Rec = { value: page };
  if (skip + top < matching.length) {
    url.searchParams.set("$skip", String(skip + top));
    body["@odata.nextLink"] = `http://localhost:${port}${url.pathname}?${url.searchParams.toString()}`;
  }
  res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(body));
});
await new Promise<void>((r) => server.listen(0, r));
const port = (server.address() as { port: number }).port;

const rec = (n: number, ts: string, extra: Rec = {}): Rec => ({
  ListingKey: `K${n}`,
  ListingId: `MLS${n}`,
  StandardStatus: "Active",
  City: "Park City",
  StateOrProvince: "UT",
  ListPrice: 1_000_000 + n,
  OnMarketDate: "2026-01-01",
  ListAgentMlsId: `AG${n}`,
  ListAgentFullName: `Agent ${n}`,
  ListOfficeName: "Other Brokerage",
  ModificationTimestamp: ts,
  Media: [{ MediaURL: "https://example.com/x.jpg" }],
  ...extra,
});

// ---------- real Postgres with the real migration ----------
const db = new PGlite();
await db.exec(`
  create role authenticated; create role anon;
  create table public.anywhere_agents (id uuid primary key, mls_numbers text[]);
  insert into public.anywhere_agents values ('00000000-0000-0000-0000-000000000001', array['AG3']);
`);
await db.exec(readFileSync(new URL("../supabase/migrations/20261107000000_mls_listings.sql", import.meta.url), "utf8"));
await db.exec(`update mls_feeds set base_url = 'http://localhost:${port}/odata', page_size = 2, store_raw = true, is_enabled = true where id = 'PCBAOR'`);

const store: Store = {
  async upsertListings(rows: ListingRow[]) {
    for (const row of rows) {
      const cols = Object.keys(row);
      const vals = cols.map((c) => (c === "raw" ? JSON.stringify((row as Rec)[c]) : (row as Rec)[c]));
      const updates = cols.filter((c) => c !== "feed_id" && c !== "listing_key").map((c) => `${c} = excluded.${c}`);
      await db.query(
        `insert into mls_listings (${cols.join(",")}) values (${cols.map((_, i) => `$${i + 1}`).join(",")})
         on conflict (feed_id, listing_key) do update set ${updates.join(",")}`,
        vals,
      );
    }
  },
  async saveWatermark(feedId: string, ts: string) {
    await db.query(`update mls_feeds set last_modification_ts = $1 where id = $2`, [ts, feedId]);
  },
};

async function loadFeed(): Promise<Feed> {
  const { rows } = await db.query<Feed>(`select * from mls_feeds where id = 'PCBAOR'`);
  const f = rows[0] as Rec;
  return {
    ...(f as Feed),
    backfill_from: new Date(f.backfill_from as string).toISOString(),
    last_modification_ts: f.last_modification_ts ? new Date(f.last_modification_ts as string).toISOString() : null,
  };
}
const run = async () => syncFeed(await loadFeed(), "test-token", store, Date.now() + 30_000);
const count = async (sql: string) => Number(((await db.query<{ n: number }>(sql)).rows[0] as Rec).n);

test("migration seeds all 17 MLS feeds", async () => {
  assert.equal(await count(`select count(*)::int as n from mls_feeds`), 17);
});

test("initial backfill pages through every record and sets the watermark", async () => {
  records = [1, 2, 3, 4, 5].map((n) => rec(n, `2026-10-0${n}T12:00:00Z`));
  failNextRequest = true; // first request gets a 503; the job should retry
  const r = await run();
  assert.equal(r.count, 5);
  assert.equal(r.complete, true);
  assert.equal(await count(`select count(*)::int as n from mls_listings`), 5);
  const feed = await loadFeed();
  assert.equal(feed.last_modification_ts, "2026-10-05T12:00:00.000Z");
  const raw = (await db.query<Rec>(`select raw from mls_listings where listing_key = 'K1'`)).rows[0].raw as Rec;
  assert.equal(raw.Media, undefined, "photos are stripped from raw");
});

test("re-running with no changes creates no duplicates", async () => {
  await run();
  assert.equal(await count(`select count(*)::int as n from mls_listings`), 5);
});

test("a listing that closes is updated in place with agent, DOM and close price", async () => {
  records[2] = rec(3, "2026-11-01T09:00:00Z", {
    StandardStatus: "Closed",
    ClosePrice: 980000,
    PurchaseContractDate: "2026-01-21",
    CloseDate: "2026-02-15",
    BuyerAgentMlsId: "BUY9",
    BuyerAgentFullName: "Buyer Agent",
  });
  const r = await run();
  assert.ok(r.count >= 1);
  assert.equal(await count(`select count(*)::int as n from mls_listings`), 5);
  const row = (await db.query<Rec>(
    `select standard_status, close_price::float as close_price, buyer_agent_full_name, dom_effective, involves_our_agent
     from mls_listings_v where listing_key = 'K3'`,
  )).rows[0];
  assert.equal(row.standard_status, "Closed");
  assert.equal(row.close_price, 980000);
  assert.equal(row.buyer_agent_full_name, "Buyer Agent");
  assert.equal(row.dom_effective, 20, "Jan 1 on market -> Jan 21 under contract");
  assert.equal(row.involves_our_agent, true, "AG3 is in anywhere_agents.mls_numbers");
  const other = (await db.query<Rec>(`select involves_our_agent from mls_listings_v where listing_key = 'K1'`)).rows[0];
  assert.equal(other.involves_our_agent, false);
});

test("only mls_* objects are created; no existing table is touched", async () => {
  const { rows } = await db.query<Rec>(
    `select table_name from information_schema.tables where table_schema = 'public' order by 1`,
  );
  assert.deepEqual(rows.map((r) => r.table_name), ["anywhere_agents", "mls_feeds", "mls_listings", "mls_listings_v"]);
  const agents = await count(`select count(*)::int as n from anywhere_agents`);
  assert.equal(agents, 1, "existing client table is unchanged");
});

test("a bad token surfaces a clear error", async () => {
  await assert.rejects(
    syncFeed(await loadFeed(), "wrong", store, Date.now() + 5_000),
    /Feed request failed: 401/,
  );
  server.close();
});

test("migration also applies on a fresh project without anywhere_agents", async () => {
  const fresh = new PGlite();
  await fresh.exec(`create role authenticated; create role anon;`);
  await fresh.exec(readFileSync(new URL("../supabase/migrations/20261107000000_mls_listings.sql", import.meta.url), "utf8"));
  const { rows } = await fresh.query<Rec>(`select count(*)::int as n from mls_listings_v`);
  assert.equal(rows[0].n, 0);
});

test("each run stops cleanly at max_records_per_run and the next run resumes", async () => {
  const fresh = new PGlite();
  await fresh.exec(`create role authenticated; create role anon;`);
  await fresh.exec(readFileSync(new URL("../supabase/migrations/20261107000000_mls_listings.sql", import.meta.url), "utf8"));
  await fresh.exec(`update mls_feeds set base_url = 'https://mls.example', page_size = 2, max_records_per_run = 4, is_enabled = true where id = 'CRMLS'`);
  const recs = [1, 2, 3, 4, 5, 6, 7].map((n) => rec(n, `2026-09-0${n}T00:00:00Z`));
  const fakeFetch: typeof fetch = async (input) => {
    const u = new URL(String(input));
    const since = new Date(u.searchParams.get("$filter")!.split(" ge ")[1]).getTime();
    const skip = Number(u.searchParams.get("$skip") ?? 0);
    const m = recs.filter((r) => new Date(r.ModificationTimestamp as string).getTime() >= since);
    const body: Rec = { value: m.slice(skip, skip + 2) };
    if (skip + 2 < m.length) { u.searchParams.set("$skip", String(skip + 2)); body["@odata.nextLink"] = u.toString(); }
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const keys = new Set<string>();
  const freshStore: Store = {
    async upsertListings(rows) { rows.forEach((r) => keys.add(r.listing_key)); },
    async saveWatermark(id, ts) { await fresh.query(`update mls_feeds set last_modification_ts = $1 where id = $2`, [ts, id]); },
  };
  const load = async () => {
    const f = (await fresh.query<Rec>(`select * from mls_feeds where id = 'CRMLS'`)).rows[0];
    return { ...(f as Feed), backfill_from: "2026-01-01T00:00:00Z",
      last_modification_ts: f.last_modification_ts ? new Date(f.last_modification_ts as string).toISOString() : null };
  };
  const first = await syncFeed(await load(), "t", freshStore, Date.now() + 5000, fakeFetch);
  assert.equal(first.count, 4);
  assert.equal(first.complete, false, "stopped at the per-run limit");
  const second = await syncFeed(await load(), "t", freshStore, Date.now() + 5000, fakeFetch);
  assert.equal(second.complete, true);
  assert.equal(keys.size, 7, "every record synced across the two runs");
});

test("anon and signed-in API roles cannot read MLS data, even through the view", async () => {
  for (const role of ["anon", "authenticated"]) {
    for (const rel of ["mls_listings", "mls_listings_v", "mls_feeds"]) {
      await db.exec(`set role ${role}`);
      await assert.rejects(db.query(`select * from ${rel} limit 1`), /permission denied/, `${role} read ${rel}`);
      await db.exec(`reset role`);
    }
  }
});

test("paging links to another host are refused, so the token never leaves the feed's host", async () => {
  const evilFetch: typeof fetch = async () =>
    new Response(JSON.stringify({ value: [rec(99, "2026-10-09T00:00:00Z")], "@odata.nextLink": "https://evil.example/steal" }), { status: 200 });
  const feed = { ...(await loadFeed()), base_url: "https://mls.example/odata" };
  const noop: Store = { async upsertListings() {}, async saveWatermark() {} };
  await assert.rejects(syncFeed(feed, "t", noop, Date.now() + 5000, evilFetch), /different host/);
});

test("plain-http feed URLs are refused", async () => {
  const feed = { ...(await loadFeed()), base_url: "http://mls.example/odata" };
  const noop: Store = { async upsertListings() {}, async saveWatermark() {} };
  await assert.rejects(syncFeed(feed, "t", noop, Date.now() + 5000), /https/);
});
