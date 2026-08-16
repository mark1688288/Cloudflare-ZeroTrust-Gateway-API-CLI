import {
  formatMaybeCount,
  listSlotsNeeded,
} from "./account-quota.ts";
import { desiredDomains, diffDomainSets } from "./domain-diff.ts";
import type {
  AccountQuotaSnapshot,
  DesiredSnapshot,
  DroppedSnapshot,
  SourcesSnapshot,
  SuggestedSnapshot,
} from "./types.ts";

export const SUMMARY_TOP = 50;

export type SummaryInput = {
  current: DesiredSnapshot;
  previous?: DesiredSnapshot;
  sources?: SourcesSnapshot | null;
  dropped?: DroppedSnapshot | null;
  maxItems: number;
  itemsPerList: number;
  maxLists?: number;
  accountQuota?: AccountQuotaSnapshot | null;
  suggested?: SuggestedSnapshot | null;
};

function suggestedSection(snapshot: SuggestedSnapshot | null | undefined): string[] {
  if (!snapshot) return [];
  const lines = [
    "",
    "## Suggested allow (Gateway DNS)",
    "",
    `- window: ${snapshot.window.start} → ${snapshot.window.end}`,
    `- status: ${snapshot.status}`,
  ];
  if (snapshot.warning) lines.push(`- warning: ${snapshot.warning}`);
  if (snapshot.status === "unavailable") {
    lines.push("- Analytics unavailable on this token/plan. Token needs Account Analytics Read.");
    lines.push("- allowlist/personal.txt was not changed.");
    return lines;
  }
  const skippedAllow = snapshot.skipped.filter((row) => row.reason === "already-allow").length;
  lines.push(`- suggested: ${snapshot.suggested.length} (not on personal allow/block)`);
  lines.push(`- skipped already-allow: ${skippedAllow}`);
  lines.push("");
  if (snapshot.suggested.length === 0) {
    lines.push("- (none)");
  } else {
    for (const row of snapshot.suggested.slice(0, SUMMARY_TOP)) {
      lines.push(`- \`${row.domain}\` (${row.count})`);
    }
    if (snapshot.suggested.length > SUMMARY_TOP) {
      lines.push(`- … ${snapshot.suggested.length - SUMMARY_TOP} more`);
    }
  }
  lines.push("");
  lines.push("Copy into `allowlist/personal.txt` by hand. Never auto-merged.");
  return lines;
}

function bulletList(domains: string[], limit: number): string {
  if (domains.length === 0) return "- (none)\n";
  const head = domains.slice(0, limit);
  const lines = head.map((domain) => `- \`${domain}\``);
  if (domains.length > limit) {
    lines.push(`- … ${domains.length - limit} more`);
  }
  return `${lines.join("\n")}\n`;
}

export function renderCompileSummary(input: SummaryInput): string {
  const allow = desiredDomains(input.current.allow);
  const block = desiredDomains(input.current.block);
  const compiled = allow.length + block.length;
  const dropped = input.dropped?.dropped.length ?? input.current.counts.dropped;
  const quota = input.accountQuota ?? null;
  const otherKnown = quota !== null && quota.otherItems !== null;
  const otherItems = otherKnown ? quota.otherItems : null;
  const otherLists = quota?.otherLists;
  const projected = otherItems === null ? null : compiled + otherItems;
  const needed = listSlotsNeeded(compiled, input.itemsPerList);

  let allowAdd: string[] = allow;
  let allowRemove: string[] = [];
  let blockAdd: string[] = block;
  let blockRemove: string[] = [];
  let vsPrevious = false;
  if (input.previous) {
    vsPrevious = true;
    const allowDiff = diffDomainSets(allow, desiredDomains(input.previous.allow));
    const blockDiff = diffDomainSets(block, desiredDomains(input.previous.block));
    allowAdd = allowDiff.toAdd;
    allowRemove = allowDiff.toRemove;
    blockAdd = blockDiff.toAdd;
    blockRemove = blockDiff.toRemove;
  }

  const added = [...allowAdd, ...blockAdd];
  const removed = [...allowRemove, ...blockRemove];

  const sourceRows = (input.sources?.sources ?? [])
    .map((row) => {
      const where = row.url ?? row.path ?? "";
      const content = row.content ?? "";
      return `| ${row.id} | ${row.origin} | ${row.status} | ${content} | ${row.lineCount} | ${row.parsedDomains} | ${where} |`;
    })
    .join("\n");

  const lines = [
    "# Gateway list compile",
    "",
    `Generated: ${input.current.generatedAt}`,
    "",
    "## Quota",
    "",
    `- allow: ${allow.length}`,
    `- block: ${block.length}`,
    `- folded: ${input.current.counts.folded}`,
    `- dropped: ${dropped}`,
    ...(otherKnown
      ? [
          `- compiled: ${compiled}`,
          `- other lists: ${otherItems} items / ${otherLists} lists`,
          `- account: ${projected} / ${input.maxItems} (projected if this desired is applied)`,
          input.maxLists === undefined
            ? `- list slots: ${needed} needed + ${otherLists} other = ${needed + (otherLists ?? 0)}`
            : `- list slots: ${needed} needed + ${otherLists} other = ${needed + (otherLists ?? 0)} / ${input.maxLists}`,
        ]
      : [
          `- used: ${compiled} / ${input.maxItems}`,
          `- other lists: unknown`,
        ]),
    "",
    "## Sources",
    "",
    "| id | origin | status | content | lines | domains | location |",
    "| --- | --- | --- | --- | ---: | ---: | --- |",
    sourceRows || "| (none) |  |  |  |  |  |  |",
    "",
    vsPrevious ? "## Changes vs previous compile" : "## Changes vs previous compile",
    "",
    vsPrevious
      ? `- allow +${allowAdd.length} / -${allowRemove.length}`
      : "- no previous snapshot; all current domains listed as added",
    vsPrevious ? `- block +${blockAdd.length} / -${blockRemove.length}` : "",
    "",
    `### Added (top ${SUMMARY_TOP})`,
    "",
    bulletList(added, SUMMARY_TOP),
    `### Removed (top ${SUMMARY_TOP})`,
    "",
    bulletList(removed, SUMMARY_TOP),
    ...suggestedSection(input.suggested),
  ].filter((line) => line !== "");

  return `${lines.join("\n")}\n`;
}
