// Maps one RESO Data Dictionary "Property" record to a public.mls_listings row.
// Pure function with no Deno/Supabase imports so it can be unit-tested with plain Node.

export type ResoRecord = Record<string, unknown>;

const str = (v: unknown): string | null =>
  v === null || v === undefined || v === "" ? null : String(v);

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[$,]/g, ""));
  return Number.isFinite(n) ? n : null;
};

const int = (v: unknown): number | null => {
  const n = num(v);
  return n === null ? null : Math.round(n);
};

// RESO dates arrive as "2026-03-14" or "2026-03-14T00:00:00Z"; keep the date part.
const date = (v: unknown): string | null => {
  const s = str(v);
  if (!s) return null;
  const m = s.match(/^\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : null;
};

const ts = (v: unknown): string | null => {
  const s = str(v);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

// First non-empty value among several RESO field names (MLSs differ on which phone field they fill).
const first = (r: ResoRecord, ...keys: string[]): unknown => {
  for (const k of keys) {
    const v = r[k];
    if (v !== null && v !== undefined && v !== "") return v;
  }
  return null;
};

// RESO enums sometimes come back as arrays (multi-select) or with OData type prefixes.
const enumStr = (v: unknown): string | null => {
  if (Array.isArray(v)) return v.length ? enumStr(v[0]) : null;
  const s = str(v);
  if (!s) return null;
  return s.includes("'") ? s.replace(/^.*'(.*)'$/, "$1") : s;
};

// Back-office feeds include agent-only fields (showing instructions, lockbox/access codes,
// private remarks, seller names). Never keep these, even when store_raw is on.
const CONFIDENTIAL = /^(PrivateRemarks|PrivateOfficeRemarks|AgentOnlyRemarks|ShowingInstructions|ShowingContact.*|ShowingRequirements|LockBox.*|AccessCode|GateCode|AlarmCode|Owner.*|SellerName|Seller.*Name|.*Password.*)$/i;

export function mapResoProperty(feedId: string, r: ResoRecord, opts: { storeRaw?: boolean } = {}) {
  const listingKey = str(first(r, "ListingKey", "ListingKeyNumeric", "ListingId"));
  if (!listingKey) return null;

  const raw: ResoRecord = {};
  for (const [k, v] of Object.entries(r)) {
    if (k === "Media" || CONFIDENTIAL.test(k)) continue; // photos are large; confidential fields never stored
    raw[k] = v;
  }

  return {
    feed_id: feedId,
    listing_key: listingKey,
    listing_id: str(r.ListingId),
    standard_status: enumStr(r.StandardStatus),
    mls_status: str(r.MlsStatus),
    property_type: enumStr(r.PropertyType),
    property_sub_type: enumStr(r.PropertySubType),

    unparsed_address: str(r.UnparsedAddress),
    street_number: str(r.StreetNumber),
    street_name: str(r.StreetName),
    unit_number: str(r.UnitNumber),
    city: str(r.City),
    state_or_province: enumStr(r.StateOrProvince),
    postal_code: str(r.PostalCode),
    county_or_parish: enumStr(r.CountyOrParish),
    latitude: num(r.Latitude),
    longitude: num(r.Longitude),

    list_price: num(r.ListPrice),
    original_list_price: num(r.OriginalListPrice),
    close_price: num(r.ClosePrice),

    listing_contract_date: date(r.ListingContractDate),
    on_market_date: date(first(r, "OnMarketDate", "ListingContractDate")),
    purchase_contract_date: date(r.PurchaseContractDate),
    close_date: date(r.CloseDate),
    off_market_date: date(r.OffMarketDate),
    days_on_market: int(r.DaysOnMarket),
    cumulative_days_on_market: int(r.CumulativeDaysOnMarket),

    list_agent_mls_id: str(r.ListAgentMlsId),
    list_agent_key: str(first(r, "ListAgentKey", "ListAgentKeyNumeric")),
    list_agent_full_name: str(
      first(r, "ListAgentFullName") ??
        ([r.ListAgentFirstName, r.ListAgentLastName].filter(Boolean).join(" ") || null),
    ),
    list_agent_email: str(r.ListAgentEmail),
    list_agent_phone: str(
      first(r, "ListAgentDirectPhone", "ListAgentMobilePhone", "ListAgentPreferredPhone", "ListAgentOfficePhone"),
    ),
    list_office_mls_id: str(r.ListOfficeMlsId),
    list_office_name: str(r.ListOfficeName),
    list_office_phone: str(r.ListOfficePhone),
    co_list_agent_mls_id: str(r.CoListAgentMlsId),
    co_list_agent_full_name: str(r.CoListAgentFullName),

    buyer_agent_mls_id: str(r.BuyerAgentMlsId),
    buyer_agent_key: str(first(r, "BuyerAgentKey", "BuyerAgentKeyNumeric")),
    buyer_agent_full_name: str(
      first(r, "BuyerAgentFullName") ??
        ([r.BuyerAgentFirstName, r.BuyerAgentLastName].filter(Boolean).join(" ") || null),
    ),
    buyer_agent_email: str(r.BuyerAgentEmail),
    buyer_agent_phone: str(
      first(r, "BuyerAgentDirectPhone", "BuyerAgentMobilePhone", "BuyerAgentPreferredPhone", "BuyerAgentOfficePhone"),
    ),
    buyer_office_mls_id: str(r.BuyerOfficeMlsId),
    buyer_office_name: str(r.BuyerOfficeName),

    bedrooms_total: int(r.BedroomsTotal),
    bathrooms_total: num(first(r, "BathroomsTotalDecimal", "BathroomsTotalInteger")),
    living_area: num(r.LivingArea),
    lot_size_acres: num(r.LotSizeAcres),
    year_built: int(r.YearBuilt),

    modification_timestamp: ts(r.ModificationTimestamp),
    raw: opts.storeRaw ? raw : null,
    synced_at: new Date().toISOString(),
  };
}

// Builds the first-page URL for an incremental pull ordered by ModificationTimestamp.
export function buildPropertyUrl(baseUrl: string, since: string, pageSize: number): string {
  const root = baseUrl.replace(/\/+$/, "");
  // Encode values with %20 (not "+") and keep "$" literal: some OData servers reject either form.
  const params = [
    ["$filter", `ModificationTimestamp ge ${since}`],
    ["$orderby", "ModificationTimestamp asc"],
    ["$top", String(pageSize)],
  ].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
  return `${root}/Property?${params}`;
}
