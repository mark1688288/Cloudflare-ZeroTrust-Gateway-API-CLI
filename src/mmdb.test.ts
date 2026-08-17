import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { extractAsnFromMmdb } from "./asn.ts";
import { readMmdbMetadata, walkMmdbNetworks } from "./mmdb.ts";
import { writeMmdb } from "./mmdb-write.ts";

const officialTest = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "testdata/GeoLite2-ASN-Test.mmdb",
);

function asnData(asn: number, org?: string): Record<string, unknown> {
  return org
    ? { autonomous_system_number: asn, autonomous_system_organization: org }
    : { autonomous_system_number: asn };
}

test("write/read GeoLite2-ASN IPv4 prefixes and organisation", () => {
  const buf = writeMmdb({
    ipVersion: 4,
    databaseType: "GeoLite2-ASN",
    networks: [
      { network: "1.0.0.0/24", data: asnData(13335, "CLOUDFLARENET") },
      { network: "1.0.1.0/24", data: asnData(13335, "CLOUDFLARENET") },
      { network: "8.8.8.0/24", data: asnData(15169, "GOOGLE") },
      { network: "14.1.0.0/16", data: asnData(10206, "China Unicom Zhongwei Cloud") },
    ],
  });
  const meta = readMmdbMetadata(buf);
  assert.equal(meta.databaseType, "GeoLite2-ASN");
  assert.equal(meta.ipVersion, 4);

  const found: string[] = [];
  walkMmdbNetworks(buf, (cidr, data) => {
    const row = data as { autonomous_system_number: number };
    if (row.autonomous_system_number === 10206) found.push(cidr);
  });
  assert.deepEqual(found, ["14.1.0.0/16"]);

  const extracted = extractAsnFromMmdb(buf, 10206);
  assert.equal(extracted.organization, "China Unicom Zhongwei Cloud");
  assert.deepEqual(extracted.prefixes, ["14.1.0.0/16"]);

  const cf = extractAsnFromMmdb(buf, 13335);
  assert.deepEqual(cf.prefixes, ["1.0.0.0/23"]);
});

test("28-bit records round-trip", () => {
  const buf = writeMmdb({
    ipVersion: 4,
    recordSize: 28,
    databaseType: "GeoLite2-ASN",
    networks: [{ network: "9.9.9.0/24", data: asnData(19281, "QUAD9") }],
  });
  assert.equal(readMmdbMetadata(buf).recordSize, 28);
  assert.deepEqual(extractAsnFromMmdb(buf, 19281).prefixes, ["9.9.9.0/24"]);
});

test("IPv4 in an IPv6 tree plus native IPv6, aliases do not duplicate", () => {
  const buf = writeMmdb({
    ipVersion: 6,
    databaseType: "GeoLite2-ASN",
    networks: [
      { network: "14.1.0.0/16", data: asnData(10206, "China Unicom Zhongwei Cloud") },
      { network: "2400:3200::/32", data: asnData(10206, "China Unicom Zhongwei Cloud") },
      { network: "1.0.0.0/24", data: asnData(13335, "CLOUDFLARENET") },
    ],
    aliases: [
      { from: "::ffff:0:0/96", to: "0.0.0.0/0" },
      { from: "2002::/16", to: "0.0.0.0/0" },
    ],
  });
  const extracted = extractAsnFromMmdb(buf, 10206);
  assert.deepEqual(extracted.prefixes, ["14.1.0.0/16", "2400:3200::/32"]);
  const cf = extractAsnFromMmdb(buf, 13335);
  assert.deepEqual(cf.prefixes, ["1.0.0.0/24"]);
});

test("unknown ASN returns no prefixes", () => {
  const buf = writeMmdb({
    ipVersion: 4,
    databaseType: "GeoLite2-ASN",
    networks: [{ network: "1.0.0.0/24", data: asnData(13335, "CLOUDFLARENET") }],
  });
  const extracted = extractAsnFromMmdb(buf, 10206);
  assert.equal(extracted.organization, null);
  assert.deepEqual(extracted.prefixes, []);
});

test("reads MaxMind GeoLite2-ASN-Test.mmdb (28-bit IPv6)", { skip: !existsSync(officialTest) }, () => {
  const buf = readFileSync(officialTest);
  const meta = readMmdbMetadata(buf);
  assert.equal(meta.databaseType, "GeoLite2-ASN");
  assert.equal(meta.recordSize, 28);
  assert.equal(meta.ipVersion, 6);
  const google = extractAsnFromMmdb(buf, 15169);
  assert.equal(google.organization, "Google Inc.");
  assert.ok(google.prefixes.includes("1.0.0.0/24"));
});

test("City database is rejected", () => {
  const buf = writeMmdb({
    ipVersion: 4,
    databaseType: "GeoLite2-City",
    networks: [{ network: "1.0.0.0/24", data: { country: "AU" } }],
  });
  assert.throws(() => extractAsnFromMmdb(buf, 1), /GeoLite2-ASN/);
});
