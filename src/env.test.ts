import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  applyParsedEnv,
  CredentialsError,
  loadCloudflareCredentials,
  parseEnvFile,
  redactSecrets,
} from "./env.ts";

test("parseEnvFile skips comments and strips quotes", () => {
  const parsed = parseEnvFile(`
# comment
CLOUDFLARE_API_TOKEN="tok_example_value"
CLOUDFLARE_ACCOUNT_ID=abc123
EMPTY=
`);
  assert.equal(parsed.CLOUDFLARE_API_TOKEN, "tok_example_value");
  assert.equal(parsed.CLOUDFLARE_ACCOUNT_ID, "abc123");
});

test("applyParsedEnv does not override existing keys", () => {
  const env: NodeJS.ProcessEnv = { CLOUDFLARE_API_TOKEN: "keep-me-please" };
  applyParsedEnv({ CLOUDFLARE_API_TOKEN: "new", CLOUDFLARE_ACCOUNT_ID: "acct" }, env);
  assert.equal(env.CLOUDFLARE_API_TOKEN, "keep-me-please");
  assert.equal(env.CLOUDFLARE_ACCOUNT_ID, "acct");
});

test("loadCloudflareCredentials reads .env and fails when missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gateway-list-env-"));
  const envPath = join(dir, ".env");
  await writeFile(
    envPath,
    "CLOUDFLARE_API_TOKEN=tok_from_file\nCLOUDFLARE_ACCOUNT_ID=acct_from_file\n",
    "utf8",
  );
  const env: NodeJS.ProcessEnv = {};
  const creds = await loadCloudflareCredentials({ envPath, env });
  assert.equal(creds.token, "tok_from_file");
  assert.equal(creds.accountId, "acct_from_file");

  await assert.rejects(
    () => loadCloudflareCredentials({ env: {}, loadFile: false }),
    (error: unknown) => error instanceof CredentialsError,
  );
});

test("redactSecrets strips long secrets", () => {
  const token = "cfut_super_secret_token_value";
  assert.equal(redactSecrets(`Bearer ${token} failed`, [token]), "Bearer [redacted] failed");
  assert.match(redactSecrets("short", ["ab"]), /^short$/);
});
