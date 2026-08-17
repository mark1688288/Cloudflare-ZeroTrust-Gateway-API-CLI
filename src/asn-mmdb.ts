import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  assertAsnDatabase,
  extractAsnFromMmdb,
  extractAsnsFromMmdb,
  type AsnExtract,
} from "./asn.ts";
import { fetchBytes } from "./fetch-source.ts";
import { oneEtag } from "./source-cache.ts";
import { sha256Bytes } from "./source-integrity.ts";
import type { SourceConfig } from "./types.ts";

/** Defaults that live in config.yaml `sources.asn`. Tests may reuse these URLs. */
export const GEOLITE2_ASN_URLS = [
  "https://git.io/GeoLite2-ASN.mmdb",
  "https://github.com/P3TERX/GeoLite.mmdb/raw/download/GeoLite2-ASN.mmdb",
] as const;

/** Higher priority first. Only URL sources are used (path is rejected at parse). */
export function asnSourceUrls(sources: SourceConfig[]): string[] {
  return [...sources]
    .filter((source): source is SourceConfig & { url: string } => Boolean(source.url))
    .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))
    .map((source) => source.url);
}

export const GEOLITE2_ASN_CACHE_ID = "GeoLite2-ASN";
export const GEOLITE2_ASN_TIMEOUT_MS = 120_000;

export type AsnMmdbContent = "new" | "unchanged" | "updated";

export type AsnMmdbCacheMeta = {
  url: string;
  etag: string | null;
  sha256: string;
  fetchedAt: string;
  bytes: number;
};

export type LoadedAsnMmdb = {
  bytes: Uint8Array;
  path: string;
  url: string;
  etag: string | null;
  sha256: string;
  content: AsnMmdbContent;
};

function cachePaths(snapshotsDir: string): { mmdb: string; meta: string } {
  const dir = join(snapshotsDir, "cache");
  return {
    mmdb: join(dir, `${GEOLITE2_ASN_CACHE_ID}.mmdb`),
    meta: join(dir, `${GEOLITE2_ASN_CACHE_ID}.json`),
  };
}

function isMeta(value: unknown): value is AsnMmdbCacheMeta {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.url === "string" &&
    (row.etag === null || typeof row.etag === "string") &&
    typeof row.sha256 === "string" &&
    typeof row.fetchedAt === "string" &&
    typeof row.bytes === "number"
  );
}

async function readCache(snapshotsDir: string): Promise<{ bytes: Uint8Array; meta: AsnMmdbCacheMeta } | null> {
  const paths = cachePaths(snapshotsDir);
  try {
    const [bytes, raw] = await Promise.all([readFile(paths.mmdb), readFile(paths.meta, "utf8")]);
    const meta: unknown = JSON.parse(raw);
    if (!isMeta(meta)) return null;
    if (sha256Bytes(bytes) !== meta.sha256.toLowerCase()) return null;
    return { bytes, meta };
  } catch {
    return null;
  }
}

async function writeCache(
  snapshotsDir: string,
  bytes: Uint8Array,
  meta: AsnMmdbCacheMeta,
): Promise<string> {
  const paths = cachePaths(snapshotsDir);
  await mkdir(join(snapshotsDir, "cache"), { recursive: true });
  await writeFile(paths.mmdb, bytes);
  await writeFile(paths.meta, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  return paths.mmdb;
}

export async function loadGeoLite2AsnMmdb(options: {
  snapshotsDir: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  urls?: readonly string[];
}): Promise<LoadedAsnMmdb> {
  const urls = options.urls ?? [];
  if (urls.length === 0) {
    throw new Error("GeoLite2-ASN.mmdb: no source url (set sources.asn in config.yaml)");
  }
  const cachedRaw = await readCache(options.snapshotsDir);
  const cached =
    cachedRaw &&
    (() => {
      try {
        assertAsnDatabase(cachedRaw.bytes);
        return cachedRaw;
      } catch {
        return null;
      }
    })();
  const etag = oneEtag(cached?.meta.etag);
  const fetchOpts = {
    fetch: options.fetch,
    sleep: options.sleep,
    timeoutMs: GEOLITE2_ASN_TIMEOUT_MS,
    ifNoneMatch: etag,
  };

  let lastError: Error | undefined;
  for (const url of urls) {
    try {
      const fetched = await fetchBytes(url, fetchOpts);
      if (fetched.status === 304) {
        if (!cached) continue;
        return {
          bytes: cached.bytes,
          path: cachePaths(options.snapshotsDir).mmdb,
          url: cached.meta.url,
          etag: fetched.etag ?? cached.meta.etag,
          sha256: cached.meta.sha256,
          content: "unchanged",
        };
      }
      if (fetched.status !== 200 || fetched.bytes.length === 0) {
        lastError = new Error(`GeoLite2-ASN.mmdb: GET ${url} returned no body`);
        continue;
      }
      assertAsnDatabase(fetched.bytes);
      const sha256 = sha256Bytes(fetched.bytes);
      const path = await writeCache(options.snapshotsDir, fetched.bytes, {
        url,
        etag: fetched.etag,
        sha256,
        fetchedAt: new Date().toISOString(),
        bytes: fetched.bytes.length,
      });
      const content: AsnMmdbContent = !cached
        ? "new"
        : cached.meta.sha256 === sha256
          ? "unchanged"
          : "updated";
      return {
        bytes: fetched.bytes,
        path,
        url,
        etag: fetched.etag,
        sha256,
        content,
      };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  if (cached) {
    return {
      bytes: cached.bytes,
      path: cachePaths(options.snapshotsDir).mmdb,
      url: cached.meta.url,
      etag: cached.meta.etag,
      sha256: cached.meta.sha256,
      content: "unchanged",
    };
  }
  throw lastError ?? new Error("GeoLite2-ASN.mmdb: download failed");
}

export function extractFromLoaded(loaded: LoadedAsnMmdb, asn: number): AsnExtract {
  return extractAsnFromMmdb(loaded.bytes, asn);
}

export function extractManyFromLoaded(
  loaded: LoadedAsnMmdb,
  asns: readonly number[],
): Map<number, AsnExtract> {
  return extractAsnsFromMmdb(loaded.bytes, asns);
}
