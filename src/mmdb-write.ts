import { parseCidr } from "./cidr.ts";

const METADATA_MARKER = Buffer.from("\xab\xcd\xefMaxMind.com", "binary");

const TYPE_STRING = 2;
const TYPE_UINT16 = 5;
const TYPE_UINT32 = 6;
const TYPE_MAP = 7;
const TYPE_UINT64 = 9;
const TYPE_ARRAY = 11;

export type MmdbWriteNetwork = {
  network: string;
  data: Record<string, unknown>;
};

type TrieNode = {
  left: TrieNode | null;
  right: TrieNode | null;
  data: Record<string, unknown> | null;
  index?: number;
};

function encodeTypeAndSize(type: number, size: number): number[] {
  let sizeBits: number;
  const extra: number[] = [];
  if (size < 29) {
    sizeBits = size;
  } else if (size < 29 + 256) {
    sizeBits = 29;
    extra.push(size - 29);
  } else if (size < 285 + 65_536) {
    sizeBits = 30;
    const n = size - 285;
    extra.push((n >> 8) & 0xff, n & 0xff);
  } else {
    sizeBits = 31;
    const n = size - 65_821;
    extra.push((n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff);
  }
  if (type < 8) return [(type << 5) | sizeBits, ...extra];
  return [sizeBits, type - 7, ...extra];
}

function uintPayload(value: number): number[] {
  if (value === 0) return [];
  const out: number[] = [];
  let n = value;
  while (n > 0) {
    out.unshift(n & 0xff);
    n = Math.floor(n / 256);
  }
  return out;
}

function encodeValue(value: unknown): number[] {
  if (typeof value === "string") {
    const bytes = [...new TextEncoder().encode(value)];
    return [...encodeTypeAndSize(TYPE_STRING, bytes.length), ...bytes];
  }
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    const payload = uintPayload(value);
    const type = value > 0xffffffff ? TYPE_UINT64 : value > 0xffff ? TYPE_UINT32 : TYPE_UINT16;
    return [...encodeTypeAndSize(type, payload.length), ...payload];
  }
  if (Array.isArray(value)) {
    const body: number[] = [];
    for (const item of value) body.push(...encodeValue(item));
    return [...encodeTypeAndSize(TYPE_ARRAY, value.length), ...body];
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    const body: number[] = [];
    for (const [key, item] of entries) {
      body.push(...encodeValue(key), ...encodeValue(item));
    }
    return [...encodeTypeAndSize(TYPE_MAP, entries.length), ...body];
  }
  throw new Error(`mmdb-write: unsupported value ${String(value)}`);
}

function newNode(): TrieNode {
  return { left: null, right: null, data: null };
}

function insertBits(root: TrieNode, bits: number[], data: Record<string, unknown>): TrieNode {
  let node = root;
  for (const bit of bits) {
    if (bit === 0) {
      node.left ??= newNode();
      node = node.left;
    } else {
      node.right ??= newNode();
      node = node.right;
    }
  }
  node.data = data;
  return node;
}

function cidrToBits(network: string, ipVersion: 4 | 6): number[] {
  const cidr = parseCidr(network);
  const bits: number[] = [];
  if (ipVersion === 6 && cidr.version === 4) {
    for (let i = 0; i < 96; i++) bits.push(0);
  } else if (cidr.version !== ipVersion && !(ipVersion === 6 && cidr.version === 4)) {
    throw new Error(`mmdb-write: ${network} does not match ip_version ${ipVersion}`);
  }
  const total = cidr.version === 4 ? 32 : 128;
  for (let i = 0; i < cidr.plen; i++) {
    const shift = BigInt(total - 1 - i);
    bits.push(Number((cidr.start >> shift) & 1n));
  }
  return bits;
}

function nodeAt(root: TrieNode, bits: number[]): TrieNode {
  let node = root;
  for (const bit of bits) {
    if (bit === 0) {
      node.left ??= newNode();
      node = node.left;
    } else {
      node.right ??= newNode();
      node = node.right;
    }
  }
  return node;
}

function writeUint24(value: number): [number, number, number] {
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

function writeNode(recordSize: 24 | 28, left: number, right: number): number[] {
  if (recordSize === 24) {
    return [...writeUint24(left), ...writeUint24(right)];
  }
  return [
    (left >> 16) & 0xff,
    (left >> 8) & 0xff,
    left & 0xff,
    (((left >> 24) & 0x0f) << 4) | ((right >> 24) & 0x0f),
    (right >> 16) & 0xff,
    (right >> 8) & 0xff,
    right & 0xff,
  ];
}

/**
 * Minimal MaxMind DB writer for tests (24-bit records).
 * `aliases` points an empty prefix at another prefix's node (GeoLite2 IPv4-mapped / 6to4).
 */
export function writeMmdb(options: {
  ipVersion: 4 | 6;
  databaseType: string;
  recordSize?: 24 | 28;
  networks: MmdbWriteNetwork[];
  aliases?: { from: string; to: string }[];
  buildEpoch?: number;
}): Uint8Array {
  const recordSize = options.recordSize ?? 24;
  const root = newNode();
  const terminals = new Map<string, TrieNode>();
  for (const row of options.networks) {
    const bits = cidrToBits(row.network, options.ipVersion);
    terminals.set(row.network, insertBits(root, bits, row.data));
  }
  for (const alias of options.aliases ?? []) {
    const target = terminals.get(alias.to) ?? nodeAt(root, cidrToBits(alias.to, options.ipVersion));
    const fromBits = cidrToBits(alias.from, options.ipVersion);
    if (fromBits.length === 0) throw new Error("mmdb-write: alias from cannot be /0");
    const parentBits = fromBits.slice(0, -1);
    const last = fromBits[fromBits.length - 1] ?? 0;
    const parent = nodeAt(root, parentBits);
    if (last === 0) parent.left = target;
    else parent.right = target;
  }

  const ordered: TrieNode[] = [];
  const visit = (node: TrieNode): void => {
    if (node.index !== undefined) return;
    node.index = ordered.length;
    ordered.push(node);
    if (node.left) visit(node.left);
    if (node.right) visit(node.right);
  };
  visit(root);
  const nodeCount = ordered.length;

  const dataChunks: number[] = [];
  const dataOffset = new Map<TrieNode, number>();
  for (const node of ordered) {
    if (!node.data) continue;
    dataOffset.set(node, dataChunks.length);
    dataChunks.push(...encodeValue(node.data));
  }

  const tree: number[] = [];
  for (const node of ordered) {
    const record = (child: TrieNode | null): number => {
      if (!child) return nodeCount;
      if (child.data && !child.left && !child.right) {
        return nodeCount + 16 + (dataOffset.get(child) ?? 0);
      }
      if (child.index === undefined) {
        throw new Error("mmdb-write: child node was not indexed");
      }
      if (child.data && (child.left || child.right)) {
        throw new Error("mmdb-write: data node with children is not supported");
      }
      return child.index;
    };
    tree.push(...writeNode(recordSize, record(node.left), record(node.right)));
  }

  const metadata = encodeValue({
    node_count: nodeCount,
    record_size: recordSize,
    ip_version: options.ipVersion,
    database_type: options.databaseType,
    languages: ["en"],
    binary_format_major_version: 2,
    binary_format_minor_version: 0,
    build_epoch: options.buildEpoch ?? 1_700_000_000,
    description: { en: options.databaseType },
  });

  const separator = Array.from({ length: 16 }, () => 0);
  return Uint8Array.from([
    ...tree,
    ...separator,
    ...dataChunks,
    ...METADATA_MARKER,
    ...metadata,
  ]);
}
