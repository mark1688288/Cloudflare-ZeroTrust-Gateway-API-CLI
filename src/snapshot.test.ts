import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadDesiredSnapshot, parseDesiredSnapshot, SnapshotError } from "./snapshot.ts";

test("parseDesiredSnapshot refuses phase 0 / version 1", () => {
  assert.throws(
    () => parseDesiredSnapshot({ version: 1, phase: 0, allow: [], block: [] }),
    (error: unknown) => error instanceof SnapshotError && /stale Phase 0/.test(error.message),
  );
});

test("parseDesiredSnapshot refuses unknown version", () => {
  assert.throws(
    () => parseDesiredSnapshot({ version: 99, phase: 5, allow: [], block: [] }),
    /unknown snapshot schema/,
  );
});

test("loadDesiredSnapshot refuses a missing file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gateway-list-snap-"));
  await assert.rejects(
    () => loadDesiredSnapshot(dir),
    (error: unknown) => error instanceof SnapshotError && /not found; run compile first/.test(error.message),
  );
});

test("loadDesiredSnapshot accepts a compiled v2 snapshot", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gateway-list-snap-ok-"));
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "desired.json"),
    JSON.stringify({
      version: 2,
      phase: 3,
      generatedAt: "2026-01-01T00:00:00.000Z",
      note: "test",
      configPath: "config.yaml",
      allow: [{ domain: "maps.google.com", sourceId: "personal" }],
      block: [{ domain: "ads.example.com", sourceId: "oisd-small" }],
      folded: [],
      remote: { fetched: ["oisd-small"] },
      counts: { allow: 1, block: 1, folded: 0, dropped: 0 },
    }),
    "utf8",
  );
  const snap = await loadDesiredSnapshot(dir);
  assert.equal(snap.allow[0]?.domain, "maps.google.com");
});
