import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { repoRoot, resolveFromRepo } from "./paths.ts";

test("relative paths resolve from repo root", () => {
  assert.equal(resolveFromRepo("config.yaml"), resolve(repoRoot, "config.yaml"));
  assert.equal(resolveFromRepo("allowlist/personal.txt"), resolve(repoRoot, "allowlist/personal.txt"));
});

test("absolute paths pass through", () => {
  assert.equal(resolveFromRepo("/tmp/other.yaml"), "/tmp/other.yaml");
  const absConfig = resolve(repoRoot, "config.yaml");
  assert.equal(resolveFromRepo(absConfig), absConfig);
  assert.notEqual(resolveFromRepo(absConfig), resolve(repoRoot, absConfig.slice(1)));
});
