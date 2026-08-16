import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { repoRoot } from "./paths.ts";

const workflow = readFileSync(resolve(repoRoot, ".github/workflows/sync.yml"), "utf8");

test("workflow never checkouts an upstream list manager", () => {
  assert.doesNotMatch(workflow, /mrrfv\/cloudflare-gateway-pihole-scripts/);
  assert.match(workflow, /actions\/checkout@v7/);
});

test("apply uses the compile artifact and does not compile again", () => {
  assert.match(workflow, /actions\/download-artifact@v8/);
  assert.match(workflow, /name: gateway-list-snapshot/);
  const applyBlock = workflow.slice(workflow.indexOf("\n  apply:"));
  assert.match(applyBlock, /node src\/cli\.ts apply/);
  assert.doesNotMatch(applyBlock, /node src\/cli\.ts compile/);
  assert.doesNotMatch(applyBlock, /node src\/cli\.ts apply --dry-run/);
});

test("schedule apply requires AUTO_APPLY; dispatch requires checkbox", () => {
  assert.match(workflow, /vars\.AUTO_APPLY == 'true'/);
  assert.match(workflow, /inputs\.apply/);
  assert.match(workflow, /github\.event_name != 'pull_request'/);
});

test("workflow is not triggered by pull_request", () => {
  assert.doesNotMatch(workflow, /pull_request:/);
});

test("keepalive does not swallow enable failures", () => {
  assert.match(workflow, /gh workflow enable/);
  assert.doesNotMatch(workflow, /\|\| true/);
});

test("least privilege: actions:write only on keepalive", () => {
  assert.match(workflow, /keepalive:[\s\S]*actions: write/);
  const compileBlock = workflow.slice(workflow.indexOf("\n  compile:"), workflow.indexOf("\n  apply:"));
  const applyBlock = workflow.slice(workflow.indexOf("\n  apply:"), workflow.indexOf("\n  keepalive:"));
  assert.doesNotMatch(compileBlock, /actions: write/);
  assert.doesNotMatch(applyBlock, /actions: write/);
});

test("token is a secret; account id is a variable", () => {
  assert.match(workflow, /secrets\.CLOUDFLARE_API_TOKEN/);
  assert.match(workflow, /vars\.CLOUDFLARE_ACCOUNT_ID/);
  assert.doesNotMatch(workflow, /secrets\.CLOUDFLARE_ACCOUNT_ID/);
});

test("compile job receives Cloudflare credentials for read-only quota", () => {
  const compileBlock = workflow.slice(workflow.indexOf("\n  compile:"), workflow.indexOf("\n  apply:"));
  assert.match(compileBlock, /secrets\.CLOUDFLARE_API_TOKEN/);
  assert.match(compileBlock, /vars\.CLOUDFLARE_ACCOUNT_ID/);
  assert.match(compileBlock, /node src\/cli\.ts compile/);
  assert.doesNotMatch(compileBlock, /node src\/cli\.ts apply/);
});

test("compile job runs suggested before summary and does not open a PR", () => {
  const compileBlock = workflow.slice(workflow.indexOf("\n  compile:"), workflow.indexOf("\n  apply:"));
  const suggestedAt = compileBlock.indexOf("node src/cli.ts suggested");
  const summaryAt = compileBlock.indexOf("node src/cli.ts summary");
  assert.ok(suggestedAt >= 0);
  assert.ok(summaryAt > suggestedAt);
  assert.match(compileBlock, /continue-on-error: true/);
  assert.doesNotMatch(workflow, /pull_request:/);
  assert.doesNotMatch(workflow, /gh pr create/);
  assert.doesNotMatch(compileBlock, /contents: write/);
});
