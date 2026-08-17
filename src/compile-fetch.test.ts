import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { compileCommand } from "./commands/compile.ts";
import { enumerateDomains } from "./compiler.ts";
import { sha256Hex } from "./source-integrity.ts";
import type { DesiredSnapshot, SourcesSnapshot } from "./types.ts";

function mockFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): typeof fetch {
  return (async (input, init) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return handler(url, init);
  }) as typeof fetch;
}

function baseYaml(allowPath: string, blockPath: string, blockExtras = ""): string {
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
${blockExtras}
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
`;
}

async function setupWorkspace(blockExtras = ""): Promise<{
  root: string;
  configPath: string;
  snapshotsDir: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "gateway-list-p3-"));
  const allowPath = join(root, "allow.txt");
  const blockPath = join(root, "block.txt");
  await writeFile(allowPath, "maps.google.com\n", "utf8");
  await writeFile(blockPath, "evil.example.com\n", "utf8");
  const configPath = join(root, "config.yaml");
  await writeFile(configPath, baseYaml(allowPath, blockPath, blockExtras), "utf8");
  return { root, configPath, snapshotsDir: join(root, "snapshots") };
}

const oisdBlock = `    - id: oisd-small
      url: https://small.oisd.nl/
      format: adblock
      priority: 40
      required: true
`;

const optionalBlock = `    - id: extra
      url: https://example.com/optional.txt
      format: adblock
      priority: 10
      required: false
`;

async function readJson<T>(dir: string, name: string): Promise<T> {
  return JSON.parse(await readFile(join(dir, name), "utf8")) as T;
}

test("compile fetches OISD-shaped adblock and merges with personal", async () => {
  const { configPath, snapshotsDir } = await setupWorkspace(oisdBlock);
  const order: string[] = [];
  const code = await compileCommand({
    configPath,
    snapshotsDir,
    fetch: mockFetch((url) => {
      order.push(url);
      assert.equal(url, "https://small.oisd.nl/");
      return new Response("||ads.example.com^\n||tracker.example.net^\n@@||good.example.com^\n", {
        status: 200,
        headers: { etag: '"v1"' },
      });
    }),
  });
  assert.equal(code, 0);
  assert.deepEqual(order, ["https://small.oisd.nl/"]);

  const desired = await readJson<DesiredSnapshot>(snapshotsDir, "desired.json");
  const sources = await readJson<SourcesSnapshot>(snapshotsDir, "sources.json");
  assert.equal(desired.phase, 3);
  assert.deepEqual(desired.remote.fetched, ["oisd-small"]);
  assert.ok(desired.allow.some((row) => row.domain === "maps.google.com"));
  assert.ok(desired.block.some((row) => row.domain === "evil.example.com"));
  assert.ok(desired.block.some((row) => row.domain === "ads.example.com"));
  assert.ok(desired.block.some((row) => row.domain === "tracker.example.net"));
  assert.equal(
    desired.block.some((row) => row.domain === "good.example.com"),
    false,
  );

  const oisd = sources.sources.find((row) => row.id === "oisd-small");
  assert.equal(oisd?.status, "ok");
  assert.equal(oisd?.etag, '"v1"');
  assert.equal(oisd?.parsedDomains, 2);
  assert.equal(oisd?.sha256?.length, 64);
  assert.equal(oisd?.content, "new");
  const personal = sources.sources.find((row) => row.id === "personal");
  assert.equal(personal?.content, "new");
});

test("required 404 fails and does not write snapshots", async () => {
  const { configPath, snapshotsDir } = await setupWorkspace(oisdBlock);
  await mkdir(snapshotsDir, { recursive: true });
  await writeFile(join(snapshotsDir, "desired.json"), '{"keep":true}\n', "utf8");

  const code = await compileCommand({
    configPath,
    snapshotsDir,
    fetch: mockFetch(() => new Response("missing", { status: 404 })),
  });
  assert.equal(code, 1);
  const raw = await readFile(join(snapshotsDir, "desired.json"), "utf8");
  assert.equal(raw, '{"keep":true}\n');
});

test("required empty parse fails and does not write", async () => {
  const { configPath, snapshotsDir } = await setupWorkspace(oisdBlock);
  const code = await compileCommand({
    configPath,
    snapshotsDir,
    fetch: mockFetch(
      () => new Response("[Adblock Plus]\n! empty\n", { status: 200 }),
    ),
  });
  assert.equal(code, 2);
  await assert.rejects(() => readFile(join(snapshotsDir, "desired.json"), "utf8"));
});

test("optional 404 does not poison the run", async () => {
  const { configPath, snapshotsDir } = await setupWorkspace(oisdBlock + optionalBlock);
  const code = await compileCommand({
    configPath,
    snapshotsDir,
    fetch: mockFetch((url) => {
      if (url.includes("optional")) return new Response("nope", { status: 404 });
      return new Response("||ads.example.com^\n", { status: 200 });
    }),
  });
  assert.equal(code, 0);
  const desired = await readJson<DesiredSnapshot>(snapshotsDir, "desired.json");
  const sources = await readJson<SourcesSnapshot>(snapshotsDir, "sources.json");
  assert.ok(desired.block.some((row) => row.domain === "ads.example.com"));
  assert.equal(desired.remote.fetched.includes("extra"), false);
  const extra = sources.sources.find((row) => row.id === "extra");
  assert.equal(extra?.status, "optional-failed");
  assert.equal(extra?.sha256, null);
  assert.equal(extra?.content, undefined);
});

test("second compile same body records content=unchanged", async () => {
  const { configPath, snapshotsDir } = await setupWorkspace(oisdBlock);
  const body = "||ads.example.com^\n||tracker.example.net^\n";
  const fetchSame = mockFetch(() => new Response(body, { status: 200, headers: { etag: '"v1"' } }));

  assert.equal(await compileCommand({ configPath, snapshotsDir, fetch: fetchSame }), 0);
  const first = await readJson<SourcesSnapshot>(snapshotsDir, "sources.json");
  const firstOisd = first.sources.find((row) => row.id === "oisd-small");
  assert.equal(firstOisd?.content, "new");
  const firstHash = firstOisd?.sha256;
  assert.equal(firstHash?.length, 64);

  const logs: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  try {
    assert.equal(await compileCommand({ configPath, snapshotsDir, fetch: fetchSame }), 0);
  } finally {
    console.log = log;
  }

  const second = await readJson<SourcesSnapshot>(snapshotsDir, "sources.json");
  const oisd = second.sources.find((row) => row.id === "oisd-small");
  const personal = second.sources.find((row) => row.id === "personal");
  assert.equal(oisd?.content, "unchanged");
  assert.equal(oisd?.sha256, firstHash);
  assert.equal(personal?.content, "unchanged");
  assert.ok(logs.some((line) => /source:\s+oisd-small url \S+ unchanged \(/.test(line)));
});

test("second compile different body under shrink threshold records updated", async () => {
  const { configPath, snapshotsDir } = await setupWorkspace(oisdBlock);
  const firstBody = Array.from({ length: 10 }, (_, i) => `||n${i}.example.com^`).join("\n");
  const secondBody = Array.from({ length: 9 }, (_, i) => `||n${i}.example.com^`).join("\n");

  assert.equal(
    await compileCommand({
      configPath,
      snapshotsDir,
      fetch: mockFetch(() => new Response(`${firstBody}\n`, { status: 200 })),
    }),
    0,
  );
  const beforeDesired = await readFile(join(snapshotsDir, "desired.json"), "utf8");

  assert.equal(
    await compileCommand({
      configPath,
      snapshotsDir,
      fetch: mockFetch(() => new Response(`${secondBody}\n`, { status: 200 })),
    }),
    0,
  );

  const sources = await readJson<SourcesSnapshot>(snapshotsDir, "sources.json");
  const oisd = sources.sources.find((row) => row.id === "oisd-small");
  assert.equal(oisd?.content, "updated");
  const afterDesired = await readFile(join(snapshotsDir, "desired.json"), "utf8");
  assert.notEqual(afterDesired, beforeDesired);
});

test("local path hash compare does not need a URL", async () => {
  const { root, configPath, snapshotsDir } = await setupWorkspace();
  const allowPath = join(root, "allow.txt");

  assert.equal(await compileCommand({ configPath, snapshotsDir, env: {} }), 0);
  const first = await readJson<SourcesSnapshot>(snapshotsDir, "sources.json");
  assert.equal(first.sources.find((row) => row.id === "personal")?.content, "new");

  assert.equal(await compileCommand({ configPath, snapshotsDir, env: {} }), 0);
  const second = await readJson<SourcesSnapshot>(snapshotsDir, "sources.json");
  assert.equal(second.sources.find((row) => row.id === "personal")?.content, "unchanged");
  assert.equal(second.sources.find((row) => row.id === "personal-block")?.content, "unchanged");

  await writeFile(allowPath, "maps.google.com\ngithub.com\n", "utf8");
  assert.equal(await compileCommand({ configPath, snapshotsDir, env: {} }), 0);
  const third = await readJson<SourcesSnapshot>(snapshotsDir, "sources.json");
  assert.equal(third.sources.find((row) => row.id === "personal")?.content, "updated");
  assert.equal(third.sources.find((row) => row.id === "personal-block")?.content, "unchanged");
});

test("source shrink vs last sources.json aborts without overwrite", async () => {
  const { configPath, snapshotsDir } = await setupWorkspace(oisdBlock);
  const big = Array.from({ length: 100 }, (_, i) => `||n${i}.example.com^`).join("\n");
  const small = Array.from({ length: 50 }, (_, i) => `||n${i}.example.com^`).join("\n");

  assert.equal(
    await compileCommand({
      configPath,
      snapshotsDir,
      fetch: mockFetch(() => new Response(`${big}\n`, { status: 200 })),
    }),
    0,
  );
  const before = await readFile(join(snapshotsDir, "desired.json"), "utf8");

  assert.equal(
    await compileCommand({
      configPath,
      snapshotsDir,
      fetch: mockFetch(() => new Response(`${small}\n`, { status: 200 })),
    }),
    2,
  );
  const after = await readFile(join(snapshotsDir, "desired.json"), "utf8");
  assert.equal(after, before);
});

test("fetches remotes sequentially", async () => {
  const extra = `    - id: second
      url: https://example.com/second.txt
      format: adblock
      priority: 20
      required: true
`;
  const { configPath, snapshotsDir } = await setupWorkspace(oisdBlock + extra);
  const events: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;

  await compileCommand({
    configPath,
    snapshotsDir,
    fetch: mockFetch(async (url) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      events.push(`start:${url}`);
      await Promise.resolve();
      events.push(`end:${url}`);
      inFlight -= 1;
      return new Response("||one.example.com^\n", { status: 200 });
    }),
  });

  assert.equal(maxInFlight, 1);
  assert.deepEqual(events, [
    "start:https://small.oisd.nl/",
    "end:https://small.oisd.nl/",
    "start:https://example.com/second.txt",
    "end:https://example.com/second.txt",
  ]);
});

test("compile 304 reuses cache and records unchanged", async () => {
  const { configPath, snapshotsDir } = await setupWorkspace(oisdBlock);
  const body = "||ads.example.com^\n||tracker.example.net^\n";
  const matches: Array<string | null> = [];

  assert.equal(
    await compileCommand({
      configPath,
      snapshotsDir,
      fetch: mockFetch(() => new Response(body, { status: 200, headers: { etag: '"v1"' } })),
    }),
    0,
  );
  const cache = await readFile(join(snapshotsDir, "cache", "oisd-small.txt"), "utf8");
  assert.equal(cache, body);

  const logs: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  try {
    assert.equal(
      await compileCommand({
        configPath,
        snapshotsDir,
        fetch: mockFetch((_url, init) => {
          matches.push(new Headers(init?.headers).get("if-none-match"));
          return new Response(null, { status: 304, headers: { etag: '"v1"' } });
        }),
      }),
      0,
    );
  } finally {
    console.log = log;
  }

  assert.deepEqual(matches, ['"v1"']);
  const sources = await readJson<SourcesSnapshot>(snapshotsDir, "sources.json");
  const oisd = sources.sources.find((row) => row.id === "oisd-small");
  assert.equal(oisd?.content, "unchanged");
  assert.equal(oisd?.sha256, sha256Hex(body));
  assert.equal(oisd?.etag, '"v1"');
  assert.ok(logs.some((line) => /oisd-small url \S+ unchanged 304 \(/.test(line)));
  const desired = await readJson<DesiredSnapshot>(snapshotsDir, "desired.json");
  assert.ok(desired.block.some((row) => row.domain === "ads.example.com"));
});

test("compile does not send If-None-Match without a valid cache", async () => {
  const { configPath, snapshotsDir } = await setupWorkspace(oisdBlock);
  const body = "||ads.example.com^\n";
  assert.equal(
    await compileCommand({
      configPath,
      snapshotsDir,
      fetch: mockFetch(() => new Response(body, { status: 200, headers: { etag: '"v1"' } })),
    }),
    0,
  );
  await writeFile(join(snapshotsDir, "cache", "oisd-small.txt"), "tampered\n", "utf8");

  const matches: Array<string | null> = [];
  assert.equal(
    await compileCommand({
      configPath,
      snapshotsDir,
      fetch: mockFetch((_url, init) => {
        matches.push(new Headers(init?.headers).get("if-none-match"));
        return new Response(body, { status: 200, headers: { etag: '"v1"' } });
      }),
    }),
    0,
  );
  assert.deepEqual(matches, [null]);
  const cache = await readFile(join(snapshotsDir, "cache", "oisd-small.txt"), "utf8");
  assert.equal(cache, body);
});

test("enumerateDomains ignores @@ in a block source", () => {
  const domains = enumerateDomains(
    "||ads.example.com^\n@@||good.example.com^\n",
    "adblock",
    "block",
  );
  assert.deepEqual(domains, ["ads.example.com"]);
});
