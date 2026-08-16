import { domainToASCII } from "node:url";
import { parse as parseTld } from "tldts";
import type {
  CompiledDomain,
  DroppedDomain,
  FoldedDomain,
  SourceFormat,
} from "./types.ts";

const COMMENT_PREFIXES = ["#", "//", "!"] as const;
const TLDTS_OPTS = { allowPrivateDomains: true } as const;

export type CompilerSource = {
  id: string;
  role: "allow" | "block";
  priority: number;
  text: string;
  format?: SourceFormat;
  /** Local/git-managed sources are admitted before remotes when over budget. */
  pinned: boolean;
};

export type CompileOptions = {
  maxItems: number;
};

export type CompileResult = {
  allow: CompiledDomain[];
  block: CompiledDomain[];
  folded: FoldedDomain[];
  dropped: DroppedDomain[];
};

type Candidate = {
  domain: string;
  sourceId: string;
  priority: number;
  pinned: boolean;
  role: "allow" | "block";
};

const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;

export function isPublicSuffix(domain: string): boolean {
  const parsed = parseTld(domain, TLDTS_OPTS);
  return parsed.publicSuffix === domain;
}

export function normalizeDomain(host: string): string | null {
  let value = host.trim().toLowerCase();
  if (value.endsWith(".")) value = value.slice(0, -1);
  if (value.startsWith("*.")) value = value.slice(2);
  if (value.includes("*") || value.includes("..") || value.length === 0) {
    return null;
  }
  if (IPV4.test(value) || value.includes(":")) return null;

  const ascii = domainToASCII(value);
  if (!ascii || ascii.includes(":")) return null;
  if (ascii.length > 253) return null;

  const labels = ascii.split(".");
  if (labels.length < 2) return null;
  const labelOk = /^(?:[a-z0-9]|[a-z0-9][a-z0-9-]*[a-z0-9])$/;
  if (!labels.every((label) => label.length <= 63 && labelOk.test(label))) {
    return null;
  }
  if (isPublicSuffix(ascii)) return null;
  return ascii;
}

type Extracted = { host: string; exception: boolean };

/** Pull a hostname out of a hosts / domains / adblock line. */
export function extractHost(raw: string, format?: SourceFormat): Extracted | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  if (COMMENT_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) return null;
  if (trimmed.startsWith("[")) return null;
  if (trimmed.includes("##") || trimmed.includes("#@#")) return null;
  if (trimmed.startsWith("/") && trimmed.lastIndexOf("/") > 0) return null;

  const withoutInline = trimmed.replace(/\s+(#|\/\/).*$/, "");
  if (withoutInline === "") return null;

  const exception = withoutInline.startsWith("@@");
  let body = exception ? withoutInline.slice(2) : withoutInline;

  if (format === "adblock" || body.startsWith("||") || exception) {
    if (body.startsWith("||")) body = body.slice(2);
    else if (body.startsWith("|")) body = body.slice(1);
    body = body.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
    const cut = body.search(/[\^\$\/\s]/);
    if (cut !== -1) body = body.slice(0, cut);
    body = body.replace(/:\d+$/, "");
    return body ? { host: body, exception } : null;
  }

  const tokens = withoutInline.split(/\s+/);
  const first = tokens[0] ?? "";
  const host =
    format === "hosts" || IPV4.test(first) || first.includes(":")
      ? (tokens[tokens.length - 1] ?? "")
      : first;
  return host ? { host, exception: false } : null;
}

/** Unique normalized domains in one source text, before fold / merge. */
export function enumerateDomains(
  text: string,
  format: SourceFormat | undefined,
  role: "allow" | "block",
): string[] {
  const seen = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const extracted = extractHost(raw, format);
    if (!extracted) continue;
    if (extracted.exception && role === "block") continue;
    const domain = normalizeDomain(extracted.host);
    if (domain) seen.add(domain);
  }
  return [...seen];
}

function collectCandidates(sources: CompilerSource[]): Candidate[] {
  const out: Candidate[] = [];
  for (const source of sources) {
    for (const raw of source.text.split(/\r?\n/)) {
      const extracted = extractHost(raw, source.format);
      if (!extracted) continue;
      if (extracted.exception && source.role === "block") continue;
      const domain = normalizeDomain(extracted.host);
      if (!domain) continue;
      out.push({
        domain,
        sourceId: source.id,
        priority: source.priority,
        pinned: source.pinned,
        role: extracted.exception ? "allow" : source.role,
      });
    }
  }
  return out;
}

function mergeByPriority(entries: Candidate[]): Map<string, Candidate> {
  const map = new Map<string, Candidate>();
  for (const entry of entries) {
    const existing = map.get(entry.domain);
    if (!existing || entry.priority > existing.priority) {
      map.set(entry.domain, entry);
    }
  }
  return map;
}

export function foldableParents(domain: string): string[] {
  const labels = domain.split(".");
  const parents: string[] = [];
  for (let i = 1; i < labels.length; i++) {
    const parent = labels.slice(i).join(".");
    if (isPublicSuffix(parent)) break;
    parents.push(parent);
  }
  return parents;
}

export function foldBlocks(block: Map<string, Candidate>): {
  kept: Map<string, Candidate>;
  folded: FoldedDomain[];
} {
  const kept = new Map<string, Candidate>();
  const folded: FoldedDomain[] = [];
  const domains = [...block.keys()].sort((a, b) => a.length - b.length || a.localeCompare(b));

  for (const domain of domains) {
    const entry = block.get(domain);
    if (!entry) continue;
    const parent = foldableParents(domain).find((candidate) => kept.has(candidate));
    if (parent) {
      folded.push({ domain, sourceId: entry.sourceId, parent });
      continue;
    }
    kept.set(domain, entry);
  }
  return { kept, folded };
}

function applyBudget(
  allow: Map<string, Candidate>,
  block: Map<string, Candidate>,
  maxItems: number,
): {
  allow: Map<string, Candidate>;
  block: Map<string, Candidate>;
  dropped: DroppedDomain[];
} {
  const asList = (role: "allow" | "block", map: Map<string, Candidate>): Candidate[] =>
    [...map.values()].map((entry) => ({ ...entry, role }));

  const all = [...asList("allow", allow), ...asList("block", block)];
  const byPriority = (a: Candidate, b: Candidate): number =>
    b.priority - a.priority || a.domain.localeCompare(b.domain);

  const pinned = all.filter((entry) => entry.pinned).sort(byPriority);
  const flexible = all.filter((entry) => !entry.pinned).sort(byPriority);

  const kept: Candidate[] = [];
  const dropped: DroppedDomain[] = [];

  for (const entry of [...pinned, ...flexible]) {
    if (kept.length < maxItems) {
      kept.push(entry);
    } else {
      dropped.push({ domain: entry.domain, sourceId: entry.sourceId, reason: "budget" });
    }
  }

  const nextAllow = new Map<string, Candidate>();
  const nextBlock = new Map<string, Candidate>();
  for (const entry of kept) {
    (entry.role === "allow" ? nextAllow : nextBlock).set(entry.domain, entry);
  }
  return { allow: nextAllow, block: nextBlock, dropped };
}

function toCompiled(map: Map<string, Candidate>): CompiledDomain[] {
  return [...map.values()]
    .map(({ domain, sourceId }) => ({ domain, sourceId }))
    .sort((a, b) => a.domain.localeCompare(b.domain));
}

export function compileDomains(
  sources: CompilerSource[],
  options: CompileOptions,
): CompileResult {
  const candidates = collectCandidates(sources);
  const allowMerged = mergeByPriority(candidates.filter((entry) => entry.role === "allow"));
  const blockMerged = mergeByPriority(candidates.filter((entry) => entry.role === "block"));
  const { kept: blockFolded, folded } = foldBlocks(blockMerged);
  const budgeted = applyBudget(allowMerged, blockFolded, options.maxItems);
  folded.sort((a, b) => a.domain.localeCompare(b.domain));
  budgeted.dropped.sort((a, b) => a.domain.localeCompare(b.domain));
  return {
    allow: toCompiled(budgeted.allow),
    block: toCompiled(budgeted.block),
    folded,
    dropped: budgeted.dropped,
  };
}
