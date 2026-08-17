import assert from "node:assert/strict";
import { test } from "node:test";
import {
  collapseIpv6Prefix,
  formatCidr,
  mergeCidrs,
  normalizeCidr,
  parseCidr,
} from "./cidr.ts";

test("normalizeCidr zeros host bits and compresses IPv6", () => {
  assert.equal(normalizeCidr("1.2.3.4/24"), "1.2.3.0/24");
  assert.equal(normalizeCidr("2001:0db8:0000:0000:0000:0000:0000:0001/32"), "2001:db8::/32");
});

test("mergeCidrs joins adjacent IPv4 and leaves a hole", () => {
  assert.deepEqual(mergeCidrs(["1.0.0.0/24", "1.0.1.0/24"]), ["1.0.0.0/23"]);
  assert.deepEqual(mergeCidrs(["1.0.0.0/24", "1.0.2.0/24"]), ["1.0.0.0/24", "1.0.2.0/24"]);
});

test("collapseIpv6Prefix does not widen IPv4 or a /48", () => {
  const v4 = parseCidr("8.8.8.0/24");
  assert.deepEqual(collapseIpv6Prefix(v4), v4);
  const v6 = parseCidr("2400:3200::/32");
  assert.equal(collapseIpv6Prefix(v6).plen, 32);
  const host = parseCidr("2001:db8::1/128");
  assert.equal(formatCidr(6, collapseIpv6Prefix(host).start, collapseIpv6Prefix(host).plen), "2001:db8::/64");
});

test("mergeCidrs collapses IPv6 host routes into one /64", () => {
  assert.deepEqual(mergeCidrs(["2001:db8::1/128", "2001:db8::2/128"]), ["2001:db8::/64"]);
});
