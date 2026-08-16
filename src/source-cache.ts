import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sha256Hex } from "./source-integrity.ts";

const SAFE_ID = /^[A-Za-z0-9._-]+$/;

export function cacheFileName(id: string): string | null {
  return SAFE_ID.test(id) ? `${id}.txt` : null;
}

export function sourceCachePath(dir: string, id: string): string | null {
  const name = cacheFileName(id);
  return name ? join(dir, "cache", name) : null;
}

/** One ETag only. OISD 503s if If-None-Match lists several. */
export function oneEtag(value: string | null | undefined): string | undefined {
  if (value == null) return undefined;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.includes(",")) return undefined;
  return trimmed;
}

export async function readValidSourceCache(
  dir: string,
  id: string,
  expectedSha256: string,
): Promise<string | null> {
  const path = sourceCachePath(dir, id);
  if (!path) return null;
  try {
    const text = await readFile(path, "utf8");
    return sha256Hex(text) === expectedSha256.toLowerCase() ? text : null;
  } catch {
    return null;
  }
}

export async function writeSourceCache(dir: string, id: string, text: string): Promise<void> {
  const path = sourceCachePath(dir, id);
  if (!path) return;
  await mkdir(join(dir, "cache"), { recursive: true });
  await writeFile(path, text, "utf8");
}
