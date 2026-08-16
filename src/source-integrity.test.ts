import assert from "node:assert/strict";
import { test } from "node:test";
import { countLines, sha256Hex, sourceContent, sourceShrank } from "./source-integrity.ts";
import type { SourceRecord } from "./types.ts";

function ok(lineCount: number): SourceRecord {
  return {
    id: "oisd-small",
    origin: "url",
    url: "https://small.oisd.nl/",
    etag: '"x"',
    sha256: "abc",
    lineCount,
    parsedDomains: lineCount,
    fetchedAt: "2026-01-01T00:00:00.000Z",
    status: "ok",
  };
}

test("countLines ignores a trailing newline", () => {
  assert.equal(countLines(""), 0);
  assert.equal(countLines("a\nb\n"), 2);
  assert.equal(countLines("a\nb"), 2);
});

test("sha256Hex is stable", () => {
  const hex = sha256Hex("||ads.example.com^\n");
  assert.equal(hex.length, 64);
  assert.equal(sha256Hex("||ads.example.com^\n"), hex);
  assert.notEqual(sha256Hex("a"), sha256Hex("b"));
});

test("sourceContent compares usable previous sha256 only", () => {
  const same = sha256Hex("||ads.example.com^\n");
  const other = sha256Hex("||other.example.com^\n");
  assert.equal(sourceContent(undefined, same), "new");
  assert.equal(sourceContent({ ...ok(1), sha256: null }, same), "new");
  assert.equal(sourceContent({ ...ok(1), status: "optional-failed", sha256: same }, same), "new");
  assert.equal(sourceContent({ ...ok(1), sha256: "abc" }, same), "new");
  assert.equal(sourceContent({ ...ok(1), sha256: same }, same), "unchanged");
  assert.equal(sourceContent({ ...ok(1), sha256: same.toUpperCase() }, same), "unchanged");
  assert.equal(sourceContent({ ...ok(1), sha256: other }, same), "updated");
});

test("sourceShrank trips at abort_if_source_shrinks_pct", () => {
  assert.equal(sourceShrank(ok(100), 60, 40).shrank, true);
  assert.equal(sourceShrank(ok(100), 61, 40).shrank, false);
  assert.equal(sourceShrank(ok(100), 100, 40).shrank, false);
  assert.equal(sourceShrank(undefined, 1, 40).shrank, false);
  assert.equal(sourceShrank({ ...ok(100), status: "optional-failed" }, 1, 40).shrank, false);
});
