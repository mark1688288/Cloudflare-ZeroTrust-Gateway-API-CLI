import { readFile } from "node:fs/promises";
import { isNativeError } from "node:util/types";
import { resolveFromRepo } from "./paths.ts";
import type { ParsedLine } from "./types.ts";

const COMMENT_PREFIXES = ["#", "//", "!"] as const;

/** Phase 0 reader: comments, blanks, and a naive domain token. Full parser is Phase 2. */
export function parseListText(text: string, sourceId: string): ParsedLine[] {
  const lines = text.split(/\r?\n/);
  return lines.map((raw) => {
    const trimmed = raw.trim();
    if (trimmed === "") {
      return { raw, domain: null, sourceId, kind: "blank" };
    }
    if (COMMENT_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) {
      return { raw, domain: null, sourceId, kind: "comment" };
    }

    const withoutInlineComment = trimmed.replace(/\s+(#|\/\/).*$/, "");
    const tokens = withoutInlineComment.split(/\s+/);
    const candidate = tokens[tokens.length - 1]?.toLowerCase() ?? "";
    if (!isLooseDomain(candidate)) {
      return { raw, domain: null, sourceId, kind: "skipped" };
    }
    return { raw, domain: candidate, sourceId, kind: "domain" };
  });
}

function isLooseDomain(value: string): boolean {
  return /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(
    value,
  );
}

export async function readListText(listPath: string, sourceId: string): Promise<string> {
  const absolute = resolveFromRepo(listPath);
  try {
    return await readFile(absolute, "utf8");
  } catch (error) {
    if (isNativeError(error) && "code" in error && error.code === "ENOENT") {
      throw new Error(
        `list file not found: ${listPath} (source ${sourceId}; looked in ${absolute})`,
      );
    }
    throw error;
  }
}

export async function readLocalList(listPath: string, sourceId: string): Promise<ParsedLine[]> {
  return parseListText(await readListText(listPath, sourceId), sourceId);
}

export function domainValues(lines: ParsedLine[]): string[] {
  return lines.flatMap((line) => (line.domain ? [line.domain] : []));
}

export function domainEntries(
  lines: ParsedLine[],
): { domain: string; sourceId: string }[] {
  return lines.flatMap((line) =>
    line.domain ? [{ domain: line.domain, sourceId: line.sourceId }] : [],
  );
}
