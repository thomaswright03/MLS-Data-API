// Supabase Edge Function: pulls new/changed listings from each enabled MLS feed
// (RESO Web API / OData) and upserts them into public.mls_listings.
//
// Invoke:  POST /functions/v1/sync-mls            -> all enabled feeds
//          POST /functions/v1/sync-mls?feed=CRMLS -> one feed
// Safe to re-run: it resumes from mls_feeds.last_modification_ts and upserts by (feed_id, listing_key).
//
// Secrets per feed (supabase secrets set ...):
//   bearer feeds:  MLS_<FEED_ID>_TOKEN
//   oauth feeds:   MLS_<FEED_ID>_CLIENT_ID, MLS_<FEED_ID>_CLIENT_SECRET

import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { type Feed, type ListingRow, type Store, syncFeed } from "./sync.ts";

const TIME_BUDGET_MS = 110_000; // stop before the Edge Function wall-clock limit; next run resumes
const UPSERT_CHUNK = 500;

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

const store: Store = {
  async upsertListings(rows: ListingRow[]) {
    for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
      const { error } = await supabase
        .from("mls_listings")
        .upsert(rows.slice(i, i + UPSERT_CHUNK), { onConflict: "feed_id,listing_key" });
      if (error) throw new Error(`Upsert failed: ${error.message}`);
    }
  },
  async saveWatermark(feedId: string, ts: string) {
    const { error } = await supabase.from("mls_feeds").update({ last_modification_ts: ts }).eq("id", feedId);
    if (error) throw new Error(`Watermark update failed: ${error.message}`);
  },
};

async function getAccessToken(feed: Feed): Promise<string> {
  const prefix = `MLS_${feed.id}_`;
  if (feed.auth_type === "bearer") {
    const token = Deno.env.get(`${prefix}TOKEN`);
    if (!token) throw new Error(`Missing secret ${prefix}TOKEN`);
    return token;
  }
  const clientId = Deno.env.get(`${prefix}CLIENT_ID`);
  const clientSecret = Deno.env.get(`${prefix}CLIENT_SECRET`);
  if (!clientId || !clientSecret || !feed.token_url) {
    throw new Error(`Missing ${prefix}CLIENT_ID / CLIENT_SECRET secrets or token_url`);
  }
  const res = await fetch(feed.token_url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
      ...(feed.oauth_scope ? { scope: feed.oauth_scope } : {}),
    }),
  });
  if (!res.ok) throw new Error(`Token request failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  return json.access_token as string;
}

Deno.serve(async (req) => {
  const deadline = Date.now() + TIME_BUDGET_MS;
  const only = new URL(req.url).searchParams.get("feed");

  let q = supabase.from("mls_feeds").select("*").eq("is_enabled", true);
  if (only) q = q.eq("id", only);
  const { data: feeds, error } = await q;
  if (error) return Response.json({ error: error.message }, { status: 500 });

  const results: Record<string, unknown> = {};
  for (const feed of (feeds ?? []) as Feed[]) {
    if (Date.now() >= deadline) {
      results[feed.id] = { skipped: "time budget used; will run next time" };
      continue;
    }
    // Mark the run first: if the worker is killed mid-run, the feed shows 'running'
    // with a stale last_run_at instead of looking like it never ran.
    await supabase.from("mls_feeds").update({
      last_run_at: new Date().toISOString(),
      last_status: "running",
      last_error: null,
    }).eq("id", feed.id);
    try {
      const token = await getAccessToken(feed);
      const r = await syncFeed(feed, token, store, deadline);
      results[feed.id] = r;
      await supabase.from("mls_feeds").update({
        last_run_at: new Date().toISOString(),
        last_status: r.complete ? "ok" : "partial",
        last_error: null,
        last_record_count: r.count,
        updated_at: new Date().toISOString(),
      }).eq("id", feed.id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      results[feed.id] = { error: msg };
      await supabase.from("mls_feeds").update({
        last_run_at: new Date().toISOString(),
        last_status: "error",
        last_error: msg,
        updated_at: new Date().toISOString(),
      }).eq("id", feed.id);
    }
  }
  return Response.json(results);
});
