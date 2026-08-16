import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CloudflareApiError, createCfClient } from "./cf-client.ts";
import { suggestedCommand } from "./commands/suggested.ts";
import {
  BLOCKED_DNS_QUERY,
  coveredByAllow,
  fetchBlockedDns,
  isAnalyticsUnavailable,
  isBlockedDecision,
  parseResolverGroups,
  pickSuggestions,
  rankBlockedDomains,
  renderSuggestedTxt,
  unreverseQueryName,
} from "./gateway-logs.ts";
import { SUGGESTED_SNAPSHOT_PHASE } from "./types.ts";

const TOKEN = "cfut_test_token_do_not_leak";
const ACCOUNT = "accttest000000000000000000000001";

function graphqlData(groups: unknown[]): unknown {
  return {
    viewer: {
      accounts: [{ gatewayResolverQueriesAdaptiveGroups: groups }],
    },
  };
}

test("unreverseQueryName flips labels and strips a trailing dot", () => {
  assert.equal(unreverseQueryName("com.example.ads"), "ads.example.com");
  assert.equal(unreverseQueryName("com.example.ads."), "ads.example.com");
  assert.equal(unreverseQueryName("com"), null);
  assert.equal(unreverseQueryName(""), null);
});

test("isBlockedDecision is prefix-based", () => {
  assert.equal(isBlockedDecision("blockedByCategory"), true);
  assert.equal(isBlockedDecision("blockedRule"), true);
  assert.equal(isBlockedDecision("allowedOnNoPolicyMatch"), false);
  assert.equal(isBlockedDecision("overrideApplied"), false);
  assert.equal(isBlockedDecision(9), true);
  assert.equal(isBlockedDecision(5), false);
  assert.equal(isBlockedDecision(10), false);
  assert.equal(isBlockedDecision("9"), true);
});

test("coveredByAllow treats personal allow as a suffix gate", () => {
  assert.equal(coveredByAllow("github.com", ["github.com"]), true);
  assert.equal(coveredByAllow("api.github.com", ["github.com"]), true);
  assert.equal(coveredByAllow("notgithub.com", ["github.com"]), false);
});

test("rankBlockedDomains merges decisions and drops allowed/invalid rows", () => {
  const ranked = rankBlockedDomains([
    { queryNameReversed: "com.example.ads", resolverDecision: "blockedByCategory", count: 10 },
    { queryNameReversed: "com.example.ads", resolverDecision: "blockedRule", count: 3 },
    { queryNameReversed: "com.example.ok", resolverDecision: "allowedOnNoPolicyMatch", count: 99 },
    { queryNameReversed: "com", resolverDecision: "blocked", count: 5 },
  ]);
  assert.deepEqual(ranked, [
    {
      domain: "ads.example.com",
      count: 13,
      decisions: ["blockedByCategory", "blockedRule"],
    },
  ]);
});

test("pickSuggestions skips personal allow (incl. children) and personal block", () => {
  const ranked = rankBlockedDomains([
    { queryNameReversed: "com.example.ads", resolverDecision: "blocked", count: 20 },
    { queryNameReversed: "com.github.api", resolverDecision: "blocked", count: 15 },
    { queryNameReversed: "com.evil.tracker", resolverDecision: "blocked", count: 9 },
  ]);
  const { suggested, skipped } = pickSuggestions(ranked, ["github.com"], ["tracker.evil.com"]);
  assert.deepEqual(
    suggested.map((row) => row.domain),
    ["ads.example.com"],
  );
  assert.equal(skipped.find((row) => row.domain === "api.github.com")?.reason, "already-allow");
  assert.equal(skipped.find((row) => row.domain === "tracker.evil.com")?.reason, "personal-block");
});

test("parseResolverGroups reads the official GraphQL shape", () => {
  const rows = parseResolverGroups(
    graphqlData([
      {
        count: 4,
        dimensions: { queryNameReversed: "com.example.ads", resolverDecision: "blockedByCategory" },
      },
    ]),
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.count, 4);
});

test("parseResolverGroups accepts live numeric resolverDecision", () => {
  const rows = parseResolverGroups(
    graphqlData([
      {
        count: 380,
        dimensions: { queryNameReversed: "com.google.clients6.ogads-pa", resolverDecision: 9 },
      },
      {
        count: 3190,
        dimensions: { queryNameReversed: "com.cloudflare.time", resolverDecision: 10 },
      },
    ]),
  );
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.resolverDecision, "blockedRule");
  assert.equal(rows[1]?.resolverDecision, "allowedRule");
  const ranked = rankBlockedDomains(rows);
  assert.deepEqual(
    ranked.map((row) => row.domain),
    ["ogads-pa.clients6.google.com"],
  );
});

test("isAnalyticsUnavailable treats 403 and missing dataset as expected", () => {
  assert.equal(isAnalyticsUnavailable(new CloudflareApiError("nope", 403)), true);
  assert.equal(
    isAnalyticsUnavailable(new CloudflareApiError("Cannot query field gatewayResolverQueriesAdaptiveGroups")),
    true,
  );
  assert.equal(isAnalyticsUnavailable(new CloudflareApiError("HTTP 500", 500)), false);
});

test("fetchBlockedDns posts to /graphql and ranks the body", async () => {
  const calls: { url: string; body: unknown }[] = [];
  const client = createCfClient({
    token: TOKEN,
    accountId: ACCOUNT,
    sleep: async () => undefined,
    fetch: (async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
      return new Response(
        JSON.stringify({
          data: graphqlData([
            {
              count: 7,
              dimensions: {
                queryNameReversed: "com.example.ads",
                resolverDecision: "blockedByCategory",
              },
            },
          ]),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch,
  });

  const fetched = await fetchBlockedDns(client, {
    now: new Date("2026-08-15T03:00:00.000Z"),
    windowDays: 7,
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0]?.url ?? "", /\/client\/v4\/graphql$/);
  assert.doesNotMatch(calls[0]?.url ?? "", /\/accounts\//);
  const body = calls[0]?.body as { query: string; variables: { accountTag: string } };
  assert.match(body.query, /gatewayResolverQueriesAdaptiveGroups/);
  assert.equal(body.query, BLOCKED_DNS_QUERY);
  assert.equal(body.variables.accountTag, ACCOUNT);
  assert.equal(fetched.rows[0]?.count, 7);
});

function yaml(allowPath: string, blockPath: string): string {
  return `plan:
  max_items: 300000
  items_per_list: 1000
  list_name_prefix: gateway-list
sources:
  allow:
    - id: personal
      path: ${allowPath}
      priority: 100
      required: true
  block:
    - id: personal-block
      path: ${blockPath}
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
`;
}

test("suggested writes review file and does not touch personal.txt", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-list-sug-"));
  const allowPath = join(root, "allow.txt");
  const blockPath = join(root, "block.txt");
  const personalBefore = "github.com\n";
  await writeFile(allowPath, personalBefore, "utf8");
  await writeFile(blockPath, "tracker.evil.com\n", "utf8");
  const configPath = join(root, "config.yaml");
  await writeFile(configPath, yaml(allowPath, blockPath), "utf8");
  const suggestedPath = join(root, "allowlist", "suggested.txt");
  const snapshotsDir = join(root, "snapshots");

  const code = await suggestedCommand({
    configPath,
    snapshotsDir,
    suggestedPath,
    env: { CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT },
    loadFile: false,
    now: new Date("2026-08-15T03:00:00.000Z"),
    sleep: async () => undefined,
    fetch: (async () =>
      new Response(
        JSON.stringify({
          data: graphqlData([
            {
              count: 20,
              dimensions: {
                queryNameReversed: "com.example.ads",
                resolverDecision: "blockedByCategory",
              },
            },
            {
              count: 15,
              dimensions: {
                queryNameReversed: "com.github.api",
                resolverDecision: "blockedByCategory",
              },
            },
          ]),
        }),
        { status: 200 },
      )) as typeof fetch,
  });
  assert.equal(code, 0);
  assert.equal(await readFile(allowPath, "utf8"), personalBefore);
  const txt = await readFile(suggestedPath, "utf8");
  assert.match(txt, /never auto-merged/i);
  assert.match(txt, /ads\.example\.com\s+# 20/);
  assert.doesNotMatch(txt, /api\.github\.com/);
  const snap = JSON.parse(await readFile(join(snapshotsDir, "suggested.json"), "utf8")) as {
    phase: number;
    suggested: { domain: string }[];
  };
  assert.equal(snap.phase, SUGGESTED_SNAPSHOT_PHASE);
  assert.deepEqual(
    snap.suggested.map((row) => row.domain),
    ["ads.example.com"],
  );
});

test("suggested 403 is unavailable and leaves suggested.txt plus personal.txt", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-list-sug403-"));
  const allowPath = join(root, "allow.txt");
  const blockPath = join(root, "block.txt");
  await writeFile(allowPath, "github.com\n", "utf8");
  await writeFile(blockPath, "\n", "utf8");
  const configPath = join(root, "config.yaml");
  await writeFile(configPath, yaml(allowPath, blockPath), "utf8");
  const suggestedPath = join(root, "allowlist", "suggested.txt");
  await mkdir(join(root, "allowlist"), { recursive: true });
  await writeFile(suggestedPath, "# keep me\n", "utf8");
  const snapshotsDir = join(root, "snapshots");

  const code = await suggestedCommand({
    configPath,
    snapshotsDir,
    suggestedPath,
    env: { CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT },
    loadFile: false,
    now: new Date("2026-08-15T03:00:00.000Z"),
    sleep: async () => undefined,
    fetch: (async () =>
      new Response(JSON.stringify({ errors: [{ message: "forbidden" }] }), { status: 403 })) as typeof fetch,
  });
  assert.equal(code, 0);
  assert.equal(await readFile(allowPath, "utf8"), "github.com\n");
  assert.equal(await readFile(suggestedPath, "utf8"), "# keep me\n");
  const snap = JSON.parse(await readFile(join(snapshotsDir, "suggested.json"), "utf8")) as {
    status: string;
  };
  assert.equal(snap.status, "unavailable");
});

test("suggested without credentials exits 1", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-list-sug1-"));
  const allowPath = join(root, "allow.txt");
  const blockPath = join(root, "block.txt");
  await writeFile(allowPath, "github.com\n", "utf8");
  await writeFile(blockPath, "\n", "utf8");
  const configPath = join(root, "config.yaml");
  await writeFile(configPath, yaml(allowPath, blockPath), "utf8");
  const code = await suggestedCommand({
    configPath,
    snapshotsDir: join(root, "snapshots"),
    suggestedPath: join(root, "suggested.txt"),
    env: {},
    loadFile: false,
  });
  assert.equal(code, 1);
});

test("renderSuggestedTxt never emits a merge instruction", () => {
  const txt = renderSuggestedTxt({
    version: 2,
    phase: 9,
    generatedAt: "2026-08-15T00:00:00.000Z",
    dataset: "gatewayResolverQueriesAdaptiveGroups",
    window: { start: "a", end: "b" },
    status: "ok",
    blocked: [],
    suggested: [{ domain: "ads.example.com", count: 3, decisions: ["blocked"] }],
    skipped: [],
  });
  assert.match(txt, /never auto-merged/i);
  assert.match(txt, /ads\.example\.com/);
});
