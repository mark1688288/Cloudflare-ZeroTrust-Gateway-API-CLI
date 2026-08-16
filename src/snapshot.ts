import { readFile } from "node:fs/promises";
import { isNativeError } from "node:util/types";
import { join } from "node:path";
import {
  DESIRED_SNAPSHOT_VERSION,
  type CompiledDomain,
  type DesiredSnapshot,
} from "./types.ts";

export class SnapshotError extends Error {
  readonly exitCode = 1;

  constructor(message: string) {
    super(message);
    this.name = "SnapshotError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCompiledDomain(value: unknown): value is CompiledDomain {
  return (
    isRecord(value) &&
    typeof value.domain === "string" &&
    value.domain.trim() !== "" &&
    typeof value.sourceId === "string"
  );
}

export function parseDesiredSnapshot(raw: unknown, label = "snapshots/desired.json"): DesiredSnapshot {
  if (!isRecord(raw)) {
    throw new SnapshotError(`${label}: expected a JSON object`);
  }

  const version = raw.version;
  const phase = raw.phase;
  if (version === 1 || phase === 0) {
    throw new SnapshotError(`${label}: stale Phase 0 snapshot; run compile`);
  }
  if (version !== DESIRED_SNAPSHOT_VERSION) {
    throw new SnapshotError(
      `${label}: unknown snapshot schema (version ${String(version)}); run compile`,
    );
  }
  if (typeof phase !== "number" || phase < 2) {
    throw new SnapshotError(`${label}: unsupported snapshot phase ${String(phase)}; run compile`);
  }
  if (!Array.isArray(raw.allow) || !raw.allow.every(isCompiledDomain)) {
    throw new SnapshotError(`${label}: allow must be {domain, sourceId}[]`);
  }
  if (!Array.isArray(raw.block) || !raw.block.every(isCompiledDomain)) {
    throw new SnapshotError(`${label}: block must be {domain, sourceId}[]`);
  }

  return raw as DesiredSnapshot;
}

export async function loadDesiredSnapshot(dir: string): Promise<DesiredSnapshot> {
  const path = join(dir, "desired.json");
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isNativeError(error) && "code" in error && error.code === "ENOENT") {
      throw new SnapshotError(`${path}: not found; run compile first`);
    }
    throw error;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError(`${path}: invalid JSON`);
  }
  return parseDesiredSnapshot(raw, path);
}
