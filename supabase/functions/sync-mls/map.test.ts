import assert from "node:assert/strict";
import { mapResoProperty, buildPropertyUrl } from "./map.ts";

const rec = {
  ListingKey: "1234567",
  ListingId: "PW26012345",
  StandardStatus: "Closed",
  PropertyType: "Residential",
  UnparsedAddress: "123 Main St, Ojai, CA 93023",
  City: "Ojai",
  StateOrProvince: "CA",
  ListPrice: 1495000,
  ClosePrice: "1,450,000",
  ListingContractDate: "2026-03-01",
  OnMarketDate: "2026-03-03",
  PurchaseContractDate: "2026-03-20",
  CloseDate: "2026-04-15T00:00:00Z",
  DaysOnMarket: 17,
  ListAgentMlsId: "A123",
  ListAgentFirstName: "Jane",
  ListAgentLastName: "Doe",
  ListAgentEmail: "jane@example.com",
  ListAgentMobilePhone: "805-555-0100",
  ListOfficeName: "Other Brokerage",
  BuyerAgentFullName: "Bob Buyer",
  BathroomsTotalInteger: 3,
  ModificationTimestamp: "2026-04-16T12:00:00.123Z",
  Media: [{ MediaURL: "x" }],
};

const row = mapResoProperty("CRMLS", rec)!;
assert.equal(row.listing_key, "1234567");
assert.equal(row.close_price, 1450000);
assert.equal(row.close_date, "2026-04-15");
assert.equal(row.days_on_market, 17);
assert.equal(row.list_agent_full_name, "Jane Doe");
assert.equal(row.list_agent_phone, "805-555-0100");
assert.equal(row.buyer_agent_full_name, "Bob Buyer");
assert.equal(row.bathrooms_total, 3);
assert.equal(row.modification_timestamp, "2026-04-16T12:00:00.123Z");
assert.ok(!("Media" in (row.raw as object)));
assert.equal(mapResoProperty("CRMLS", { City: "x" }), null);

const url = buildPropertyUrl("https://api-trestle.corelogic.com/trestle/odata/", "2024-11-07T00:00:00.000Z", 200);
assert.ok(url.startsWith("https://api-trestle.corelogic.com/trestle/odata/Property?"));
assert.ok(decodeURIComponent(url).includes("$filter=ModificationTimestamp ge 2024-11-07T00:00:00.000Z"));
console.log("all mapping tests passed");
