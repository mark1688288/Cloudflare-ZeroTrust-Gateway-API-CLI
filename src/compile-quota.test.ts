import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { compileCommand } from "./commands/compile.ts";
import type { DesiredSnapshot, DroppedSnapshot } from "./types.ts";

const TOKEN = "cfut_test_token_do_not_leak";
const ACCOUNT = "accttest000000000000000000000001";

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function yaml(allowPath: string, blockPath: string, maxItems = 4): string {
  return `plan:
  max_items: ${maxItems}
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
    - id: extra
      url: https://example.com/block.txt
      format: adblock
      priority: 10
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

async function workspace(maxItems = 4): Promise<{
  configPath: string;
  snapshotsDir: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "gateway-list-cq-"));
  const allowPath = join(root, "allow.txt");
  const blockPath = join(root, "block.txt");
  await writeFile(allowPath, "keep.example.com\n", "utf8");
  await writeFile(blockPath, "pin.example.com\n", "utf8");
  const configPath = join(root, "config.yaml");
  await writeFile(configPath, yaml(allowPath, blockPath, maxItems), "utf8");
  return { configPath, snapshotsDir: join(root, "snapshots") };
}

function cfAndSourceFetch(otherItems: number): typeof fetch {
  return (async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("example.com/block.txt")) {
      return new Response("||a.example.com^\n||b.example.com^\n||c.example.com^\n", { status: 200 });
    }
    if (url.includes("/gateway/rules")) {
      return json({ success: true, result: [], result_info: { page: 1, per_page: 50, total_count: 0 } });
    }
    if (url.includes("/gateway/lists")) {
      return json({
        success: true,
        result: [{ id: "h1", name: "corp-ips", type: "IP", count: otherItems }],
        result_info: { page: 1, per_page: 50, total_count: 1 },
      });
    }
    return new Response("nope", { status: 404 });
  }) as typeof fetch;
}

test("compile without credentials still writes desired.json", async () => {
  const { configPath, snapshotsDir } = await workspace(300000);
  const code = await compileCommand({
    configPath,
    snapshotsDir,
    loadFile: false,
    env: {},
    fetch: cfAndSourceFetch(0),
  });
  assert.equal(code, 0);
  const desired = JSON.parse(await readFile(join(snapshotsDir, "desired.json"), "utf8")) as DesiredSnapshot;
  assert.ok(desired.allow.length + desired.block.length >= 2);
  await assert.rejects(() => readFile(join(snapshotsDir, "account-quota.json"), "utf8"));
});

test("compile live other_items shrinks budget and drops overflow", async () => {
  const { configPath, snapshotsDir } = await workspace(4);
  const code = await compileCommand({
    configPath,
    snapshotsDir,
    loadFile: false,
    env: { CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT },
    sleep: async () => undefined,
    fetch: cfAndSourceFetch(2),
  });
  assert.equal(code, 0);
  const desired = JSON.parse(await readFile(join(snapshotsDir, "desired.json"), "utf8")) as DesiredSnapshot;
  const dropped = JSON.parse(await readFile(join(snapshotsDir, "dropped.json"), "utf8")) as DroppedSnapshot;
  const quota = JSON.parse(await readFile(join(snapshotsDir, "account-quota.json"), "utf8"));
  // leftover = 4 - 2 = 2; personal allow + personal block are pinned; remotes drop
  assert.equal(desired.allow.length + desired.block.length, 2);
  assert.ok(dropped.dropped.length >= 1);
  assert.ok(dropped.dropped.every((row) => row.reason === "budget"));
  assert.equal(quota.otherItems, 2);
});

test("compile uses previous account-quota.json when credentials are missing", async () => {
  const { configPath, snapshotsDir } = await workspace(4);
  await mkdir(snapshotsDir, { recursive: true });
  await writeFile(
    join(snapshotsDir, "account-quota.json"),
    `${JSON.stringify({
      version: 2,
      phase: 10,
      fetchedAt: "2026-01-01T00:00:00.000Z",
      prefix: "gateway-list",
      ownedLists: 0,
      otherLists: 1,
      ownedItems: 0,
      otherItems: 3,
      accountItems: 3,
      unknownCounts: [],
      owned: [],
      other: [{ id: "h1", name: "corp-ips", type: "IP", count: 3 }],
    })}\n`,
    "utf8",
  );
  const code = await compileCommand({
    configPath,
    snapshotsDir,
    loadFile: false,
    env: {},
    fetch: cfAndSourceFetch(0),
  });
  assert.equal(code, 0);
  const desired = JSON.parse(await readFile(join(snapshotsDir, "desired.json"), "utf8")) as DesiredSnapshot;
  const dropped = JSON.parse(await readFile(join(snapshotsDir, "dropped.json"), "utf8")) as DroppedSnapshot;
  // leftover = 4 - 3 = 1
  assert.equal(desired.allow.length + desired.block.length, 1);
  assert.ok(dropped.dropped.length >= 1);
});

test("compile live-read failure does not fail the run", async () => {
  const { configPath, snapshotsDir } = await workspace(300000);
  const code = await compileCommand({
    configPath,
    snapshotsDir,
    loadFile: false,
    env: { CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT },
    sleep: async () => undefined,
    fetch: (async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("example.com/block.txt")) {
        return new Response("||a.example.com^\n", { status: 200 });
      }
      return json({ success: false, errors: [{ message: "nope" }] });
    }) as typeof fetch,
  });
  assert.equal(code, 0);
  await readFile(join(snapshotsDir, "desired.json"), "utf8");
});
