/** IPv4 / IPv6 CIDR helpers for ASN reusable lists. */

export type IpVersion = 4 | 6;

export type ParsedCidr = {
  version: IpVersion;
  /** Network address as an unsigned integer (host bits already zero). */
  start: bigint;
  plen: number;
  bits: number;
};

export const IPV6_MAX_PREFIX = 64;

export function parseCidr(value: string): ParsedCidr {
  const trimmed = value.trim();
  const slash = trimmed.lastIndexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) {
    throw new Error(`invalid CIDR: ${value}`);
  }
  const ip = trimmed.slice(0, slash);
  const plen = Number(trimmed.slice(slash + 1));
  if (!Number.isInteger(plen) || plen < 0) {
    throw new Error(`invalid CIDR: ${value}`);
  }
  const parsed = parseIp(ip);
  if (plen > parsed.bits) {
    throw new Error(`invalid CIDR: ${value}`);
  }
  const mask = plen === 0 ? 0n : ((1n << BigInt(plen)) - 1n) << BigInt(parsed.bits - plen);
  return {
    version: parsed.version,
    start: parsed.addr & mask,
    plen,
    bits: parsed.bits,
  };
}

export function parseIp(value: string): { version: IpVersion; addr: bigint; bits: number } {
  const trimmed = value.trim();
  if (trimmed.includes(".")) {
    if (trimmed.includes(":") && trimmed.toLowerCase().includes("::ffff:")) {
      return parseIpV6(trimmed);
    }
    return parseIpV4(trimmed);
  }
  if (trimmed.includes(":")) return parseIpV6(trimmed);
  throw new Error(`invalid IP: ${value}`);
}

function parseIpV4(value: string): { version: 4; addr: bigint; bits: 32 } {
  const parts = value.split(".");
  if (parts.length !== 4) throw new Error(`invalid IPv4: ${value}`);
  let addr = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) throw new Error(`invalid IPv4: ${value}`);
    const n = Number(part);
    if (n > 255) throw new Error(`invalid IPv4: ${value}`);
    addr = (addr << 8n) + BigInt(n);
  }
  return { version: 4, addr, bits: 32 };
}

function parseIpV6(value: string): { version: 6; addr: bigint; bits: 128 } {
  const raw = value.trim().toLowerCase();
  const dotted = raw.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  let head = raw;
  let tailV4: bigint | null = null;
  if (dotted) {
    head = dotted[1] ?? raw;
    tailV4 = parseIpV4(dotted[2] ?? "").addr;
  }
  if ((head.match(/::/g) ?? []).length > 1) throw new Error(`invalid IPv6: ${value}`);
  const [left = "", right = ""] = head.split("::");
  const leftParts = left.split(":").filter((part) => part !== "");
  const rightParts = head.includes("::") ? right.split(":").filter((part) => part !== "") : [];
  const parts = head.includes("::") ? leftParts : left.split(":").filter((part) => part !== "");
  if (!head.includes("::") && parts.length !== (tailV4 === null ? 8 : 6)) {
    throw new Error(`invalid IPv6: ${value}`);
  }
  const missing = (tailV4 === null ? 8 : 6) - leftParts.length - rightParts.length;
  if (head.includes("::") && missing < 0) throw new Error(`invalid IPv6: ${value}`);
  const groups = head.includes("::")
    ? [...leftParts, ...Array.from({ length: missing }, () => "0"), ...rightParts]
    : parts;
  if (groups.length !== (tailV4 === null ? 8 : 6)) throw new Error(`invalid IPv6: ${value}`);
  let addr = 0n;
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) throw new Error(`invalid IPv6: ${value}`);
    addr = (addr << 16n) + BigInt(Number.parseInt(group, 16));
  }
  if (tailV4 !== null) addr = (addr << 32n) + tailV4;
  return { version: 6, addr, bits: 128 };
}

export function formatIp(version: IpVersion, addr: bigint): string {
  if (version === 4) {
    const n = Number(addr);
    return `${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`;
  }
  const groups: number[] = [];
  let x = addr;
  for (let i = 0; i < 8; i++) {
    groups.unshift(Number(x & 0xffffn));
    x >>= 16n;
  }
  let bestStart = -1;
  let bestLen = 0;
  let i = 0;
  while (i < 8) {
    if (groups[i] !== 0) {
      i += 1;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === 0) j += 1;
    const len = j - i;
    if (len > bestLen) {
      bestStart = i;
      bestLen = len;
    }
    i = j;
  }
  const hex = groups.map((group) => group.toString(16));
  if (bestLen >= 2) {
    return `${hex.slice(0, bestStart).join(":")}::${hex.slice(bestStart + bestLen).join(":")}`;
  }
  return hex.join(":");
}

export function formatCidr(version: IpVersion, start: bigint, plen: number): string {
  return `${formatIp(version, start)}/${plen}`;
}

export function formatParsedCidr(cidr: ParsedCidr): string {
  return formatCidr(cidr.version, cidr.start, cidr.plen);
}

export function tryParseCidr(value: string): ParsedCidr | null {
  try {
    return parseCidr(value);
  } catch {
    return null;
  }
}

export function normalizeCidr(value: string): string {
  return formatParsedCidr(parseCidr(value));
}

/** Collapse IPv6 prefixes more specific than /64 (Gateway IP lists). IPv4 unchanged. */
export function collapseIpv6Prefix(cidr: ParsedCidr, maxPlen = IPV6_MAX_PREFIX): ParsedCidr {
  if (cidr.version !== 6 || cidr.plen <= maxPlen) return cidr;
  const shift = BigInt(cidr.bits - maxPlen);
  const mask = maxPlen === 0 ? 0n : ((1n << BigInt(maxPlen)) - 1n) << shift;
  return { version: 6, start: cidr.start & mask, plen: maxPlen, bits: 128 };
}

export function mergeCidrs(values: string[], ipv6MaxPlen = IPV6_MAX_PREFIX): string[] {
  const v4: ParsedCidr[] = [];
  const v6: ParsedCidr[] = [];
  for (const value of values) {
    const parsed = parseCidr(value);
    if (parsed.version === 4) v4.push(parsed);
    else v6.push(collapseIpv6Prefix(parsed, ipv6MaxPlen));
  }
  return [...mergeFamily(v4, 32), ...mergeFamily(v6, 128)].map(formatParsedCidr);
}

function mergeFamily(cidrs: ParsedCidr[], bits: number): ParsedCidr[] {
  if (cidrs.length === 0) return [];
  const ranges = cidrs
    .map((cidr) => {
      const size = 1n << BigInt(bits - cidr.plen);
      return { start: cidr.start, end: cidr.start + size - 1n, version: cidr.version };
    })
    .sort((a, b) => {
      if (a.start === b.start) return a.end < b.end ? -1 : a.end > b.end ? 1 : 0;
      return a.start < b.start ? -1 : 1;
    });

  const merged: { start: bigint; end: bigint; version: IpVersion }[] = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (!last || range.start > last.end + 1n) {
      merged.push({ ...range });
      continue;
    }
    if (range.end > last.end) last.end = range.end;
  }

  const out: ParsedCidr[] = [];
  for (const range of merged) {
    out.push(...rangeToCidrs(range.version, range.start, range.end, bits));
  }
  return out;
}

function rangeToCidrs(
  version: IpVersion,
  start: bigint,
  end: bigint,
  bits: number,
): ParsedCidr[] {
  const out: ParsedCidr[] = [];
  let cur = start;
  while (cur <= end) {
    let maxAlign = 0;
    if (cur !== 0n) {
      let x = cur;
      while ((x & 1n) === 0n && maxAlign < bits) {
        x >>= 1n;
        maxAlign += 1;
      }
    } else {
      maxAlign = bits;
    }
    let remaining = end - cur + 1n;
    let span = 0;
    while (span < bits && remaining >= 1n << BigInt(span + 1)) span += 1;
    const take = Math.min(maxAlign, span);
    const plen = bits - take;
    out.push({ version, start: cur, plen, bits });
    cur += 1n << BigInt(take);
  }
  return out;
}

export function compareCidr(a: string, b: string): number {
  const pa = parseCidr(a);
  const pb = parseCidr(b);
  if (pa.version !== pb.version) return pa.version - pb.version;
  if (pa.start !== pb.start) return pa.start < pb.start ? -1 : 1;
  return pa.plen - pb.plen;
}
