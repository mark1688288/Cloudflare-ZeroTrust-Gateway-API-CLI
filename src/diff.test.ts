import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { diffCommand } from "./commands/diff.ts";
import {
  diffDomainSets,
  hasDrift,
  isAllowListName,
  isBlockListName,
} from "./domain-diff.ts";
import type { DesiredSnapshot, DiffSnapshot } from "./types.ts";

const TOKEN = "cfut_test_token_do_not_leak";
const ACCOUNT = "accttest000000000000000000000001";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function mockRouter(
  handler: (method: string, url: string) => Response,
  methods: string[],
): typeof fetch {
  return (async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    methods.push(`${method} ${url}`);
    return handler(method, url);
  }) as typeof fetch;
}

function desiredFixture(over: Partial<DesiredSnapshot> = {}): DesiredSnapshot {
  return {
    version: 2,
    phase: 3,
    generatedAt: "2026-01-01T00:00:00.000Z",
    note: "test",
    configPath: "config.yaml",
    allow: [{ domain: "maps.google.com", sourceId: "personal" }],
    block: [
      { domain: "ads.example.com", sourceId: "oisd-small" },
      { domain: "tracker.example.net", sourceId: "oisd-small" },
    ],
    folded: [],
    remote: { fetched: ["oisd-small"] },
    counts: { allow: 1, block: 2, folded: 0, dropped: 0 },
    ...over,
  };
}

async function setup(desired: DesiredSnapshot): Promise<{ dir: string; configPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), "gateway-list-diff-"));
  await mkdir(join(dir, "snapshots"), { recursive: true });
  await writeFile(join(dir, "snapshots", "desired.json"), `${JSON.stringify(desired)}\n`, "utf8");
  const configPath = join(dir, "config.yaml");
  await writeFile(
    configPath,
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
  asn:
    - id: geolite2-asn
      url: https://git.io/GeoLite2-ASN.mmdb
      format: mmdb
      priority: 20
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
  return { dir, configPath };
}

test("list name classification", () => {
  assert.equal(isAllowListName("gateway-list:allow", "gateway-list"), true);
  assert.equal(isAllowListName("gateway-list:allow-1", "gateway-list"), true);
  assert.equal(isBlockListName("gateway-list:block", "gateway-list"), true);
  assert.equal(isBlockListName("gateway-list:block-2", "gateway-list"), true);
  assert.equal(isAllowListName("gateway-list:block", "gateway-list"), false);
  assert.equal(isBlockListName("human-list", "gateway-list"), false);
  assert.equal(isBlockListName("gateway-list:security", "gateway-list"), false);
});

test("diffDomainSets counts add/remove/unchanged", () => {
  const side = diffDomainSets(["a.com", "b.com"], ["b.com", "c.com"]);
  assert.deepEqual(side.toAdd, ["a.com"]);
  assert.deepEqual(side.toRemove, ["c.com"]);
  assert.deepEqual(side.unchanged, ["b.com"]);
  assert.equal(hasDrift(side, diffDomainSets([], [])), true);
  assert.equal(hasDrift(diffDomainSets(["a.com"], ["a.com"]), diffDomainSets([], [])), false);
});

test("diff against an empty account reports all desired domains as adds", async () => {
  const { dir, configPath } = await setup(desiredFixture());
  const methods: string[] = [];
  const code = await diffCommand({
    configPath,
    snapshotsDir: join(dir, "snapshots"),
    loadFile: false,
    env: { CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT },
    sleep: async () => undefined,
    fetch: mockRouter(() => {
      return jsonResponse({
        success: true,
        result: [],
        result_info: { page: 1, per_page: 50, total_count: 0 },
      });
    }, methods),
  });
  assert.equal(code, 0);
  assert.ok(methods.every((row) => row.startsWith("GET ")));
  const diff = JSON.parse(await readFile(join(dir, "snapshots", "diff.json"), "utf8")) as DiffSnapshot;
  assert.equal(diff.drift, true);
  assert.deepEqual(diff.allow.toAdd, ["maps.google.com"]);
  assert.deepEqual(diff.block.toAdd, ["ads.example.com", "tracker.example.net"]);
  assert.equal(diff.counts.toRemove, 0);
  assert.equal(diff.counts.toAdd, 3);
});

test("diff after a matching apply reports zero drift", async () => {
  const { dir, configPath } = await setup(desiredFixture());
  const methods: string[] = [];
  const code = await diffCommand({
    configPath,
    snapshotsDir: join(dir, "snapshots"),
    loadFile: false,
    env: { CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT },
    sleep: async () => undefined,
    fetch: mockRouter((_method, url) => {
      if (url.includes("/items")) {
        const values = url.includes("allow-id")
          ? [{ value: "maps.google.com" }]
          : [{ value: "ads.example.com" }, { value: "TRACKER.example.net" }];
        return jsonResponse({
          success: true,
          result: values,
          result_info: { page: 1, per_page: 1000, total_count: values.length },
        });
      }
      return jsonResponse({
        success: true,
        result: [
          { id: "allow-id", name: "gateway-list:allow", count: 1 },
          { id: "block-id", name: "gateway-list:block", count: 2 },
          { id: "human", name: "my-hand-list", count: 99 },
        ],
        result_info: { page: 1, per_page: 50, total_count: 3 },
      });
    }, methods),
  });
  assert.equal(code, 0);
  assert.ok(methods.every((row) => row.startsWith("GET ")));
  assert.equal(
    methods.some((row) => row.includes("human") || /POST|PATCH|PUT|DELETE/.test(row)),
    false,
  );
  const diff = JSON.parse(await readFile(join(dir, "snapshots", "diff.json"), "utf8")) as DiffSnapshot;
  assert.equal(diff.drift, false);
  assert.equal(diff.counts.toAdd, 0);
  assert.equal(diff.counts.toRemove, 0);
  assert.equal(diff.counts.unchanged, 3);
});

test("diff missing snapshot exits 1", async () => {
  const { dir, configPath } = await setup(desiredFixture());
  const code = await diffCommand({
    configPath,
    snapshotsDir: join(dir, "missing-snaps"),
    loadFile: false,
    env: { CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT },
  });
  assert.equal(code, 1);
});

test("diff API failure exits 3", async () => {
  const { dir, configPath } = await setup(desiredFixture());
  const code = await diffCommand({
    configPath,
    snapshotsDir: join(dir, "snapshots"),
    loadFile: false,
    env: { CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT },
    sleep: async () => undefined,
    fetch: mockRouter(() => jsonResponse({ success: false, errors: [{ message: "nope" }] }), []),
  });
  assert.equal(code, 3);
});
