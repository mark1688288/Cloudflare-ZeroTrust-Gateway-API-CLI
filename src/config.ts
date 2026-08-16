import { readFile } from "node:fs/promises";
import { isNativeError } from "node:util/types";
import { parse } from "yaml";
import { resolveFromRepo } from "./paths.ts";
import type { Config, SourceConfig, SourceFormat } from "./types.ts";

let errorFileLabel = "config.yaml";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(path: string, message: string): never {
  throw new Error(`${errorFileLabel}: ${path}: ${message}`);
}

function isEnoent(error: unknown): boolean {
  return isNativeError(error) && "code" in error && error.code === "ENOENT";
}

function expectRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) fail(path, "expected a mapping");
  return value;
}

function expectString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    fail(path, "expected a non-empty string");
  }
  return value;
}

function expectNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(path, "expected a number");
  }
  return value;
}

function expectInteger(
  value: unknown,
  path: string,
  bounds?: { min?: number; max?: number },
): number {
  const n = expectNumber(value, path);
  if (!Number.isInteger(n)) fail(path, "expected an integer");
  if (bounds?.min !== undefined && n < bounds.min) {
    fail(path, `expected an integer >= ${bounds.min}`);
  }
  if (bounds?.max !== undefined && n > bounds.max) {
    fail(path, `expected an integer <= ${bounds.max}`);
  }
  return n;
}

function expectBoolean(value: unknown, path: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") fail(path, "expected true or false");
  return value;
}

function parseFormat(value: unknown, path: string): SourceFormat | undefined {
  if (value === undefined) return undefined;
  if (value === "hosts" || value === "domains" || value === "adblock") {
    return value;
  }
  fail(path, "format must be hosts | domains | adblock");
}

function parseSource(value: unknown, path: string): SourceConfig {
  const row = expectRecord(value, path);
  const id = expectString(row.id, `${path}.id`);
  const source: SourceConfig = {
    id,
    priority: expectInteger(row.priority, `${path}.priority`),
    required: expectBoolean(row.required, `${path}.required`, true),
  };
  if (row.path !== undefined) source.path = expectString(row.path, `${path}.path`);
  if (row.url !== undefined) source.url = expectString(row.url, `${path}.url`);
  const format = parseFormat(row.format, `${path}.format`);
  if (format) source.format = format;
  if (!source.path && !source.url) {
    fail(path, "needs path or url");
  }
  if (source.path && source.url) {
    fail(path, "use path or url, not both");
  }
  return source;
}

function parseSources(value: unknown, path: string): SourceConfig[] {
  if (!Array.isArray(value) || value.length === 0) {
    fail(path, "expected a non-empty list");
  }
  return value.map((item, index) => parseSource(item, `${path}[${index}]`));
}

function assertUniqueSourceIds(config: Config): void {
  const seen = new Map<string, string>();
  const groups = [
    ["sources.allow", config.sources.allow],
    ["sources.block", config.sources.block],
  ] as const;
  for (const [group, list] of groups) {
    for (const [index, source] of list.entries()) {
      const here = `${group}[${index}]`;
      const previous = seen.get(source.id);
      if (previous) {
        fail(`${here}.id`, `duplicate source id "${source.id}" (already ${previous})`);
      }
      seen.set(source.id, here);
    }
  }
}

function assertPrecedenceOrder(config: Config): void {
  const allow = config.policies.allow.precedence;
  const security = config.policies.security.precedence;
  const block = config.policies.block.precedence;
  if (!(allow < security && security < block)) {
    fail(
      "policies",
      "expected policies.allow.precedence < policies.security.precedence < policies.block.precedence",
    );
  }
}

export function parseConfig(raw: unknown, fileLabel = "config.yaml"): Config {
  const previousLabel = errorFileLabel;
  errorFileLabel = fileLabel;
  try {
    const root = expectRecord(raw, "$");
    const plan = expectRecord(root.plan, "plan");
    const sources = expectRecord(root.sources, "sources");
    const safety = expectRecord(root.safety, "safety");
    const policies = expectRecord(root.policies, "policies");
    const allowPolicy = expectRecord(policies.allow, "policies.allow");
    const securityPolicy = expectRecord(policies.security, "policies.security");
    const blockPolicy = expectRecord(policies.block, "policies.block");

    const config: Config = {
      plan: {
        maxItems: expectInteger(plan.max_items, "plan.max_items", { min: 1 }),
        itemsPerList: expectInteger(plan.items_per_list, "plan.items_per_list", {
          min: 1,
          max: 5000,
        }),
        listNamePrefix: expectString(plan.list_name_prefix, "plan.list_name_prefix"),
        ...(plan.max_lists === undefined
          ? {}
          : {
              maxLists: expectInteger(plan.max_lists, "plan.max_lists", { min: 1 }),
            }),
      },
      sources: {
        allow: parseSources(sources.allow, "sources.allow"),
        block: parseSources(sources.block, "sources.block"),
      },
      safety: {
        abortIfSourceShrinksPct: expectInteger(
          safety.abort_if_source_shrinks_pct,
          "safety.abort_if_source_shrinks_pct",
          { min: 0, max: 100 },
        ),
        abortIfAllowlistShrinks: expectInteger(
          safety.abort_if_allowlist_shrinks,
          "safety.abort_if_allowlist_shrinks",
          { min: 0 },
        ),
        abortIfAddsOver: expectInteger(safety.abort_if_adds_over, "safety.abort_if_adds_over", {
          min: 0,
        }),
        requireReviewIfRemovesOver: expectInteger(
          safety.require_review_if_removes_over,
          "safety.require_review_if_removes_over",
          { min: 0 },
        ),
      },
      policies: {
        allow: {
          name: expectString(allowPolicy.name, "policies.allow.name"),
          precedence: expectInteger(allowPolicy.precedence, "policies.allow.precedence", {
            min: 0,
          }),
        },
        security: {
          name: expectString(securityPolicy.name, "policies.security.name"),
          precedence: expectInteger(
            securityPolicy.precedence,
            "policies.security.precedence",
            { min: 0 },
          ),
          enabled: expectBoolean(securityPolicy.enabled, "policies.security.enabled", true),
        },
        block: {
          name: expectString(blockPolicy.name, "policies.block.name"),
          precedence: expectInteger(blockPolicy.precedence, "policies.block.precedence", {
            min: 0,
          }),
        },
      },
    };
    assertUniqueSourceIds(config);
    assertPrecedenceOrder(config);
    return config;
  } finally {
    errorFileLabel = previousLabel;
  }
}

export async function loadConfig(configPath = "config.yaml"): Promise<Config> {
  const absolute = resolveFromRepo(configPath);
  let text: string;
  try {
    text = await readFile(absolute, "utf8");
  } catch (error) {
    if (isEnoent(error)) {
      throw new Error(`${configPath}: file not found (${absolute})`);
    }
    throw error;
  }
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${configPath}: invalid YAML: ${message}`);
  }
  return parseConfig(raw, configPath);
}
