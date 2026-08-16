import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CloudflareApiError, type CfClient } from "./cf-client.ts";
import { normalizeDomain } from "./compiler.ts";
import {
  DESIRED_SNAPSHOT_VERSION,
  SUGGESTED_SNAPSHOT_PHASE,
  type SuggestedDomainRow,
  type SuggestedSkipReason,
  type SuggestedSkippedRow,
  type SuggestedSnapshot,
} from "./types.ts";

export const SUGGESTED_TOP = 50;
export const SUGGESTED_WINDOW_DAYS = 7;
export const SUGGESTED_FALLBACK_DAYS = 1;
export const SUGGESTED_QUERY_LIMIT = 100;
export const SUGGESTED_DATASET = "gatewayResolverQueriesAdaptiveGroups" as const;

/** Official Gateway activity-log numeric enum (docs 2026-04-30). */
export const RESOLVER_DECISION_NAMES: Record<number, string> = {
  3: "blockedByCategory",
  4: "allowedOnNoLocation",
  5: "allowedOnNoPolicyMatch",
  6: "blockedAlwaysCategory",
  7: "overrideForSafeSearch",
  8: "overrideApplied",
  9: "blockedRule",
  10: "allowedRule",
};

export const BLOCKED_RESOLVER_DECISION_IDS = [3, 6, 9] as const;

export const BLOCKED_RESOLVER_DECISIONS = [
  "blocked",
  "blockedByCategory",
  "blockedAlwaysCategory",
  "blockedRule",
] as const;

export const BLOCKED_DNS_QUERY = `query GatewayBlockedDns($accountTag: string!, $start: Time, $end: Time, $limit: uint64!, $decisions: [uint8!]) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      gatewayResolverQueriesAdaptiveGroups(
        filter: { datetime_geq: $start, datetime_leq: $end, resolverDecision_in: $decisions }
        limit: $limit
        orderBy: [count_DESC]
      ) {
        count
        dimensions {
          queryNameReversed
          resolverDecision
        }
      }
    }
  }
}`;

export const BLOCKED_DNS_QUERY_NO_DECISION = `query GatewayBlockedDns($accountTag: string!, $start: Time, $end: Time, $limit: uint64!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      gatewayResolverQueriesAdaptiveGroups(
        filter: { datetime_geq: $start, datetime_leq: $end }
        limit: $limit
        orderBy: [count_DESC]
      ) {
        count
        dimensions {
          queryNameReversed
          resolverDecision
        }
      }
    }
  }
}`;

export type ResolverQueryRow = {
  queryNameReversed: string;
  resolverDecision: string;
  count: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function unreverseQueryName(reversed: string): string | null {
  const trimmed = reversed.trim().toLowerCase().replace(/\.+$/, "");
  if (trimmed === "") return null;
  const labels = trimmed.split(".").filter((label) => label.length > 0);
  if (labels.length < 2) return null;
  return labels.reverse().join(".");
}

export function resolverDecisionName(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return RESOLVER_DECISION_NAMES[value] ?? `decision-${value}`;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return null;
    if (/^\d+$/.test(trimmed)) return resolverDecisionName(Number(trimmed));
    return trimmed;
  }
  return null;
}

export function isBlockedDecision(decision: string | number): boolean {
  if (typeof decision === "number") return (BLOCKED_RESOLVER_DECISION_IDS as readonly number[]).includes(decision);
  const name = resolverDecisionName(decision);
  if (name == null) return false;
  if (name.startsWith("decision-")) {
    const id = Number(name.slice("decision-".length));
    return (BLOCKED_RESOLVER_DECISION_IDS as readonly number[]).includes(id);
  }
  return name.toLowerCase().startsWith("blocked");
}

export function coveredByAllow(domain: string, allow: Iterable<string>): boolean {
  for (const parent of allow) {
    if (domain === parent || domain.endsWith(`.${parent}`)) return true;
  }
  return false;
}

export function utcWindow(now: Date, days: number): { start: string; end: string } {
  const end = new Date(now.getTime());
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
  return { start: start.toISOString(), end: end.toISOString() };
}

export function rankBlockedDomains(rows: ResolverQueryRow[]): SuggestedDomainRow[] {
  const byDomain = new Map<string, { count: number; decisions: Set<string> }>();
  for (const row of rows) {
    if (!isBlockedDecision(row.resolverDecision) || row.count <= 0) continue;
    const host = unreverseQueryName(row.queryNameReversed);
    const domain = host ? normalizeDomain(host) : null;
    if (!domain) continue;
    const current = byDomain.get(domain) ?? { count: 0, decisions: new Set<string>() };
    current.count += row.count;
    current.decisions.add(row.resolverDecision);
    byDomain.set(domain, current);
  }
  return [...byDomain.entries()]
    .map(([domain, value]) => ({
      domain,
      count: value.count,
      decisions: [...value.decisions].sort((a, b) => a.localeCompare(b)),
    }))
    .sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain));
}

export function pickSuggestions(
  ranked: SuggestedDomainRow[],
  allow: Iterable<string>,
  personalBlock: Iterable<string>,
  top = SUGGESTED_TOP,
): { suggested: SuggestedDomainRow[]; skipped: SuggestedSkippedRow[] } {
  const allowSet = new Set(allow);
  const blockSet = new Set(personalBlock);
  const suggested: SuggestedDomainRow[] = [];
  const skipped: SuggestedSkippedRow[] = [];
  for (const row of ranked) {
    let reason: SuggestedSkipReason | undefined;
    if (coveredByAllow(row.domain, allowSet)) reason = "already-allow";
    else if (blockSet.has(row.domain)) reason = "personal-block";
    if (reason) {
      skipped.push({ ...row, reason });
      continue;
    }
    if (suggested.length < top) suggested.push(row);
  }
  return { suggested, skipped };
}

export function parseResolverGroups(data: unknown): ResolverQueryRow[] {
  if (!isRecord(data) || !isRecord(data.viewer) || !Array.isArray(data.viewer.accounts)) {
    return [];
  }
  const rows: ResolverQueryRow[] = [];
  for (const account of data.viewer.accounts) {
    if (!isRecord(account) || !Array.isArray(account.gatewayResolverQueriesAdaptiveGroups)) {
      continue;
    }
    for (const group of account.gatewayResolverQueriesAdaptiveGroups) {
      if (!isRecord(group) || !isRecord(group.dimensions)) continue;
      const reversed = group.dimensions.queryNameReversed;
      const decision = resolverDecisionName(group.dimensions.resolverDecision);
      const count = group.count;
      if (typeof reversed !== "string" || decision == null) continue;
      if (typeof count !== "number" || !Number.isFinite(count)) continue;
      rows.push({ queryNameReversed: reversed, resolverDecision: decision, count });
    }
  }
  return rows;
}

export function isAnalyticsUnavailable(error: unknown): boolean {
  const status = error instanceof CloudflareApiError ? error.status : undefined;
  if (status === 401 || status === 403) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /401|403|unauthorized|not authorized|authentication|permission|forbidden|analytics read|unknown field|cannot query field|does not exist|not available|not entitled|access denied/i.test(
    message,
  );
}

export function isTimeRangeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /time range|too (?:wide|long)|max(?:imum)? (?:duration|interval|range)|lookback|exceeds.*time|datetime.*invalid/i.test(
    message,
  );
}

export function isDecisionFilterError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /resolverDecision|Unknown argument|invalid value|enum/i.test(message);
}

export function renderSuggestedTxt(snapshot: SuggestedSnapshot): string {
  const lines = [
    "# Generated by `gateway-list suggested`. Review only — never auto-merged",
    "# into allowlist/personal.txt. Copy domains by hand after you agree.",
    `# Window: ${snapshot.window.start} → ${snapshot.window.end}`,
    `# Dataset: ${snapshot.dataset}`,
    `# Status: ${snapshot.status}`,
  ];
  if (snapshot.warning) lines.push(`# Warning: ${snapshot.warning}`);
  lines.push("");
  if (snapshot.suggested.length === 0) {
    lines.push("# No suggested allow domains in this window (after filters).");
    lines.push("");
    return `${lines.join("\n")}`;
  }
  for (const row of snapshot.suggested) {
    lines.push(`${row.domain}  # ${row.count}`);
  }
  lines.push("");
  return `${lines.join("\n")}`;
}

export function buildSuggestedSnapshot(input: {
  generatedAt: string;
  window: { start: string; end: string };
  ranked: SuggestedDomainRow[];
  suggested: SuggestedDomainRow[];
  skipped: SuggestedSkippedRow[];
  warning?: string;
}): SuggestedSnapshot {
  const status = input.ranked.length === 0 ? "empty" : "ok";
  return {
    version: DESIRED_SNAPSHOT_VERSION,
    phase: SUGGESTED_SNAPSHOT_PHASE,
    generatedAt: input.generatedAt,
    dataset: SUGGESTED_DATASET,
    window: input.window,
    status,
    ...(input.warning ? { warning: input.warning } : {}),
    blocked: input.ranked,
    suggested: input.suggested,
    skipped: input.skipped,
  };
}

export function unavailableSnapshot(
  generatedAt: string,
  window: { start: string; end: string },
  warning: string,
): SuggestedSnapshot {
  return {
    version: DESIRED_SNAPSHOT_VERSION,
    phase: SUGGESTED_SNAPSHOT_PHASE,
    generatedAt,
    dataset: SUGGESTED_DATASET,
    window,
    status: "unavailable",
    warning,
    blocked: [],
    suggested: [],
    skipped: [],
  };
}

async function queryGroups(
  client: CfClient,
  window: { start: string; end: string },
  withDecisions: boolean,
): Promise<ResolverQueryRow[]> {
  const data = withDecisions
    ? await client.graphql(BLOCKED_DNS_QUERY, {
        accountTag: client.accountId,
        start: window.start,
        end: window.end,
        limit: SUGGESTED_QUERY_LIMIT,
        decisions: [...BLOCKED_RESOLVER_DECISION_IDS],
      })
    : await client.graphql(BLOCKED_DNS_QUERY_NO_DECISION, {
        accountTag: client.accountId,
        start: window.start,
        end: window.end,
        limit: SUGGESTED_QUERY_LIMIT,
      });
  return parseResolverGroups(data);
}

export async function fetchBlockedDns(
  client: CfClient,
  options: { now?: Date; windowDays?: number } = {},
): Promise<{ rows: ResolverQueryRow[]; window: { start: string; end: string }; note?: string }> {
  const now = options.now ?? new Date();
  let days = options.windowDays ?? SUGGESTED_WINDOW_DAYS;
  let window = utcWindow(now, days);
  let note: string | undefined;
  let withDecisions = true;

  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const rows = await queryGroups(client, window, withDecisions);
      return { rows, window, note };
    } catch (error) {
      if (isTimeRangeError(error) && days > SUGGESTED_FALLBACK_DAYS) {
        days = SUGGESTED_FALLBACK_DAYS;
        window = utcWindow(now, days);
        note = `analytics window narrowed to ${days} day(s)`;
        continue;
      }
      if (isDecisionFilterError(error) && withDecisions) {
        withDecisions = false;
        note = note ? `${note}; dropped resolverDecision filter` : "dropped resolverDecision filter";
        continue;
      }
      throw error;
    }
  }
  return { rows: [], window, note };
}

export async function loadSuggestedSnapshot(dir: string): Promise<SuggestedSnapshot | null> {
  try {
    const raw: unknown = JSON.parse(await readFile(join(dir, "suggested.json"), "utf8"));
    if (!isRecord(raw) || raw.phase !== SUGGESTED_SNAPSHOT_PHASE) return null;
    if (!Array.isArray(raw.suggested)) return null;
    return raw as SuggestedSnapshot;
  } catch {
    return null;
  }
}

export async function writeSuggestedSnapshot(dir: string, snapshot: SuggestedSnapshot): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "suggested.json"), `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
}
