import { formatCidr, type IpVersion } from "./cidr.ts";

const METADATA_MARKER = Buffer.from("\xab\xcd\xefMaxMind.com", "binary");
const MAX_METADATA_BYTES = 128 * 1024;

const TYPE_POINTER = 1;
const TYPE_STRING = 2;
const TYPE_DOUBLE = 3;
const TYPE_BYTES = 4;
const TYPE_UINT16 = 5;
const TYPE_UINT32 = 6;
const TYPE_MAP = 7;
const TYPE_INT32 = 8;
const TYPE_UINT64 = 9;
const TYPE_UINT128 = 10;
const TYPE_ARRAY = 11;
const TYPE_BOOLEAN = 14;
const TYPE_FLOAT = 15;

export type MmdbMetadata = {
  nodeCount: number;
  recordSize: number;
  ipVersion: IpVersion;
  databaseType: string;
  binaryFormatMajorVersion: number;
  binaryFormatMinorVersion: number;
  buildEpoch: number;
  description: Record<string, string>;
};

export class MmdbError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MmdbError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asUint(value: unknown, label: string): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  throw new MmdbError(`MMDB metadata ${label} is not an unsigned integer`);
}

function asString(value: unknown, label: string): string {
  if (typeof value === "string") return value;
  throw new MmdbError(`MMDB metadata ${label} is not a string`);
}

function findMetadataStart(buf: Uint8Array): number {
  const from = Math.max(0, buf.length - MAX_METADATA_BYTES);
  let found = -1;
  for (let i = buf.length - METADATA_MARKER.length; i >= from; i--) {
    let ok = true;
    for (let j = 0; j < METADATA_MARKER.length; j++) {
      if (buf[i + j] !== METADATA_MARKER[j]) {
        ok = false;
        break;
      }
    }
    if (ok) {
      found = i;
      break;
    }
  }
  if (found < 0) throw new MmdbError("MMDB: metadata marker not found");
  return found + METADATA_MARKER.length;
}

type Decoder = {
  buf: Uint8Array;
  origin: number;
};

function readPointer(ctrl: number, buf: Uint8Array, offset: number): { pointer: number; next: number } {
  const size = (ctrl >> 3) & 0x03;
  const prefix = ctrl & 0x07;
  if (size === 0) {
    return { pointer: (prefix << 8) | (buf[offset] ?? 0), next: offset + 1 };
  }
  if (size === 1) {
    return {
      pointer: 2048 + ((prefix << 16) | ((buf[offset] ?? 0) << 8) | (buf[offset + 1] ?? 0)),
      next: offset + 2,
    };
  }
  if (size === 2) {
    return {
      pointer:
        526336 +
        ((prefix << 24) |
          ((buf[offset] ?? 0) << 16) |
          ((buf[offset + 1] ?? 0) << 8) |
          (buf[offset + 2] ?? 0)),
      next: offset + 3,
    };
  }
  return {
    pointer:
      ((buf[offset] ?? 0) * 2 ** 24 +
        ((buf[offset + 1] ?? 0) << 16) +
        ((buf[offset + 2] ?? 0) << 8) +
        (buf[offset + 3] ?? 0)) >>>
      0,
    next: offset + 4,
  };
}

function readSize(sizeBits: number, buf: Uint8Array, offset: number): { size: number; next: number } {
  if (sizeBits < 29) return { size: sizeBits, next: offset };
  if (sizeBits === 29) return { size: 29 + (buf[offset] ?? 0), next: offset + 1 };
  if (sizeBits === 30) {
    return { size: 285 + (((buf[offset] ?? 0) << 8) | (buf[offset + 1] ?? 0)), next: offset + 2 };
  }
  return {
    size:
      65_821 + (((buf[offset] ?? 0) << 16) | ((buf[offset + 1] ?? 0) << 8) | (buf[offset + 2] ?? 0)),
    next: offset + 3,
  };
}

function readUint(buf: Uint8Array, offset: number, size: number): number {
  let n = 0;
  for (let i = 0; i < size; i++) n = n * 256 + (buf[offset + i] ?? 0);
  return n;
}

function decodeAt(dec: Decoder, offset: number): { value: unknown; next: number } {
  if (offset < 0 || offset >= dec.buf.length) {
    throw new MmdbError("MMDB: data offset out of range");
  }
  const ctrl = dec.buf[offset] ?? 0;
  let type = ctrl >> 5;
  let pos = offset + 1;
  if (type === 0) {
    type = (dec.buf[pos] ?? 0) + 7;
    pos += 1;
  }
  if (type === TYPE_POINTER) {
    const pointer = readPointer(ctrl, dec.buf, pos);
    const resolved = decodeAt(dec, dec.origin + pointer.pointer);
    return { value: resolved.value, next: pointer.next };
  }

  const sized = readSize(ctrl & 0x1f, dec.buf, pos);
  pos = sized.next;
  const size = sized.size;

  if (type === TYPE_MAP) {
    const out: Record<string, unknown> = {};
    let next = pos;
    for (let i = 0; i < size; i++) {
      const key = decodeAt(dec, next);
      if (typeof key.value !== "string") throw new MmdbError("MMDB: map key is not a string");
      const val = decodeAt(dec, key.next);
      out[key.value] = val.value;
      next = val.next;
    }
    return { value: out, next };
  }
  if (type === TYPE_ARRAY) {
    const out: unknown[] = [];
    let next = pos;
    for (let i = 0; i < size; i++) {
      const item = decodeAt(dec, next);
      out.push(item.value);
      next = item.next;
    }
    return { value: out, next };
  }
  if (type === TYPE_STRING) {
    return { value: new TextDecoder().decode(dec.buf.subarray(pos, pos + size)), next: pos + size };
  }
  if (type === TYPE_BYTES) {
    return { value: dec.buf.subarray(pos, pos + size), next: pos + size };
  }
  if (type === TYPE_DOUBLE) {
    return { value: new DataView(dec.buf.buffer, dec.buf.byteOffset + pos, 8).getFloat64(0, false), next: pos + 8 };
  }
  if (type === TYPE_FLOAT) {
    return { value: new DataView(dec.buf.buffer, dec.buf.byteOffset + pos, 4).getFloat32(0, false), next: pos + 4 };
  }
  if (type === TYPE_BOOLEAN) {
    return { value: size !== 0, next: pos };
  }
  if (
    type === TYPE_UINT16 ||
    type === TYPE_UINT32 ||
    type === TYPE_UINT64 ||
    type === TYPE_UINT128
  ) {
    return { value: readUint(dec.buf, pos, size), next: pos + size };
  }
  if (type === TYPE_INT32) {
    let n = readUint(dec.buf, pos, size);
    if (size === 4 && n >= 0x80000000) n -= 0x100000000;
    return { value: n, next: pos + size };
  }
  throw new MmdbError(`MMDB: unsupported data type ${type}`);
}

function parseMetadata(raw: unknown): MmdbMetadata {
  if (!isRecord(raw)) throw new MmdbError("MMDB: metadata is not a map");
  const ipVersion = asUint(raw.ip_version, "ip_version");
  if (ipVersion !== 4 && ipVersion !== 6) {
    throw new MmdbError(`MMDB: unsupported ip_version ${ipVersion}`);
  }
  const description: Record<string, string> = {};
  if (isRecord(raw.description)) {
    for (const [key, value] of Object.entries(raw.description)) {
      if (typeof value === "string") description[key] = value;
    }
  }
  return {
    nodeCount: asUint(raw.node_count, "node_count"),
    recordSize: asUint(raw.record_size, "record_size"),
    ipVersion,
    databaseType: asString(raw.database_type, "database_type"),
    binaryFormatMajorVersion: asUint(raw.binary_format_major_version, "binary_format_major_version"),
    binaryFormatMinorVersion: asUint(raw.binary_format_minor_version, "binary_format_minor_version"),
    buildEpoch: asUint(raw.build_epoch, "build_epoch"),
    description,
  };
}

function nodeBytes(recordSize: number): number {
  return (recordSize * 2) / 8;
}

function readRecord(buf: Uint8Array, recordSize: number, nodeIndex: number, side: 0 | 1): number {
  const size = nodeBytes(recordSize);
  const offset = nodeIndex * size;
  if (recordSize === 24) {
    const base = offset + side * 3;
    return ((buf[base] ?? 0) << 16) | ((buf[base + 1] ?? 0) << 8) | (buf[base + 2] ?? 0);
  }
  if (recordSize === 28) {
    const mid = buf[offset + 3] ?? 0;
    if (side === 0) {
      return (
        ((mid & 0xf0) << 20) |
        ((buf[offset] ?? 0) << 16) |
        ((buf[offset + 1] ?? 0) << 8) |
        (buf[offset + 2] ?? 0)
      );
    }
    return (
      ((mid & 0x0f) << 24) |
      ((buf[offset + 4] ?? 0) << 16) |
      ((buf[offset + 5] ?? 0) << 8) |
      (buf[offset + 6] ?? 0)
    );
  }
  if (recordSize === 32) {
    const base = offset + side * 4;
    return (
      (((buf[base] ?? 0) << 24) |
        ((buf[base + 1] ?? 0) << 16) |
        ((buf[base + 2] ?? 0) << 8) |
        (buf[base + 3] ?? 0)) >>>
      0
    );
  }
  throw new MmdbError(`MMDB: unsupported record_size ${recordSize}`);
}

export function readMmdbMetadata(buf: Uint8Array): MmdbMetadata {
  const start = findMetadataStart(buf);
  const decoded = decodeAt({ buf, origin: start }, start);
  return parseMetadata(decoded.value);
}

function networkToCidr(ipVersion: IpVersion, prefix: bigint, depth: number): string {
  const bits = ipVersion === 4 ? 32 : 128;
  const start = depth === 0 ? 0n : prefix << BigInt(bits - depth);
  if (ipVersion === 4) return formatCidr(4, start, depth);

  if (depth >= 96 && start >> 32n === 0n) {
    return formatCidr(4, start & 0xffffffffn, depth - 96);
  }
  const mappedHigh = start >> 32n;
  if (depth >= 96 && mappedHigh === 0xffffn) {
    return formatCidr(4, start & 0xffffffffn, depth - 96);
  }
  return formatCidr(6, start, depth);
}

export function walkMmdbNetworks(
  buf: Uint8Array,
  onNetwork: (cidr: string, data: unknown) => void,
): MmdbMetadata {
  const metadata = readMmdbMetadata(buf);
  if (metadata.binaryFormatMajorVersion !== 2) {
    throw new MmdbError(`MMDB: unsupported binary format ${metadata.binaryFormatMajorVersion}`);
  }
  const { nodeCount, recordSize, ipVersion } = metadata;
  const treeSize = nodeCount * nodeBytes(recordSize);
  const dataOrigin = treeSize + 16;
  if (dataOrigin > buf.length) throw new MmdbError("MMDB: truncated search tree");
  const dec: Decoder = { buf, origin: dataOrigin };
  const maxDepth = ipVersion === 4 ? 32 : 128;
  const seen = new Set<number>();

  const walk = (nodeIndex: number, prefix: bigint, depth: number): void => {
    if (nodeIndex === nodeCount) return;
    if (nodeIndex > nodeCount) {
      const fileOffset = treeSize + (nodeIndex - nodeCount);
      const { value } = decodeAt(dec, fileOffset);
      onNetwork(networkToCidr(ipVersion, prefix, depth), value);
      return;
    }
    if (seen.has(nodeIndex)) return;
    seen.add(nodeIndex);
    if (depth >= maxDepth) return;
    walk(readRecord(buf, recordSize, nodeIndex, 0), prefix << 1n, depth + 1);
    walk(readRecord(buf, recordSize, nodeIndex, 1), (prefix << 1n) | 1n, depth + 1);
  };

  if (nodeCount > 0) walk(0, 0n, 0);
  return metadata;
}
