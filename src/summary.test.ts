import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { summaryCommand } from "./commands/summary.ts";
import { SUMMARY_TOP, renderCompileSummary } from "./summary.ts";
import type { DesiredSnapshot } from "./types.ts";

function desired(allow: string[], block: string[]): DesiredSnapshot {
  return {
    version: 2,
    phase: 3,
    generatedAt: "2026-01-02T00:00:00.000Z",
    note: "t",
    configPath: "config.yaml",
    allow: allow.map((domain) => ({ domain, sourceId: "personal" })),
    block: block.map((domain) => ({ domain, sourceId: "oisd" })),
    folded: [],
    remote: { fetched: ["oisd-small"] },
    counts: { allow: allow.length, block: block.length, folded: 3, dropped: 1 },
  };
}

test("summary without previous treats current domains as added", () => {
  const md = renderCompileSummary({
    current: desired(["maps.google.com"], ["ads.example.com"]),
    maxItems: 300000,
    itemsPerList: 1000,
  });
  assert.match(md, /used: 2 \/ 300000/);
  assert.match(md, /other lists: unknown/);
  assert.match(md, /no previous snapshot/);
  assert.match(md, /`maps\.google\.com`/);
  assert.match(md, /`ads\.example\.com`/);
  assert.match(md, /### Removed/);
});

test("summary vs previous lists added and removed top 50", () => {
  const previous = desired(["old.example.com"], ["gone.example.com"]);
  const added = Array.from({ length: 60 }, (_, i) => `new${i}.example.com`);
  const md = renderCompileSummary({
    current: desired(["maps.google.com"], added),
    previous,
    maxItems: 300000,
    itemsPerList: 1000,
    sources: {
      version: 2,
      phase: 3,
      generatedAt: "2026-01-02T00:00:00.000Z",
      sources: [
        {
          id: "oisd-small",
          origin: "url",
          url: "https://small.oisd.nl/",
          etag: '"x"',
          sha256: "abc",
          lineCount: 10,
          parsedDomains: 8,
          fetchedAt: "2026-01-02T00:00:00.000Z",
          status: "ok",
          content: "unchanged",
        },
      ],
    },
    dropped: {
      version: 2,
      phase: 3,
      generatedAt: "2026-01-02T00:00:00.000Z",
      dropped: [{ domain: "x.com", sourceId: "oisd", reason: "budget" }],
    },
  });
  assert.match(md, /allow \+1 \/ -1/);
  assert.match(md, /block \+60 \/ -1/);
  assert.match(md, /oisd-small/);
  assert.match(md, /\| id \| origin \| status \| content \| lines \| domains \| location \|/);
  assert.match(md, /\| oisd-small \| url \| ok \| unchanged \|/);
  assert.match(md, /dropped: 1/);
  assert.doesNotMatch(md, /Suggested allow/);
  assert.match(md, /… 11 more/);
  assert.equal((md.match(/`new\d+\.example\.com`/g) ?? []).length, SUMMARY_TOP - 1);
  assert.match(md, /`gone\.example\.com`/);
  assert.doesNotMatch(md, /`new59\.example\.com`/);
});

test("summary command writes summary.md and optional GitHub summary file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gateway-list-sum-"));
  await mkdir(join(dir, "snapshots"), { recursive: true });
  await writeFile(
    join(dir, "snapshots", "desired.json"),
    `${JSON.stringify(desired(["a.example.com"], ["b.example.com"]))}\n`,
    "utf8",
  );
  await writeFile(
    join(dir, "config.yaml"),
    `plan:
  max_items: 300000
  items_per_list: 1000
  list_name_prefix: gateway-list
sources:
  allow:
    - id: personal
      path: ${join(dir, "allow.txt")}
      priority: 100
      required: true
  block:
    - id: personal-block
      path: ${join(dir, "block.txt")}
      priority: 90
      required: true
safety:
  abort_if_source_shrinks_pct: 40
  abort_if_allowlist_shrinks: 10
  abort_if_adds_over: 50000
  require_review_if_removes_over: 1000
policies:
  allow:
    name: gateway-list:allow
    precedence: 1000
  security:
    name: gateway-list:security
    precedence: 2000
    enabled: true
  block:
    name: gateway-list:block
    precedence: 3000
`,
    "utf8",
  );
  await writeFile(join(dir, "allow.txt"), "\n", "utf8");
  await writeFile(join(dir, "block.txt"), "\n", "utf8");
  const gh = join(dir, "github-summary.md");
  const code = await summaryCommand({
    configPath: join(dir, "config.yaml"),
    snapshotsDir: join(dir, "snapshots"),
    githubSummaryPath: gh,
  });
  assert.equal(code, 0);
  const written = await readFile(join(dir, "snapshots", "summary.md"), "utf8");
  const step = await readFile(gh, "utf8");
  assert.match(written, /used: 2 \/ 300000/);
  assert.match(written, /other lists: unknown/);
  assert.equal(step, written);
});

test("summary with account-quota uses compiled + other, not compiled alone", () => {
  const other = Array.from({ length: 88 }, (_, i) => ({
    id: `h${i}`,
    name: `human-${i}`,
    type: i === 0 ? "IP" : "DOMAIN",
    count: 10,
  }));
  const md = renderCompileSummary({
    current: desired(["maps.google.com"], ["ads.example.com"]),
    maxItems: 300000,
    itemsPerList: 1000,
    accountQuota: {
      version: 2,
      phase: 10,
      fetchedAt: "2026-01-02T00:00:00.000Z",
      prefix: "gateway-list",
      ownedLists: 1,
      otherLists: 88,
      ownedItems: 2,
      otherItems: 880,
      accountItems: 882,
      unknownCounts: [],
      owned: [{ id: "o1", name: "gateway-list:allow", type: "DOMAIN", count: 2 }],
      other,
    },
  });
  assert.match(md, /compiled: 2/);
  assert.match(md, /other lists: 880 items \/ 88 lists/);
  assert.match(md, /account: 882 \/ 300000 \(projected if this desired is applied\)/);
  assert.match(md, /list slots: 1 needed \+ 88 other = 89/);
  assert.doesNotMatch(md, /used: 2 \/ 300000/);
});

test("summary includes suggested allow from Gateway logs", () => {
  const md = renderCompileSummary({
    current: desired(["maps.google.com"], ["ads.example.com"]),
    maxItems: 300000,
    itemsPerList: 1000,
    suggested: {
      version: 2,
      phase: 9,
      generatedAt: "2026-08-15T00:00:00.000Z",
      dataset: "gatewayResolverQueriesAdaptiveGroups",
      window: {
        start: "2026-08-08T00:00:00.000Z",
        end: "2026-08-15T00:00:00.000Z",
      },
      status: "ok",
      blocked: [{ domain: "ads.example.com", count: 20, decisions: ["blockedByCategory"] }],
      suggested: [{ domain: "ads.example.com", count: 20, decisions: ["blockedByCategory"] }],
      skipped: [
        { domain: "api.github.com", count: 4, decisions: ["blocked"], reason: "already-allow" },
      ],
    },
  });
  assert.match(md, /## Suggested allow \(Gateway DNS\)/);
  assert.match(md, /`ads\.example\.com` \(20\)/);
  assert.match(md, /skipped already-allow: 1/);
  assert.match(md, /Never auto-merged/);
});
