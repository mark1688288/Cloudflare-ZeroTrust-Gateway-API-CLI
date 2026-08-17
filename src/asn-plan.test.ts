import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AsnAbortError,
  findDashboardAsnLists,
  planAsnAdd,
  planAsnUpdate,
  planIsNoop,
  uniqueDashboardAsns,
} from "./asn-plan.ts";
import type { AsnExtract } from "./asn.ts";

function extract(over: Partial<AsnExtract> = {}): AsnExtract {
  return {
    asn: 10206,
    organization: "China Unicom Zhongwei Cloud",
    prefixes: ["14.1.0.0/16", "2400:3200::/32"],
    databaseType: "GeoLite2-ASN",
    buildEpoch: 1,
    ...over,
  };
}

test("planAsnAdd chunks and never mentions a rule", () => {
  const plan = planAsnAdd(extract({ prefixes: ["1.0.0.0/24", "1.0.1.0/24", "1.0.2.0/24"] }), [], 2);
  assert.equal(plan.action, "add");
  assert.equal(plan.creates.length, 2);
  assert.equal(plan.creates[0]?.name, "AS10206 China Unicom Zhongwei Cloud");
  assert.equal(plan.creates[1]?.name, "AS10206-2 China Unicom Zhongwei Cloud");
  assert.deepEqual(plan.creates[0]?.items, ["1.0.0.0/24", "1.0.1.0/24"]);
  assert.deepEqual(plan.patches, []);
});

test("planAsnAdd refuses when a list already exists", () => {
  assert.throws(
    () => planAsnAdd(extract(), [{ id: "L1", name: "AS10206", items: [] }], 1000),
    (error: unknown) => {
      assert.ok(error instanceof AsnAbortError);
      assert.match(error.message, /already has reusable list/);
      return true;
    },
  );
});

test("planAsnUpdate patches drift and does not delete leftover lists", () => {
  const plan = planAsnUpdate(
    extract({ prefixes: ["14.1.0.0/16", "1.2.3.0/24"] }),
    [
      {
        id: "L1",
        name: "AS10206",
        type: "IP",
        items: ["14.1.0.0/16", "9.9.9.0/24"],
      },
    ],
    1000,
  );
  assert.equal(plan.creates.length, 0);
  assert.equal(plan.patches.length, 1);
  assert.equal(plan.patches[0]?.nextName, "AS10206 China Unicom Zhongwei Cloud");
  assert.deepEqual(plan.patches[0]?.append, ["1.2.3.0/24"]);
  assert.deepEqual(plan.patches[0]?.remove, ["9.9.9.0/24"]);
});

test("planAsnUpdate creates an extra chunk instead of overflowing items_per_list", () => {
  const plan = planAsnUpdate(
    extract({ prefixes: ["1.0.0.0/24", "1.0.1.0/24", "1.0.2.0/24"] }),
    [{ id: "L1", name: "AS10206", type: "IP", items: ["1.0.0.0/24"] }],
    2,
  );
  assert.deepEqual(plan.patches[0]?.append, ["1.0.1.0/24"]);
  assert.equal(plan.creates.length, 1);
  assert.equal(plan.creates[0]?.name, "AS10206-2 China Unicom Zhongwei Cloud");
  assert.deepEqual(plan.creates[0]?.items, ["1.0.2.0/24"]);
});

test("planAsnUpdate refuses a missing list or a DOMAIN list", () => {
  assert.throws(() => planAsnUpdate(extract(), [], 1000), /no reusable list yet/);
  assert.throws(
    () =>
      planAsnUpdate(extract(), [{ id: "L1", name: "AS10206", type: "DOMAIN", items: [] }], 1000),
    /expected IP/,
  );
});

test("planAsnUpdate accepts a dashboard ASN-prefixed name and renames it", () => {
  const plan = planAsnUpdate(
    extract({
      asn: 136907,
      organization: "HWCLOUDS-AS-AP",
      prefixes: ["1.2.3.0/24"],
    }),
    [{ id: "L1", name: "ASN136907 HWCLOUDS-AS-AP", type: "IP", items: ["9.9.9.0/24"] }],
    1000,
  );
  assert.equal(plan.patches[0]?.name, "ASN136907 HWCLOUDS-AS-AP");
  assert.equal(plan.patches[0]?.nextName, "AS136907 HWCLOUDS-AS-AP");
  assert.deepEqual(plan.patches[0]?.append, ["1.2.3.0/24"]);
  assert.deepEqual(plan.patches[0]?.remove, ["9.9.9.0/24"]);
});

test("findDashboardAsnLists keeps other IP AS* lists and drops DOMAIN / non-AS names", () => {
  const lists = findDashboardAsnLists([
    { name: "AS10206", type: "IP" },
    { name: "AS17444 HKBNESL-AS-AP", type: "IP" },
    { name: "ASN136907 HWCLOUDS-AS-AP", type: "IP" },
    { name: "AS10206", type: "DOMAIN" },
    { name: "Apple iAd Tracking", type: "DOMAIN" },
    { name: "corp-ips", type: "IP" },
  ]);
  assert.deepEqual(
    lists.map((row) => row.name),
    ["AS10206", "AS17444 HKBNESL-AS-AP", "ASN136907 HWCLOUDS-AS-AP"],
  );
  assert.deepEqual(uniqueDashboardAsns(lists), [10206, 17444, 136907]);
});

test("second update with the same prefixes is a no-op after rename", () => {
  const first = planAsnUpdate(
    extract(),
    [{ id: "L1", name: "AS10206 China Unicom Zhongwei Cloud", type: "IP", items: extract().prefixes }],
    1000,
  );
  assert.equal(planIsNoop(first), true);
});
