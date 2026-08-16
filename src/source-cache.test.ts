import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  cacheFileName,
  oneEtag,
  readValidSourceCache,
  sourceCachePath,
  writeSourceCache,
} from "./source-cache.ts";
import { sha256Hex } from "./source-integrity.ts";

test("cacheFileName rejects path traversal", () => {
  assert.equal(cacheFileName("oisd-small"), "oisd-small.txt");
  assert.equal(cacheFileName("../etc/passwd"), null);
  assert.equal(cacheFileName("a/b"), null);
  assert.equal(sourceCachePath("/tmp/s", "oisd-small"), join("/tmp/s", "cache", "oisd-small.txt"));
});

test("oneEtag rejects empty and comma lists", () => {
  assert.equal(oneEtag('"abc"'), '"abc"');
  assert.equal(oneEtag(null), undefined);
  assert.equal(oneEtag(""), undefined);
  assert.equal(oneEtag('"a", "b"'), undefined);
});

test("readValidSourceCache requires matching sha256", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gateway-list-cache-"));
  const text = "||ads.example.com^\n";
  await writeSourceCache(dir, "oisd-small", text);
  assert.equal(await readValidSourceCache(dir, "oisd-small", sha256Hex(text)), text);
  assert.equal(await readValidSourceCache(dir, "oisd-small", sha256Hex("other")), null);
  assert.equal(await readValidSourceCache(dir, "missing", sha256Hex(text)), null);
});

test("corrupt cache file is a miss", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gateway-list-cache2-"));
  await writeSourceCache(dir, "oisd-small", "||ads.example.com^\n");
  await writeFile(join(dir, "cache", "oisd-small.txt"), "tampered\n", "utf8");
  assert.equal(await readValidSourceCache(dir, "oisd-small", sha256Hex("||ads.example.com^\n")), null);
});
