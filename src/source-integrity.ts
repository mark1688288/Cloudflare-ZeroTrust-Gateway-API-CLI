import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SourceContent, SourceRecord, SourcesSnapshot } from "./types.ts";

const SHA256_HEX = /^[0-9a-f]{64}$/i;

export class CompileAbortError extends Error {
  readonly exitCode: 1 | 2;

  constructor(message: string, exitCode: 1 | 2 = 1) {
    super(message);
    this.name = "CompileAbortError";
    this.exitCode = exitCode;
  }
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function countLines(text: string): number {
  if (text === "") return 0;
  const parts = text.split(/\r?\n/);
  if (parts[parts.length - 1] === "") parts.pop();
  return parts.length;
}

export function sourceContent(
  previous: SourceRecord | undefined,
  sha256: string,
): SourceContent {
  if (
    !previous ||
    previous.status !== "ok" ||
    previous.sha256 == null ||
    !SHA256_HEX.test(previous.sha256)
  ) {
    return "new";
  }
  return previous.sha256.toLowerCase() === sha256.toLowerCase() ? "unchanged" : "updated";
}

export function sourceShrank(
  previous: SourceRecord | undefined,
  lineCount: number,
  abortPct: number,
): { shrank: boolean; shrinkPct: number } {
  if (!previous || previous.status !== "ok" || previous.lineCount <= 0) {
    return { shrank: false, shrinkPct: 0 };
  }
  const shrinkPct = ((previous.lineCount - lineCount) / previous.lineCount) * 100;
  return { shrank: shrinkPct >= abortPct, shrinkPct };
}

export async function loadSourcesSnapshot(dir: string): Promise<SourcesSnapshot | null> {
  try {
    const raw: unknown = JSON.parse(await readFile(join(dir, "sources.json"), "utf8"));
    if (typeof raw !== "object" || raw === null || !("sources" in raw)) return null;
    const sources = (raw as { sources: unknown }).sources;
    if (!Array.isArray(sources)) return null;
    return raw as SourcesSnapshot;
  } catch {
    return null;
  }
}

export function previousRecord(
  snapshot: SourcesSnapshot | null,
  id: string,
): SourceRecord | undefined {
  return snapshot?.sources.find((row) => row.id === id);
}
