#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { CloudflareApiError } from "./cf-client.ts";
import { applyCommand } from "./commands/apply.ts";
import { asnCommand } from "./commands/asn.ts";
import { compileCommand } from "./commands/compile.ts";
import { diffCommand } from "./commands/diff.ts";
import { listsCommand } from "./commands/lists.ts";
import { suggestedCommand } from "./commands/suggested.ts";
import { summaryCommand } from "./commands/summary.ts";
import { whyCommand } from "./commands/why.ts";
import { CredentialsError } from "./env.ts";

const USAGE = `gateway-list — Cloudflare Zero Trust Gateway list CLI

Usage:
  node src/cli.ts                              interactive shell
  node src/cli.ts compile [--config config.yaml]
  node src/cli.ts summary [--config config.yaml]
  node src/cli.ts lists   [--config config.yaml]
  node src/cli.ts diff    [--config config.yaml]
  node src/cli.ts apply   [--config config.yaml] [--dry-run]
  node src/cli.ts why     <domain>
  node src/cli.ts suggested [--config config.yaml]
  node src/cli.ts asn add <ASNNNN>           [--config config.yaml] [--dry-run]
  node src/cli.ts asn update <ASNNNN>        [--config config.yaml] [--dry-run]
  node src/cli.ts asn update --dashboard     [--config config.yaml] [--dry-run]
  node src/cli.ts --help

In the shell, type the same commands, or help / exit.
  asn add AS10206, asn update AS10206, asn update --dashboard [--dry-run]

Phase 9–11:
  compile  fetches remotes + compiles into snapshots/desired.json
           (optional live account quota if credentials are present)
  summary  Job Summary from snapshots (vs previous compile if present)
  lists    read-only doctor of Gateway lists/rules + account quota (needs .env)
  diff     desired.json vs live owned lists (exit 0 even if drift)
  apply    PATCH owned lists + upsert policy pack (--dry-run writes nothing)
  why      explain one domain from the compiled snapshot
  suggested  last-week top blocked DNS → allowlist/suggested.txt (never personal)
  asn      add/update an IP reusable list from GeoLite2-ASN (no rule)
`;

type Defaults = { configPath: string };

const PARSE_OPTIONS = {
  help: { type: "boolean", short: "h", default: false },
  config: { type: "string" },
  "dry-run": { type: "boolean", default: false },
  dashboard: { type: "boolean", default: false },
} as const;

function tokenize(line: string): string[] {
  const tokens: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (const match of line.matchAll(pattern)) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return tokens;
}

function parseArgv(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    options: PARSE_OPTIONS,
  });
}

function printCaught(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  if (error instanceof CloudflareApiError) return error.exitCode;
  if (error instanceof CredentialsError) return error.exitCode;
  return 1;
}

async function runCommand(argv: string[], defaults: Defaults): Promise<number> {
  let values: ReturnType<typeof parseArgv>["values"];
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgv(argv));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const [command, ...rest] = positionals;
  if (!command || command === "help" || command === "?") {
    if (!command) {
      console.error("type a command (help for a list)");
      return 1;
    }
    process.stdout.write(USAGE);
    return 0;
  }

  const configPath = values.config ?? defaults.configPath;

  try {
    switch (command) {
      case "compile":
        return await compileCommand({ configPath });
      case "summary":
        return await summaryCommand({ configPath });
      case "lists":
        return await listsCommand({ configPath });
      case "diff":
        return await diffCommand({ configPath });
      case "apply":
        return await applyCommand({ configPath, dryRun: Boolean(values["dry-run"]) });
      case "why": {
        const domain = rest[0] ?? "";
        if (!domain) {
          console.error("usage: why <domain>");
          return 1;
        }
        return await whyCommand({ domain, configPath });
      }
      case "suggested":
        return await suggestedCommand({ configPath });
      case "asn":
        return await asnCommand({
          configPath,
          dryRun: Boolean(values["dry-run"]),
          dashboard: Boolean(values.dashboard),
          rest,
        });
      case "exit":
      case "quit":
        return 0;
      default:
        console.error(`unknown command: ${command}`);
        process.stderr.write(USAGE);
        return 1;
    }
  } catch (error) {
    return printCaught(error);
  }
}

async function runRepl(defaults: Defaults): Promise<number> {
  const input = process.stdin;
  const output = process.stdout;
  const tty = Boolean(input.isTTY);
  const prompt = tty ? "gateway-list> " : "";

  if (tty) output.write("gateway-list — type a command, or help / exit\n");

  const rl = createInterface({ input, output, prompt, terminal: tty });
  if (tty) {
    rl.on("SIGINT", () => {
      output.write("\n");
      rl.close();
    });
    rl.prompt();
  }

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (tty) rl.prompt();
      continue;
    }
    if (trimmed === "exit" || trimmed === "quit") break;

    await runCommand(tokenize(trimmed), defaults);
    if (tty) rl.prompt();
  }

  rl.close();
  return 0;
}

async function main(argv: string[]): Promise<number> {
  let values: ReturnType<typeof parseArgv>["values"];
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgv(argv));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const defaults: Defaults = { configPath: values.config ?? "config.yaml" };
  if (positionals.length === 0) return runRepl(defaults);
  return runCommand(argv, defaults);
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  process.exitCode = printCaught(error);
}
