import assert from "node:assert/strict";
import { test } from "node:test";
import {
  asnListName,
  asnListTitle,
  extractAsnsFromMmdb,
  isAsnManagedName,
  isDashboardAsnIpList,
  listBelongsToAsn,
  parseAsn,
  parseAsnListName,
} from "./asn.ts";
import { writeMmdb } from "./mmdb-write.ts";
import { asnSourceUrls } from "./asn-mmdb.ts";

test("parseAsn accepts AS prefix, case, and bare number", () => {
  assert.equal(parseAsn("AS10206"), 10206);
  assert.equal(parseAsn("as10206"), 10206);
  assert.equal(parseAsn("10206"), 10206);
  assert.throws(() => parseAsn("AS10206 China"), /invalid ASN/);
  assert.throws(() => parseAsn("AS"), /invalid ASN/);
});

test("list names include the organisation when present", () => {
  assert.equal(asnListTitle(10206, null), "AS10206");
  assert.equal(asnListTitle(10206, "China Unicom Zhongwei Cloud"), "AS10206 China Unicom Zhongwei Cloud");
  assert.equal(asnListName(10206, "China Unicom Zhongwei Cloud", 1), "AS10206 China Unicom Zhongwei Cloud");
  assert.equal(asnListName(10206, "China Unicom Zhongwei Cloud", 2), "AS10206-2 China Unicom Zhongwei Cloud");
  assert.equal(asnListName(10206, null, 2), "AS10206-2");
});

test("asnSourceUrls prefers higher priority and skips path-only rows", () => {
  assert.deepEqual(
    asnSourceUrls([
      { id: "github", url: "https://example.com/b.mmdb", priority: 10, required: false, format: "mmdb" },
      { id: "gitio", url: "https://example.com/a.mmdb", priority: 20, required: true, format: "mmdb" },
    ]),
    ["https://example.com/a.mmdb", "https://example.com/b.mmdb"],
  );
});

test("parseAsnListName and belonging do not confuse AS10206 with AS102060", () => {
  assert.deepEqual(parseAsnListName("AS10206 China Unicom Zhongwei Cloud"), {
    asn: 10206,
    index: 1,
    org: "China Unicom Zhongwei Cloud",
  });
  assert.deepEqual(parseAsnListName("AS10206-2 China Unicom Zhongwei Cloud"), {
    asn: 10206,
    index: 2,
    org: "China Unicom Zhongwei Cloud",
  });
  assert.equal(listBelongsToAsn("AS10206 China Unicom Zhongwei Cloud", 10206), true);
  assert.equal(listBelongsToAsn("AS10206-2", 10206), true);
  assert.equal(listBelongsToAsn("AS102060", 10206), false);
  assert.equal(listBelongsToAsn("gateway-list:allow", 10206), false);
  assert.equal(isAsnManagedName("AS10206 China Unicom Zhongwei Cloud"), true);
  assert.equal(isAsnManagedName("gateway-list:block"), false);
  assert.deepEqual(parseAsnListName("ASN136907 HWCLOUDS-AS-AP"), {
    asn: 136907,
    index: 1,
    org: "HWCLOUDS-AS-AP",
  });
  assert.equal(listBelongsToAsn("ASN136907 HWCLOUDS-AS-AP", 136907), true);
  assert.equal(listBelongsToAsn("ASN136907 HWCLOUDS-AS-AP", 13690), false);
  assert.equal(isAsnManagedName("ASN136907 HWCLOUDS-AS-AP"), true);
});

test("dashboard ASN IP lists are other type=IP names starting with AS/ASN + digits", () => {
  assert.equal(isDashboardAsnIpList({ name: "AS10206", type: "IP" }), true);
  assert.equal(isDashboardAsnIpList({ name: "AS17444 HKBNESL-AS-AP", type: "IP" }), true);
  assert.equal(isDashboardAsnIpList({ name: "ASN136907 HWCLOUDS-AS-AP", type: "IP" }), true);
  assert.equal(isDashboardAsnIpList({ name: "AS10206", type: "DOMAIN" }), false);
  assert.equal(isDashboardAsnIpList({ name: "Apple iAd Tracking", type: "IP" }), false);
  assert.equal(isDashboardAsnIpList({ name: "corp-ips", type: "IP" }), false);
});

test("extractAsnsFromMmdb walks once and fills every requested ASN", () => {
  const buf = writeMmdb({
    ipVersion: 4,
    databaseType: "GeoLite2-ASN",
    networks: [
      {
        network: "14.1.0.0/16",
        data: {
          autonomous_system_number: 10206,
          autonomous_system_organization: "China Unicom Zhongwei Cloud",
        },
      },
      {
        network: "1.0.0.0/24",
        data: { autonomous_system_number: 13335, autonomous_system_organization: "CLOUDFLARENET" },
      },
    ],
  });
  const found = extractAsnsFromMmdb(buf, [10206, 13335, 64512]);
  assert.equal(found.get(10206)?.organization, "China Unicom Zhongwei Cloud");
  assert.deepEqual(found.get(13335)?.prefixes, ["1.0.0.0/24"]);
  assert.deepEqual(found.get(64512)?.prefixes, []);
  assert.equal(found.size, 3);
});
