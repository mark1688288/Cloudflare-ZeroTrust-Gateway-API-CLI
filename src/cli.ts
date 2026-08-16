#!/usr/bin/env node
import { parseArgs } from "node:util";
import { CloudflareApiError } from "./cf-client.ts";
import { applyCommand } from "./commands/apply.ts";
import { compileCommand } from "./commands/compile.ts";
import { diffCommand } from "./commands/diff.ts";
import { listsCommand } from "./commands/lists.ts";
import { suggestedCommand } from "./commands/suggested.ts";
import { summaryCommand } from "./commands/summary.ts";
import { whyCommand } from "./commands/why.ts";
import { CredentialsError } from "./env.ts";

const USAGE = `gateway-list — Cloudflare Zero Trust Gateway list CLI

Usage:
  node src/cli.ts compile [--config config.yaml]
  node src/cli.ts summary [--config config.yaml]
  node src/cli.ts lists   [--config config.yaml]
  node src/cli.ts diff    [--config config.yaml]
  node src/cli.ts apply   [--config config.yaml] [--dry-run]
  node src/cli.ts why     <domain>
  node src/cli.ts suggested [--config config.yaml]
  node src/cli.ts --help

Phase 9–11:
  compile  fetches remotes + compiles into snapshots/desired.json
           (optional live account quota if credentials are present)
  summary  Job Summary from snapshots (vs previous compile if present)
  lists    read-only doctor of Gateway lists/rules + account quota (needs .env)
  diff     desired.json vs live owned lists (exit 0 even if drift)
  apply    PATCH owned lists + upsert policy pack (--dry-run writes nothing)
  why      explain one domain from the compiled snapshot
  suggested  last-week top blocked DNS → allowlist/suggested.txt (never personal)
`;

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h", default: false },
      config: { type: "string", default: "config.yaml" },
      "dry-run": { type: "boolean", default: false },
    },
  });

  if (values.help || positionals.length === 0) {
    process.stdout.write(USAGE);
    return 0;
  }

  const [command, ...rest] = positionals;
  const configPath = values.config ?? "config.yaml";

  switch (command) {
    case "compile":
      return compileCommand({ configPath });
    case "summary":
      return summaryCommand({ configPath });
    case "lists":
      return listsCommand({ configPath });
    case "diff":
      return diffCommand({ configPath });
    case "apply":
      return applyCommand({ configPath, dryRun: Boolean(values["dry-run"]) });
    case "why": {
      const domain = rest[0] ?? "";
      if (!domain) {
        console.error("usage: node src/cli.ts why <domain>");
        return 1;
      }
      return whyCommand({ domain, configPath });
    }
    case "suggested":
      return suggestedCommand({ configPath });
    default:
      console.error(`unknown command: ${command}`);
      process.stderr.write(USAGE);
      return 1;
  }
}

try {
  const code = await main(process.argv.slice(2));
  process.exitCode = code;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  if (error instanceof CloudflareApiError) process.exitCode = error.exitCode;
  else if (error instanceof CredentialsError) process.exitCode = error.exitCode;
  else process.exitCode = 1;
}
