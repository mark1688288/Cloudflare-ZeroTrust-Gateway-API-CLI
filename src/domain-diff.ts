import type { CompiledDomain, SideDiff } from "./types.ts";

export function allowListName(prefix: string, index?: number): string {
  return index === undefined || index === 0 ? `${prefix}:allow` : `${prefix}:allow-${index}`;
}

export function blockListName(prefix: string, index?: number): string {
  return index === undefined || index === 0 ? `${prefix}:block` : `${prefix}:block-${index}`;
}

export function ownedListIndex(
  name: string,
  prefix: string,
  role: "allow" | "block",
): number | null {
  const base = role === "allow" ? allowListName(prefix) : blockListName(prefix);
  if (name === base) return 0;
  if (!name.startsWith(`${base}-`)) return null;
  const n = Number(name.slice(base.length + 1));
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function sortOwnedLists<T extends { name: string }>(
  lists: T[],
  prefix: string,
  role: "allow" | "block",
): T[] {
  return [...lists].sort((a, b) => {
    const ia = ownedListIndex(a.name, prefix, role) ?? 10_000;
    const ib = ownedListIndex(b.name, prefix, role) ?? 10_000;
    return ia - ib || a.name.localeCompare(b.name);
  });
}

export function isAllowListName(name: string, prefix: string): boolean {
  const base = allowListName(prefix);
  return name === base || name.startsWith(`${base}-`);
}

export function isBlockListName(name: string, prefix: string): boolean {
  const base = blockListName(prefix);
  return name === base || name.startsWith(`${base}-`);
}

export function desiredDomains(entries: CompiledDomain[]): string[] {
  return [...new Set(entries.map((row) => row.domain.toLowerCase()))].sort();
}

export function liveDomains(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean))].sort();
}

export function diffDomainSets(desired: string[], live: string[]): SideDiff {
  const desiredSet = new Set(desired);
  const liveSet = new Set(live);
  const toAdd = desired.filter((domain) => !liveSet.has(domain));
  const toRemove = live.filter((domain) => !desiredSet.has(domain));
  const unchanged = desired.filter((domain) => liveSet.has(domain));
  return {
    toAdd,
    toRemove,
    unchanged,
    counts: {
      toAdd: toAdd.length,
      toRemove: toRemove.length,
      unchanged: unchanged.length,
    },
  };
}

export function hasDrift(allow: SideDiff, block: SideDiff): boolean {
  return (
    allow.counts.toAdd + allow.counts.toRemove + block.counts.toAdd + block.counts.toRemove > 0
  );
}
