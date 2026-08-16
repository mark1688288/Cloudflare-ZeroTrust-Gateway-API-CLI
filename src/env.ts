import { readFile } from "node:fs/promises";
import { isNativeError } from "node:util/types";
import { resolveFromRepo } from "./paths.ts";

export class CredentialsError extends Error {
  readonly exitCode = 1;

  constructor(message: string) {
    super(message);
    this.name = "CredentialsError";
  }
}

export type CloudflareCredentials = {
  token: string;
  accountId: string;
};

export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function applyParsedEnv(
  parsed: Record<string, string>,
  env: NodeJS.ProcessEnv = process.env,
): void {
  for (const [key, value] of Object.entries(parsed)) {
    if (env[key] === undefined) env[key] = value;
  }
}

export async function loadDotEnv(
  envPath = resolveFromRepo(".env"),
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  try {
    applyParsedEnv(parseEnvFile(await readFile(envPath, "utf8")), env);
  } catch (error) {
    if (isNativeError(error) && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
}

export function readCloudflareCredentials(
  env: NodeJS.ProcessEnv = process.env,
): CloudflareCredentials {
  const token = env.CLOUDFLARE_API_TOKEN?.trim() ?? "";
  const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim() ?? "";
  if (!token) {
    throw new CredentialsError("CLOUDFLARE_API_TOKEN is not set (copy .env.example to .env)");
  }
  if (!accountId) {
    throw new CredentialsError("CLOUDFLARE_ACCOUNT_ID is not set (copy .env.example to .env)");
  }
  return { token, accountId };
}

export async function loadCloudflareCredentials(options?: {
  envPath?: string;
  env?: NodeJS.ProcessEnv;
  loadFile?: boolean;
}): Promise<CloudflareCredentials> {
  const env = options?.env ?? process.env;
  if (options?.loadFile !== false) {
    await loadDotEnv(options?.envPath ?? resolveFromRepo(".env"), env);
  }
  return readCloudflareCredentials(env);
}

export function redactSecrets(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length >= 8) out = out.split(secret).join("[redacted]");
  }
  return out;
}
