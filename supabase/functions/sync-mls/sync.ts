// Core sync loop, independent of Supabase so it can be tested end to end locally.
import { buildPropertyUrl, mapResoProperty, type ResoRecord } from "./map.ts";

export type Feed = {
  id: string;
  platform: string;
  base_url: string | null;
  auth_type: "bearer" | "oauth_client_credentials";
  token_url: string | null;
  oauth_scope: string | null;
  page_size: number;
  backfill_from: string;
  last_modification_ts: string | null;
};

export type ListingRow = NonNullable<ReturnType<typeof mapResoProperty>>;

export interface Store {
  upsertListings(rows: ListingRow[]): Promise<void>;
  saveWatermark(feedId: string, ts: string): Promise<void>;
}

export type FetchFn = typeof fetch;

export async function fetchPage(
  url: string,
  token: string,
  fetchFn: FetchFn = fetch,
  attempt = 0,
): Promise<{ value: ResoRecord[]; next: string | null }> {
  const res = await fetchFn(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  if ((res.status === 429 || res.status >= 500) && attempt < 4) {
    const wait = Number(res.headers.get("Retry-After")) * 1000 || 2 ** attempt * 2000;
    await new Promise((r) => setTimeout(r, wait));
    return fetchPage(url, token, fetchFn, attempt + 1);
  }
  if (!res.ok) throw new Error(`Feed request failed: ${res.status} ${(await res.text()).slice(0, 500)}`);
  const json = await res.json();
  return { value: json.value ?? [], next: json["@odata.nextLink"] ?? null };
}

export async function syncFeed(
  feed: Feed,
  token: string,
  store: Store,
  deadline: number,
  fetchFn: FetchFn = fetch,
): Promise<{ count: number; complete: boolean }> {
  if (!feed.base_url) throw new Error("base_url not set");
  const since = feed.last_modification_ts ?? feed.backfill_from;
  let url: string | null = buildPropertyUrl(feed.base_url, new Date(since).toISOString(), feed.page_size);
  let count = 0;
  let watermark = feed.last_modification_ts ? new Date(feed.last_modification_ts).toISOString() : null;

  while (url && Date.now() < deadline) {
    const page = await fetchPage(url, token, fetchFn);
    const rows = page.value
      .map((r) => mapResoProperty(feed.id, r))
      .filter((r): r is ListingRow => r !== null);

    if (rows.length) await store.upsertListings(rows);
    count += rows.length;

    // Advance the watermark only after the page is saved, so a crash never skips records.
    let pageMax: string | null = null;
    for (const r of rows) {
      if (r.modification_timestamp && (!pageMax || r.modification_timestamp > pageMax)) pageMax = r.modification_timestamp;
    }
    if (pageMax && (!watermark || pageMax > watermark)) {
      watermark = pageMax;
      await store.saveWatermark(feed.id, watermark);
    }
    url = page.next;
  }
  return { count, complete: url === null };
}
