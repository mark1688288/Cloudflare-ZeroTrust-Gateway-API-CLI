import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { createCfClient } from "./cf-client.ts";
import { assertOwnedName, createGatewayList, patchGatewayList } from "./cf-write.ts";
import { repoRoot } from "./paths.ts";

const TOKEN = "cfut_test_token_do_not_leak";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

test("assertOwnedName rejects names outside the prefix", () => {
  assert.doesNotThrow(() => assertOwnedName("gateway-list:allow", "gateway-list"));
  assert.throws(
    () => assertOwnedName("CGPS List 1", "gateway-list"),
    /refusing to mutate/,
  );
});

test("createGatewayList does not call the API for a foreign name", async () => {
  let calls = 0;
  const client = createCfClient({
    token: TOKEN,
    accountId: "acct",
    sleep: async () => undefined,
    fetch: (async () => {
      calls += 1;
      return jsonResponse({ success: true, result: {} });
    }) as typeof fetch,
  });
  await assert.rejects(
    () => createGatewayList(client, "gateway-list", { name: "human-allow" }),
    /refusing to mutate/,
  );
  assert.equal(calls, 0);
});

test("patchGatewayList GETs then refuses a foreign list", async () => {
  const methods: string[] = [];
  const client = createCfClient({
    token: TOKEN,
    accountId: "acct",
    sleep: async () => undefined,
    bucketCapacity: 100,
    refillPerSec: 100,
    fetch: (async (_input, init) => {
      methods.push(init?.method ?? "GET");
      return jsonResponse({
        success: true,
        result: { id: "x", name: "someone-else" },
      });
    }) as typeof fetch,
  });
  await assert.rejects(
    () => patchGatewayList(client, "gateway-list", { id: "x", append: [{ value: "a.com" }] }),
    /refusing to mutate/,
  );
  assert.deepEqual(methods, ["GET"]);
});

test("compile / diff / why / lists / cli do not import cf-write", () => {
  const files = [
    "src/commands/compile.ts",
    "src/commands/diff.ts",
    "src/commands/why.ts",
    "src/commands/lists.ts",
    "src/commands/suggested.ts",
    "src/cli.ts",
  ];
  for (const file of files) {
    const text = readFileSync(resolve(repoRoot, file), "utf8");
    assert.doesNotMatch(text, /cf-write/, file);
  }
});
