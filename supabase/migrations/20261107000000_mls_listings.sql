-- MLS listings pulled from each MLS's RESO Web API feed (all brokerages, not just ours).
-- One row per listing per feed. Field names follow the RESO Data Dictionary so every
-- platform (Trestle, Bridge, Spark, UtahRealEstate, SourceRE) maps to the same columns.

-- 1. Feed registry: one row per MLS. Credentials are NOT stored here; they live in
--    Supabase Edge Function secrets named MLS_<FEED_ID>_CLIENT_ID / _CLIENT_SECRET / _TOKEN.
create table if not exists public.mls_feeds (
  id                     text primary key,            -- matches offices.mls, e.g. 'RECOLORADO'
  display_name           text not null,
  platform               text not null check (platform in ('trestle','bridge','spark','utahre','sourcere','other')),
  base_url               text,                        -- OData root, e.g. https://api-trestle.corelogic.com/trestle/odata
  auth_type              text not null default 'bearer' check (auth_type in ('bearer','oauth_client_credentials')),
  token_url              text,                        -- only for oauth_client_credentials
  oauth_scope            text,
  page_size              integer not null default 200,
  backfill_from          timestamptz not null default (now() - interval '2 years'),
  last_modification_ts   timestamptz,                 -- sync watermark (max ModificationTimestamp seen)
  is_enabled             boolean not null default false,
  last_run_at            timestamptz,
  last_status            text,
  last_error             text,
  last_record_count      integer,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

-- 2. The listings themselves.
create table if not exists public.mls_listings (
  feed_id                   text not null references public.mls_feeds(id),
  listing_key               text not null,            -- RESO ListingKey (unique within a feed)
  listing_id                text,                     -- RESO ListingId (the MLS number agents see)
  standard_status           text,                     -- Active, Pending, Closed, Expired, Withdrawn, Canceled...
  mls_status                text,                     -- the MLS's own status label
  property_type             text,
  property_sub_type         text,

  unparsed_address          text,
  street_number             text,
  street_name               text,
  unit_number               text,
  city                      text,
  state_or_province         text,
  postal_code               text,
  county_or_parish          text,
  latitude                  numeric,
  longitude                 numeric,

  list_price                numeric,
  original_list_price       numeric,
  close_price               numeric,

  listing_contract_date     date,
  on_market_date            date,
  purchase_contract_date    date,
  close_date                date,
  off_market_date           date,
  days_on_market            integer,                  -- RESO DaysOnMarket as reported by the MLS
  cumulative_days_on_market integer,

  list_agent_mls_id         text,
  list_agent_key            text,
  list_agent_full_name      text,
  list_agent_email          text,
  list_agent_phone          text,
  list_office_mls_id        text,
  list_office_name          text,
  list_office_phone         text,
  co_list_agent_mls_id      text,
  co_list_agent_full_name   text,

  buyer_agent_mls_id        text,
  buyer_agent_key           text,
  buyer_agent_full_name     text,
  buyer_agent_email         text,
  buyer_agent_phone         text,
  buyer_office_mls_id       text,
  buyer_office_name         text,

  bedrooms_total            integer,
  bathrooms_total           numeric,
  living_area               numeric,
  lot_size_acres            numeric,
  year_built                integer,

  modification_timestamp    timestamptz,
  raw                       jsonb,                    -- full RESO record minus Media, for fields we didn't map
  synced_at                 timestamptz not null default now(),
  primary key (feed_id, listing_key)
);

create index if not exists mls_listings_list_agent_idx  on public.mls_listings (feed_id, list_agent_mls_id);
create index if not exists mls_listings_buyer_agent_idx on public.mls_listings (feed_id, buyer_agent_mls_id);
create index if not exists mls_listings_status_idx      on public.mls_listings (standard_status, close_date desc);
create index if not exists mls_listings_city_idx        on public.mls_listings (state_or_province, city);
create index if not exists mls_listings_listing_id_idx  on public.mls_listings (listing_id);

-- 3. Convenience view: fills days on market when the MLS doesn't send it, and flags
--    listings where one of OUR agents is on either side (via anywhere_agents.mls_numbers).
create or replace view public.mls_listings_v as
select
  l.*,
  coalesce(
    l.days_on_market,
    (coalesce(l.purchase_contract_date, l.close_date, l.off_market_date, current_date)
       - coalesce(l.on_market_date, l.listing_contract_date))
  ) as dom_effective,
  exists (
    select 1 from public.anywhere_agents a
    where l.list_agent_mls_id = any(a.mls_numbers) or l.buyer_agent_mls_id = any(a.mls_numbers)
  ) as involves_our_agent
from public.mls_listings l;

-- 4. Security: only the service role (the sync job) writes. Signed-in app users can read.
alter table public.mls_feeds    enable row level security;
alter table public.mls_listings enable row level security;

drop policy if exists mls_listings_read on public.mls_listings;
create policy mls_listings_read on public.mls_listings
  for select to authenticated using (true);

-- 5. Seed the 17 MLSs (disabled until credentials are added). Platform per research
--    on 2026-11-07; confirm with each MLS when the feed is approved.
insert into public.mls_feeds (id, display_name, platform, auth_type) values
  ('RECOLORADO', 'REcolorado',                              'bridge',   'bearer'),
  ('CRMLS',      'California Regional MLS',                 'trestle',  'oauth_client_credentials'),
  ('WFRMLS',     'UtahRealEstate.com',                      'utahre',   'bearer'),
  ('PCBAOR',     'Park City MLS',                           'spark',    'bearer'),
  ('NNRMLS',     'Northern Nevada Regional MLS',            'spark',    'bearer'),
  ('GLVAR',      'Las Vegas REALTORS',                      'trestle',  'oauth_client_credentials'),
  ('IMLS',       'Intermountain MLS',                       'bridge',   'bearer'),
  ('PPAR',       'elevateMLS (Pikes Peak)',                 'sourcere', 'bearer'),
  ('WCMLS',      'Washington County MLS',                   'spark',    'bearer'),
  ('GPSMLS',     'Greater Palm Springs',                    'other',    'bearer'),
  ('VBR',        'Vail Board of REALTORS',                  'spark',    'bearer'),
  ('ALTITUDE',   'Altitude MLS',                            'trestle',  'oauth_client_credentials'),
  ('IVBOR',      'Incline Village MLS',                     'trestle',  'oauth_client_credentials'),
  ('TSIERRA',    'Tahoe Sierra MLS',                        'bridge',   'bearer'),
  ('SVBOR',      'Sun Valley Board of REALTORS',            'spark',    'bearer'),
  ('CREN',       'Colorado Real Estate Network (RETS only)','other',    'bearer'),
  ('STAOR',      'South Tahoe MLS (RETS only)',             'other',    'bearer')
on conflict (id) do nothing;

-- Known OData roots (fill base_url when a feed is approved; Bridge and Spark URLs
-- include a dataset or are per-account):
--   Trestle:        https://api-trestle.corelogic.com/trestle/odata
--                   token: https://api-trestle.corelogic.com/trestle/oidc/connect/token  scope: api
--   Bridge:         https://api.bridgedataoutput.com/api/v2/OData/<dataset_id>
--   Spark:          https://replication.sparkapi.com/Reso/OData
--   UtahRealEstate: https://resoapi.utahrealestate.com/reso/odata
