import {
  asnListName,
  isDashboardAsnIpList,
  listBelongsToAsn,
  parseAsnListName,
  type AsnExtract,
} from "./asn.ts";
import { compareCidr, normalizeCidr, tryParseCidr } from "./cidr.ts";

export class AsnAbortError extends Error {
  readonly exitCode = 2;

  constructor(message: string) {
    super(message);
    this.name = "AsnAbortError";
  }
}

export type LiveAsnList = {
  id: string;
  name: string;
  type?: string;
  items: string[];
};

export type AsnListPatch = {
  id: string;
  name: string;
  nextName: string;
  append: string[];
  remove: string[];
};

export type AsnListCreate = {
  name: string;
  items: string[];
};

export type AsnPlan = {
  action: "add" | "update";
  asn: number;
  organization: string | null;
  title: string;
  prefixes: string[];
  patches: AsnListPatch[];
  creates: AsnListCreate[];
};

export function normalizeAsnItems(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const parsed = tryParseCidr(value);
    if (!parsed) continue;
    const cidr = normalizeCidr(value);
    if (seen.has(cidr)) continue;
    seen.add(cidr);
    out.push(cidr);
  }
  return out.sort(compareCidr);
}

export function findAsnLists<T extends { name: string }>(lists: T[], asn: number): T[] {
  return lists.filter((list) => listBelongsToAsn(list.name, asn));
}

export function findDashboardAsnLists<T extends { name: string; type?: string }>(lists: T[]): T[] {
  return lists.filter((list) => isDashboardAsnIpList(list));
}

export function uniqueDashboardAsns(lists: { name: string }[]): number[] {
  const asns = new Set<number>();
  for (const list of lists) {
    const parsed = parseAsnListName(list.name);
    if (parsed) asns.add(parsed.asn);
  }
  return [...asns].sort((a, b) => a - b);
}

function sortAsnLists<T extends { name: string }>(lists: T[]): T[] {
  return [...lists].sort((a, b) => {
    const ia = parseAsnListName(a.name)?.index ?? 10_000;
    const ib = parseAsnListName(b.name)?.index ?? 10_000;
    return ia - ib || a.name.localeCompare(b.name);
  });
}

function nextIndex(lists: { name: string }[]): number {
  const indices = lists
    .map((list) => parseAsnListName(list.name)?.index)
    .filter((index): index is number => index !== undefined);
  return indices.length === 0 ? 1 : Math.max(...indices) + 1;
}

export function planAsnAdd(extract: AsnExtract, existing: LiveAsnList[], itemsPerList: number): AsnPlan {
  if (existing.length > 0) {
    const names = existing.map((list) => list.name).join(", ");
    throw new AsnAbortError(
      `ASN ${extract.asn} already has reusable list(s): ${names}. Use asn update AS${extract.asn}`,
    );
  }
  if (extract.prefixes.length === 0) {
    throw new AsnAbortError(`ASN ${extract.asn} has no prefixes in GeoLite2-ASN`);
  }
  const creates: AsnListCreate[] = [];
  let index = 1;
  for (let offset = 0; offset < extract.prefixes.length; offset += itemsPerList) {
    creates.push({
      name: asnListName(extract.asn, extract.organization, index),
      items: extract.prefixes.slice(offset, offset + itemsPerList),
    });
    index += 1;
  }
  return {
    action: "add",
    asn: extract.asn,
    organization: extract.organization,
    title: asnListName(extract.asn, extract.organization, 1),
    prefixes: extract.prefixes,
    patches: [],
    creates,
  };
}

export function planAsnUpdate(
  extract: AsnExtract,
  existing: LiveAsnList[],
  itemsPerList: number,
): AsnPlan {
  if (existing.length === 0) {
    throw new AsnAbortError(`ASN ${extract.asn} has no reusable list yet. Use asn add AS${extract.asn}`);
  }
  if (extract.prefixes.length === 0) {
    throw new AsnAbortError(`ASN ${extract.asn} has no prefixes in GeoLite2-ASN`);
  }

  const wrongType = existing.find((list) => list.type && list.type !== "IP");
  if (wrongType) {
    throw new AsnAbortError(
      `refusing to update "${wrongType.name}": type is ${wrongType.type}, expected IP`,
    );
  }

  const desired = extract.prefixes;
  const desiredSet = new Set(desired);
  const sorted = sortAsnLists(existing);
  const assigned = new Set<string>();
  const patches: AsnListPatch[] = [];

  for (const [slot, list] of sorted.entries()) {
    const index = parseAsnListName(list.name)?.index ?? slot + 1;
    const nextName = asnListName(extract.asn, extract.organization, index);
    const current = normalizeAsnItems(list.items);
    const keep: string[] = [];
    for (const item of current) {
      if (desiredSet.has(item) && !assigned.has(item)) {
        keep.push(item);
        assigned.add(item);
      }
    }
    const remove = current.filter((item) => !keep.includes(item));
    const slots = Math.max(0, itemsPerList - keep.length);
    const append: string[] = [];
    for (const prefix of desired) {
      if (append.length >= slots) break;
      if (assigned.has(prefix)) continue;
      append.push(prefix);
      assigned.add(prefix);
    }
    if (append.length > 0 || remove.length > 0 || nextName !== list.name) {
      patches.push({ id: list.id, name: list.name, nextName, append, remove });
    }
  }

  const remaining = desired.filter((prefix) => !assigned.has(prefix));
  let index = nextIndex(sorted);
  const creates: AsnListCreate[] = [];
  for (let offset = 0; offset < remaining.length; offset += itemsPerList) {
    creates.push({
      name: asnListName(extract.asn, extract.organization, index),
      items: remaining.slice(offset, offset + itemsPerList),
    });
    index += 1;
  }

  return {
    action: "update",
    asn: extract.asn,
    organization: extract.organization,
    title: asnListName(extract.asn, extract.organization, 1),
    prefixes: extract.prefixes,
    patches,
    creates,
  };
}

export function planIsNoop(plan: AsnPlan): boolean {
  return plan.patches.length === 0 && plan.creates.length === 0;
}
