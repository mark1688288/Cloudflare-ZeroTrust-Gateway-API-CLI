import { mergeCidrs } from "./cidr.ts";
import { MmdbError, readMmdbMetadata, walkMmdbNetworks } from "./mmdb.ts";

export const ASN_LIST_NAME_MAX = 64;
const ASN_MAX = 4_294_967_295;

export type AsnExtract = {
  asn: number;
  organization: string | null;
  prefixes: string[];
  databaseType: string;
  buildEpoch: number;
};

export function parseAsn(input: string): number {
  const trimmed = input.trim();
  const match = /^(?:AS)?([0-9]{1,10})$/i.exec(trimmed);
  if (!match) {
    throw new Error(`invalid ASN: ${input} (use AS10206 or 10206)`);
  }
  const n = Number(match[1]);
  if (!Number.isInteger(n) || n < 0 || n > ASN_MAX) {
    throw new Error(`invalid ASN: ${input}`);
  }
  return n;
}

export function formatAsn(asn: number): string {
  return `AS${asn}`;
}

export function sanitizeOrgName(org: string): string {
  return org
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function asnListTitle(asn: number, org: string | null): string {
  const name = org ? sanitizeOrgName(org) : "";
  return name === "" ? formatAsn(asn) : `${formatAsn(asn)} ${name}`;
}

function clipName(full: string, head: string): string {
  if (full.length <= ASN_LIST_NAME_MAX) return full;
  if (head.length >= ASN_LIST_NAME_MAX) return head.slice(0, ASN_LIST_NAME_MAX);
  return full.slice(0, ASN_LIST_NAME_MAX).trimEnd();
}

/** First chunk is `AS10206 Org`. Further chunks are `AS10206-2 Org`. */
export function asnListName(asn: number, org: string | null, index: number): string {
  if (!Number.isInteger(index) || index < 1) {
    throw new Error(`ASN list index must be >= 1, got ${index}`);
  }
  const head = index === 1 ? formatAsn(asn) : `${formatAsn(asn)}-${index}`;
  const name = org ? sanitizeOrgName(org) : "";
  return clipName(name === "" ? head : `${head} ${name}`, head);
}

/** `AS10206`, `AS10206-2 Org`, and dashboard names like `ASN136907 HWCLOUDS-AS-AP`. */
export function parseAsnListName(
  name: string,
): { asn: number; index: number; org: string | null } | null {
  const match = /^AS(?:N)?([0-9]{1,10})(?:-([1-9][0-9]*))?(?: (.+))?$/.exec(name);
  if (!match) return null;
  const asn = Number(match[1]);
  if (!Number.isInteger(asn) || asn < 0 || asn > ASN_MAX) return null;
  const index = match[2] === undefined ? 1 : Number(match[2]);
  const org = match[3]?.trim() ? match[3].trim() : null;
  return { asn, index, org };
}

export function listBelongsToAsn(name: string, asn: number): boolean {
  return new RegExp(`^AS(?:N)?${asn}(?:$|[^0-9])`).test(name);
}

export function isAsnManagedName(name: string): boolean {
  return /^AS(?:N)?[0-9]+(?:$|[^0-9])/.test(name);
}

/** Other (non-`gateway-list*`) IP reusable lists named AS<number> / ASN<number>. */
export function isDashboardAsnIpList(list: { name: string; type?: string }): boolean {
  if (list.type !== undefined && list.type.toUpperCase() !== "IP") return false;
  return parseAsnListName(list.name) !== null;
}

function asAsnNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^(?:AS)?[0-9]+$/i.test(value)) {
    return parseAsn(value);
  }
  return null;
}

function asOrg(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = sanitizeOrgName(value);
  return cleaned === "" ? null : cleaned;
}

export function assertAsnDatabase(buf: Uint8Array): string {
  const metadata = readMmdbMetadata(buf);
  if (!/asn/i.test(metadata.databaseType)) {
    throw new MmdbError(
      `MMDB database_type is "${metadata.databaseType}", expected a GeoLite2-ASN database`,
    );
  }
  return metadata.databaseType;
}

function pickOrg(orgCounts: Map<string, number>): string | null {
  let organization: string | null = null;
  let best = 0;
  for (const [org, count] of orgCounts) {
    if (count > best) {
      organization = org;
      best = count;
    }
  }
  return organization;
}

function emptyExtract(asn: number, databaseType: string, buildEpoch: number): AsnExtract {
  return { asn, organization: null, prefixes: [], databaseType, buildEpoch };
}

/** One MMDB walk for many ASNs. Every requested ASN is present, possibly with no prefixes. */
export function extractAsnsFromMmdb(buf: Uint8Array, asns: readonly number[]): Map<number, AsnExtract> {
  const databaseType = assertAsnDatabase(buf);
  const wanted = new Set(asns);
  const out = new Map<number, AsnExtract>();
  if (wanted.size === 0) return out;

  const buckets = new Map<number, { orgCounts: Map<string, number>; raw: string[] }>();
  for (const asn of wanted) {
    buckets.set(asn, { orgCounts: new Map(), raw: [] });
  }

  const metadata = walkMmdbNetworks(buf, (cidr, data) => {
    if (!data || typeof data !== "object" || Array.isArray(data)) return;
    const record = data as Record<string, unknown>;
    const number = asAsnNumber(record.autonomous_system_number);
    if (number === null) return;
    const bucket = buckets.get(number);
    if (!bucket) return;
    bucket.raw.push(cidr);
    const org = asOrg(record.autonomous_system_organization);
    if (org) bucket.orgCounts.set(org, (bucket.orgCounts.get(org) ?? 0) + 1);
  });

  for (const [asn, bucket] of buckets) {
    out.set(asn, {
      asn,
      organization: pickOrg(bucket.orgCounts),
      prefixes: mergeCidrs(bucket.raw),
      databaseType: metadata.databaseType || databaseType,
      buildEpoch: metadata.buildEpoch,
    });
  }
  return out;
}

export function extractAsnFromMmdb(buf: Uint8Array, asn: number): AsnExtract {
  return extractAsnsFromMmdb(buf, [asn]).get(asn) ?? emptyExtract(asn, assertAsnDatabase(buf), 0);
}
