import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CF_DEFAULT_429_MS,
  CloudflareApiError,
  cloudflareRetryWaitMs,
  createCfClient,
} from "./cf-client.ts";
import { listsCommand } from "./commands/lists.ts";

const TOKEN = "cfut_test_token_do_not_leak";
const ACCOUNT = "accttest000000000000000000000001";

type MockCall = { method: string; url: string };

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function mockRouter(
  handler: (method: string, url: string) => Response | Promise<Response>,
  calls: MockCall[],
): typeof fetch {
  return (async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    calls.push({ method, url });
    return handler(method, url);
  }) as typeof fetch;
}

function client(fetchFn: typeof fetch, extras?: { sleep?: (ms: number) => Promise<void> }) {
  return createCfClient({
    token: TOKEN,
    accountId: ACCOUNT,
    fetch: fetchFn,
    sleep: extras?.sleep ?? (async () => undefined),
    bucketCapacity: 100,
    refillPerSec: 100,
  });
}

test("HTTP 200 + success:false is an error and redacts the token", async () => {
  const calls: MockCall[] = [];
  const api = client(
    mockRouter(() => {
      return jsonResponse({
        success: false,
        errors: [{ message: `bad token ${TOKEN}` }],
      });
    }, calls),
  );

  await assert.rejects(
    () => api.listLists(),
    (error: unknown) => {
      assert.ok(error instanceof CloudflareApiError);
      assert.equal(error.exitCode, 3);
      assert.match(error.message, /success=false/);
      assert.doesNotMatch(error.message, new RegExp(TOKEN));
      return true;
    },
  );
  assert.equal(calls.length, 1);
});

test("paginates list items until result_info is exhausted", async () => {
  const calls: MockCall[] = [];
  const api = client(
    mockRouter((_method, url) => {
      const page = new URL(url).searchParams.get("page");
      if (page === "1") {
        return jsonResponse({
          success: true,
          result: Array.from({ length: 1000 }, (_, i) => ({ value: `a${i}.example.com` })),
          result_info: { page: 1, per_page: 1000, count: 1000, total_count: 1001 },
        });
      }
      return jsonResponse({
        success: true,
        result: [{ value: "last.example.com" }],
        result_info: { page: 2, per_page: 1000, count: 1, total_count: 1001 },
      });
    }, calls),
  );

  const items = await api.listListItems("list-1");
  assert.equal(items.length, 1001);
  assert.equal(items[1000]?.value, "last.example.com");
  assert.equal(calls.length, 2);
  assert.match(calls[0]?.url ?? "", /page=1/);
  assert.match(calls[1]?.url ?? "", /page=2/);
});

test("429 waits Retry-After, otherwise 120s", async () => {
  const sleeps: number[] = [];
  let hits = 0;
  const api = createCfClient({
    token: TOKEN,
    accountId: ACCOUNT,
    bucketCapacity: 100,
    refillPerSec: 100,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    fetch: mockRouter((_method, _url) => {
      hits += 1;
      if (hits === 1) return jsonResponse({ success: false }, 429, { "retry-after": "2" });
      return jsonResponse({ success: true, result: [], result_info: { page: 1, per_page: 50, total_count: 0 } });
    }, []),
  });
  await api.listLists();
  assert.deepEqual(sleeps, [2000]);

  const retry = new Response("", { status: 429 });
  assert.equal(cloudflareRetryWaitMs(retry), CF_DEFAULT_429_MS);
});

test("token bucket waits when empty", async () => {
  const sleeps: number[] = [];
  let now = 1_000_000;
  const api = createCfClient({
    token: TOKEN,
    accountId: ACCOUNT,
    bucketCapacity: 1,
    refillPerSec: 2,
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
    fetch: mockRouter(
      () => jsonResponse({ success: true, result: [], result_info: { page: 1, per_page: 50, total_count: 0 } }),
      [],
    ),
  });
  await api.listLists();
  await api.listLists();
  assert.ok(sleeps.length >= 1);
  assert.ok(sleeps[0] !== undefined && sleeps[0] > 0);
});

test("ownedLists keeps only gateway-list prefix", async () => {
  const api = client(
    mockRouter(
      () =>
        jsonResponse({
          success: true,
          result: [
            { id: "1", name: "gateway-list:allow", count: 2 },
            { id: "2", name: "human-list", count: 9 },
          ],
          result_info: { page: 1, per_page: 50, total_count: 2 },
        }),
      [],
    ),
  );
  const owned = await api.ownedLists("gateway-list");
  assert.deepEqual(
    owned.map((row) => row.name),
    ["gateway-list:allow"],
  );
});

async function captureLogs(fn: () => Promise<number>): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    const code = await fn();
    return { code, out: lines.join("\n") };
  } finally {
    console.log = orig;
  }
}

test("lists command is read-only and prints owned objects", async () => {
  const methods: string[] = [];
  const dir = await mkdtemp(join(tmpdir(), "gateway-list-lists-"));
  const code = await listsCommand({
    configPath: "config.yaml",
    snapshotsDir: dir,
    loadFile: false,
    env: { CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT },
    sleep: async () => undefined,
    fetch: mockRouter((method, url) => {
      methods.push(`${method} ${url}`);
      if (url.includes("/gateway/rules")) {
        return jsonResponse({
          success: true,
          result: [
            { id: "r1", name: "gateway-list:allow", precedence: 1000, action: "allow" },
            { id: "r2", name: "my-custom-rule", precedence: 50, action: "block" },
          ],
          result_info: { page: 1, per_page: 50, total_count: 2 },
        });
      }
      return jsonResponse({
        success: true,
        result: [{ id: "l1", name: "gateway-list:block", count: 3 }],
        result_info: { page: 1, per_page: 50, total_count: 1 },
      });
    }, []),
  });
  assert.equal(code, 0);
  assert.ok(methods.every((row) => row.startsWith("GET ")));
  assert.equal(
    methods.some((row) => /POST|PUT|PATCH|DELETE/.test(row)),
    false,
  );
});

test("lists command prints other-list item totals and writes account-quota.json", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gateway-list-lists-q-"));
  const { code, out } = await captureLogs(() =>
    listsCommand({
      configPath: "config.yaml",
      snapshotsDir: dir,
      loadFile: false,
      env: { CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT },
      sleep: async () => undefined,
      fetch: mockRouter((method, url) => {
        if (url.includes("/gateway/rules")) {
          return jsonResponse({
            success: true,
            result: [],
            result_info: { page: 1, per_page: 50, total_count: 0 },
          });
        }
        if (/\/gateway\/lists\/[^/?]+/.test(url) && !url.includes("/items")) {
          return jsonResponse({
            success: true,
            result: { id: "h2", name: "mystery", type: "DOMAIN", count: 7 },
          });
        }
        return jsonResponse({
          success: true,
          result: [
            { id: "l1", name: "gateway-list:allow", type: "DOMAIN", count: 2 },
            { id: "h1", name: "corp-ips", type: "IP", count: 40 },
            { id: "h2", name: "mystery", type: "DOMAIN" },
          ],
          result_info: { page: 1, per_page: 50, total_count: 3 },
        });
      }, []),
    }),
  );
  assert.equal(code, 0);
  assert.match(out, /other lists: 2 \(not managed; counted for quota\)/);
  assert.match(out, /corp-ips.*IP.*40 items/);
  assert.match(out, /mystery.*DOMAIN.*7 items/);
  assert.match(out, /items:\s+owned 2 \+ other 47 = 49 \/ 300000/);
  assert.match(out, /slots:\s+1 owned \+ 2 other = 3/);
  assert.doesNotMatch(out, /other lists:.*ignored/);
  const snapshot = JSON.parse(await readFile(join(dir, "account-quota.json"), "utf8"));
  assert.equal(snapshot.otherItems, 47);
  assert.equal(snapshot.otherLists, 2);
});

test("lists command exits 1 without credentials", async () => {
  const code = await listsCommand({
    configPath: "config.yaml",
    loadFile: false,
    env: {},
  });
  assert.equal(code, 1);
});

test("lists command exits 3 on API failure", async () => {
  const code = await listsCommand({
    configPath: "config.yaml",
    loadFile: false,
    env: { CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT },
    sleep: async () => undefined,
    fetch: mockRouter(() => jsonResponse({ success: false, errors: [{ message: "nope" }] }, 200), []),
  });
  assert.equal(code, 3);
});
