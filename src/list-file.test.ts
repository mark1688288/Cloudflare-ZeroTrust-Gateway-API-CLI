import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  domainEntries,
  parseListText,
  readLocalList,
} from "./list-file.ts";

test("comments, blanks, and source attribution", () => {
  const text = [
    "# hash comment",
    "// slash comment",
    "! abp comment",
    "",
    "example.com",
    "  GitHub.COM  ",
  ].join("\n");

  const lines = parseListText(text, "personal");
  assert.deepEqual(
    lines.map((line) => line.kind),
    ["comment", "comment", "comment", "blank", "domain", "domain"],
  );
  assert.deepEqual(domainEntries(lines), [
    { domain: "example.com", sourceId: "personal" },
    { domain: "github.com", sourceId: "personal" },
  ]);
});

test("hosts last token and inline comments", () => {
  const text = [
    "0.0.0.0 ads.example.com",
    "foo.example.com # inline hash",
    "bar.example.com // inline slash",
    "127.0.0.1 localhost",
    "||tracker.example.com^",
  ].join("\n");

  const lines = parseListText(text, "hosts-src");
  assert.deepEqual(domainEntries(lines), [
    { domain: "ads.example.com", sourceId: "hosts-src" },
    { domain: "foo.example.com", sourceId: "hosts-src" },
    { domain: "bar.example.com", sourceId: "hosts-src" },
  ]);
  assert.equal(lines.filter((line) => line.kind === "skipped").length, 2);
});

test("personal allow and block files parse to {domain, sourceId}[]", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gateway-list-"));
  const allowPath = join(dir, "allow.txt");
  const blockPath = join(dir, "block.txt");
  await writeFile(allowPath, "# keep\nmaps.google.com\n", "utf8");
  await writeFile(blockPath, "ads.example.com\n# no\n", "utf8");

  assert.deepEqual(domainEntries(await readLocalList(allowPath, "personal")), [
    { domain: "maps.google.com", sourceId: "personal" },
  ]);
  assert.deepEqual(domainEntries(await readLocalList(blockPath, "personal-block")), [
    { domain: "ads.example.com", sourceId: "personal-block" },
  ]);
});

test("missing list file is a readable ENOENT", async () => {
  await assert.rejects(
    () => readLocalList("allowlist/does-not-exist.txt", "personal"),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /list file not found: allowlist\/does-not-exist\.txt/);
      assert.match(error.message, /source personal/);
      assert.match(error.message, /looked in /);
      return true;
    },
  );
});
