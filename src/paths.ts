import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** Repository root (parent of src/). */
export const repoRoot = resolve(here, "..");

/** Resolve a user path against the repo root. Absolute paths pass through. */
export function resolveFromRepo(userPath: string): string {
  return resolve(repoRoot, userPath);
}
