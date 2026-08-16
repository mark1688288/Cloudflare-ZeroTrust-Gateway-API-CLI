import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compileDomains,
  extractHost,
  isPublicSuffix,
  normalizeDomain,
  type CompilerSource,
} from "./compiler.ts";

function source(
  partial: Partial<CompilerSource> & Pick<CompilerSource, "id" | "role" | "text">,
): CompilerSource {
  return {
    priority: partial.role === "allow" ? 100 : 40,
    pinned: partial.id.startsWith("personal"),
    ...partial,
  };
}

function domains(entries: { domain: string }[]): string[] {
  return entries.map((entry) => entry.domain);
}

test("adblock leftovers: ||domain^ is a block, @@|| is not", () => {
  const result = compileDomains(
    [
      source({
        id: "oisd",
        role: "block",
        format: "adblock",
        text: [
          "[Adblock Plus]",
          "! comment",
          "||ads.example.com^",
          "||tracker.example.com^$all",
          "@@||good.example.com^",
          "example.com##.ad",
        ].join("\n"),
      }),
    ],
    { maxItems: 300000 },
  );

  assert.deepEqual(domains(result.block).sort(), ["ads.example.com", "tracker.example.com"]);
  assert.deepEqual(result.allow, []);
  assert.equal(
    result.block.some((entry) => entry.domain === "good.example.com"),
    false,
  );
});

test("punycode / lowercase", () => {
  const result = compileDomains(
    [
      source({
        id: "personal",
        role: "block",
        text: "例子.com\nEXAMPLE.COM\n||XN--FSQU00A.COM^\n",
      }),
    ],
    { maxItems: 300000 },
  );

  assert.deepEqual(domains(result.block), ["example.com", "xn--fsqu00a.com"]);
  assert.equal(normalizeDomain("例子.com"), "xn--fsqu00a.com");
  assert.equal(normalizeDomain("EXAMPLE.COM."), "example.com");
});

test("parent-fold: drop blocked children, keep the parent", () => {
  const result = compileDomains(
    [
      source({
        id: "personal-block",
        role: "block",
        text: ["example.com", "ads.example.com", "a.b.example.com"].join("\n"),
      }),
    ],
    { maxItems: 300000 },
  );

  assert.deepEqual(domains(result.block), ["example.com"]);
  assert.deepEqual(
    result.folded.map((row) => ({ domain: row.domain, parent: row.parent })).sort((a, b) =>
      a.domain.localeCompare(b.domain),
    ),
    [
      { domain: "a.b.example.com", parent: "example.com" },
      { domain: "ads.example.com", parent: "example.com" },
    ],
  );
});

test("allow a child does not un-block the parent", () => {
  const result = compileDomains(
    [
      source({
        id: "personal",
        role: "allow",
        text: "maps.google.com\n",
      }),
      source({
        id: "personal-block",
        role: "block",
        text: "google.com\n",
      }),
    ],
    { maxItems: 300000 },
  );

  assert.deepEqual(domains(result.allow), ["maps.google.com"]);
  assert.deepEqual(domains(result.block), ["google.com"]);
  assert.deepEqual(result.folded, []);
});

test("same domain in allow and block stays in both (runtime allow wins)", () => {
  const result = compileDomains(
    [
      source({ id: "personal", role: "allow", text: "example.com\n" }),
      source({ id: "personal-block", role: "block", text: "example.com\n" }),
    ],
    { maxItems: 300000 },
  );

  assert.deepEqual(domains(result.allow), ["example.com"]);
  assert.deepEqual(domains(result.block), ["example.com"]);
});

test("PSL: co.uk / github.io are not foldable parents", () => {
  assert.equal(isPublicSuffix("co.uk"), true);
  assert.equal(isPublicSuffix("com.hk"), true);
  assert.equal(isPublicSuffix("github.io"), true);
  assert.equal(isPublicSuffix("example.co.uk"), false);

  const result = compileDomains(
    [
      source({
        id: "personal-block",
        role: "block",
        text: [
          "co.uk",
          "example.co.uk",
          "ads.example.co.uk",
          "github.io",
          "foo.github.io",
          "bar.foo.github.io",
          "example.com.hk",
          "ads.example.com.hk",
        ].join("\n"),
      }),
    ],
    { maxItems: 300000 },
  );

  assert.deepEqual(domains(result.block), [
    "example.co.uk",
    "example.com.hk",
    "foo.github.io",
  ]);
  assert.deepEqual(
    result.folded.map((row) => `${row.domain}>${row.parent}`).sort(),
    ["ads.example.co.uk>example.co.uk", "ads.example.com.hk>example.com.hk", "bar.foo.github.io>foo.github.io"],
  );
});

test("personal source wins attribution over a lower-priority remote", () => {
  const result = compileDomains(
    [
      source({
        id: "personal-block",
        role: "block",
        priority: 90,
        pinned: true,
        text: "tracker.example.com\n",
      }),
      source({
        id: "oisd",
        role: "block",
        priority: 40,
        pinned: false,
        text: "||tracker.example.com^\n||other.example.net^\n",
      }),
    ],
    { maxItems: 300000 },
  );

  const tracker = result.block.find((entry) => entry.domain === "tracker.example.com");
  assert.equal(tracker?.sourceId, "personal-block");
  assert.ok(result.block.some((entry) => entry.domain === "other.example.net"));
});

test("over maxItems: pinned personal stays, remotes drop by priority", () => {
  const result = compileDomains(
    [
      source({
        id: "personal-block",
        role: "block",
        priority: 90,
        pinned: true,
        text: "keep.example.com\n",
      }),
      source({
        id: "high",
        role: "block",
        priority: 50,
        pinned: false,
        text: "high.example.net\n",
      }),
      source({
        id: "low",
        role: "block",
        priority: 10,
        pinned: false,
        text: "low.example.org\n",
      }),
    ],
    { maxItems: 2 },
  );

  assert.deepEqual(domains(result.block), ["high.example.net", "keep.example.com"]);
  assert.deepEqual(result.dropped, [
    { domain: "low.example.org", sourceId: "low", reason: "budget" },
  ]);
});

test("hosts lines and inline comments", () => {
  const result = compileDomains(
    [
      source({
        id: "personal-block",
        role: "block",
        format: "hosts",
        text: "0.0.0.0 ads.example.com # note\n127.0.0.1 localhost\n",
      }),
    ],
    { maxItems: 300000 },
  );

  assert.deepEqual(domains(result.block), ["ads.example.com"]);
});

test("extractHost understands adblock, hosts, and exceptions", () => {
  assert.deepEqual(extractHost("||ads.example.com^", "adblock"), {
    host: "ads.example.com",
    exception: false,
  });
  assert.deepEqual(extractHost("@@||good.example.com^", "adblock"), {
    host: "good.example.com",
    exception: true,
  });
  assert.deepEqual(extractHost("0.0.0.0 ads.example.com", "hosts"), {
    host: "ads.example.com",
    exception: false,
  });
  assert.equal(extractHost("! comment"), null);
});
