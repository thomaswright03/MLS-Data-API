# MLS listings sync

Pulls listings and sales from **every brokerage** in the client's 17 MLSs into their Supabase. It covers the listing agent, buyer agent, days on market, list price and close price. Their own deals are already in Supabase; this adds the rest of the market.

## What's here

| File | What it does |
|---|---|
| `supabase/migrations/20261107000000_mls_listings.sql` | Creates `mls_feeds` (one row per MLS, seeded with all 17, disabled) and `mls_listings`, plus the view `mls_listings_v` with a computed `dom_effective` and an `involves_our_agent` flag (matched through `anywhere_agents.mls_numbers`). Turns on RLS: signed-in users can read, and only the sync job writes. |
| `supabase/functions/sync-mls/index.ts` | Edge Function. For each enabled feed, it reads the RESO Web API `Property` resource incrementally by `ModificationTimestamp`, follows paging, and upserts rows. It saves its place after every page, so a timeout or crash just resumes on the next run. |
| `supabase/functions/sync-mls/map.ts` | Maps one RESO record to a table row. Shared by all platforms (Trestle, Bridge, Spark, UtahRealEstate, SourceRE). |
| `supabase/functions/sync-mls/map.test.ts` | Unit test for the mapping. Run it with `node --experimental-strip-types map.test.ts`. |

## Turning on a feed (once an MLS approves it)

1. Set the feed's URL and auth:
   ```sql
   update mls_feeds set
     base_url = 'https://api-trestle.corelogic.com/trestle/odata',
     token_url = 'https://api-trestle.corelogic.com/trestle/oidc/connect/token',
     oauth_scope = 'api',
     is_enabled = true
   where id = 'CRMLS';
   ```
2. Add the credentials as secrets. Never put them in the table:
   ```
   supabase secrets set MLS_CRMLS_CLIENT_ID=... MLS_CRMLS_CLIENT_SECRET=...
   # bearer-token feeds (Bridge, Spark, UtahRealEstate):
   supabase secrets set MLS_RECOLORADO_TOKEN=...
   ```
3. Optional tuning per feed: `max_records_per_run` (default 1000) keeps each run under Supabase's CPU/memory limit (runs that go over are killed with HTTP 546), and `store_raw` (default off) keeps the full RESO record. `last_status` is `running` while a run is in progress, `partial` when it stopped at the limit (the next run continues), `ok` when caught up, and `error` with `last_error` set. A status stuck on `running` with an old `last_run_at` means the run was killed.
4. One-time: create the trigger secret. The function rejects any call without it (the public anon key alone can't trigger syncs):
   ```
   openssl rand -hex 32            # copy the output
   supabase secrets set SYNC_SECRET=<that value>
   ```
   and store the same value in Vault so the scheduler can use it: `select vault.create_secret('<that value>', 'mls_sync_secret');`
5. Run it once by hand: `curl -X POST -H "Authorization: Bearer <anon key>" -H "x-sync-secret: <that value>" https://<project-ref>.supabase.co/functions/v1/sync-mls?feed=CRMLS`. The first run backfills 2 years (`backfill_from`) and may take several runs. Check `mls_feeds.last_status`.
6. Schedule it (every 10 minutes during the backfill, hourly after) with pg_cron and pg_net, reading the secret from Vault (never paste keys into the cron SQL):
   ```sql
   select cron.schedule('sync-mls', '*/10 * * * *', $$
     select net.http_post(
       url := 'https://<project-ref>.supabase.co/functions/v1/sync-mls',
       headers := jsonb_build_object(
         'Authorization', 'Bearer <anon key>',  -- public key; Supabase's gateway requires a JWT
         'x-sync-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'mls_sync_secret'))
     );
   $$);
   ```

## Security

- **Read-only toward the MLS:** the sync only sends GET requests, only follows paging links on the feed's own host, and refuses non-https feed URLs, so the MLS token can't be sent anywhere else.
- **Locked-down tables:** `mls_listings`, `mls_listings_v` and `mls_feeds` have RLS on, no read policies, and explicit revokes from `anon` and `authenticated`. Only the service role (the sync job) can read or write. The view is `security_invoker`, so it can't bypass RLS. To let specific staff read the data, add a narrow policy (there's an example in the migration). Don't open it to all signed-in users; MLS licenses usually limit this data to the brokerage. Those users also need read access to `anywhere_agents`, or `involves_our_agent` will quietly show false.
- **Confidential fields never stored:** showing instructions, lockbox/access/gate codes, private remarks and owner/seller names are dropped even when `store_raw` is on.
- **Secrets:** MLS credentials and `SYNC_SECRET` live only in Supabase function secrets and Vault. Never commit them, paste them in chat, or put them in a table.
- **Trigger protection:** Supabase's gateway requires a JWT (the public anon key is fine), and the function itself only accepts POST with a correct `x-sync-secret` (compared in constant time), and refuses everything if `SYNC_SECRET` isn't set.

## Example queries

Top outside listing agents by closed volume in the last 12 months:
```sql
select list_agent_full_name, list_office_name, count(*) as closings, sum(close_price) as volume,
       round(avg(dom_effective)) as avg_dom
from mls_listings_v
where standard_status = 'Closed' and close_date > current_date - 365 and not involves_our_agent
group by 1, 2 order by volume desc limit 50;
```

## Not done yet / to check

- **Not run against a live feed yet**, since no feed credentials exist. The mapping is unit-tested. `index.ts` hasn't been type-checked with Deno (it isn't installed here), so run `supabase functions serve` before deploying.
- Some MLSs only allow `$orderby` on certain fields, or need replication endpoints (Spark uses `replication.sparkapi.com`). Adjust per feed when it's approved.
- Deleted or withdrawn listings: some feeds drop records instead of updating them. A periodic reconcile (compare keys) can be added later if needed.
- CREN and South Tahoe are RETS-only and need a separate adapter.
- MLS license terms limit how this data can be used and shown. BBO/VOW data is for the brokerage's internal use and is usually **not** resellable.
