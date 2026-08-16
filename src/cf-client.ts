import { redactSecrets, type CloudflareCredentials } from "./env.ts";

export const CF_API_BASE = "https://api.cloudflare.com/client/v4";
export const CF_GRAPHQL_PATH = "/graphql";
export const CF_DEFAULT_429_MS = 120_000;
export const CF_MAX_RETRY_AFTER_MS = 180_000;
export const CF_BUCKET_CAPACITY = 8;
export const CF_BUCKET_REFILL_PER_SEC = 4;

export class CloudflareApiError extends Error {
  readonly exitCode = 3;
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "CloudflareApiError";
    this.status = status;
  }
}

export type GatewayList = {
  id: string;
  name: string;
  description?: string;
  type?: string;
  count?: number;
};

export type GatewayListItem = {
  value: string;
  description?: string;
};

export type GatewayRule = {
  id: string;
  name: string;
  precedence?: number;
  action?: string;
  enabled?: boolean;
  traffic?: string;
  filters?: string[];
};

export type CfEnvelope = {
  success?: boolean;
  errors?: Array<{ code?: number; message?: string }>;
  result?: unknown;
  result_info?: {
    page?: number;
    per_page?: number;
    count?: number;
    total_count?: number;
    total_pages?: number;
  };
};

export type CfClientOptions = CloudflareCredentials & {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  timeoutMs?: number;
  maxAttempts?: number;
  bucketCapacity?: number;
  refillPerSec?: number;
};

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function cloudflareRetryWaitMs(response: Response, fallbackMs = CF_DEFAULT_429_MS): number {
  const raw = response.headers.get("retry-after");
  if (raw) {
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, CF_MAX_RETRY_AFTER_MS);
    }
    const when = Date.parse(raw);
    if (!Number.isNaN(when)) {
      return Math.min(Math.max(0, when - Date.now()), CF_MAX_RETRY_AFTER_MS);
    }
  }
  return fallbackMs;
}

export function formatCfErrors(json: unknown): string {
  if (!isRecord(json) || !Array.isArray(json.errors) || json.errors.length === 0) {
    return "";
  }
  const parts = json.errors.flatMap((item) => {
    if (isRecord(item) && typeof item.message === "string" && item.message.trim() !== "") {
      return [item.message];
    }
    return [];
  });
  return parts.length > 0 ? `: ${parts.join("; ")}` : "";
}

export class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  private readonly capacity: number;
  private readonly refillPerSec: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    capacity: number,
    refillPerSec: number,
    now: () => number,
    sleep: (ms: number) => Promise<void>,
  ) {
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this.now = now;
    this.sleep = sleep;
    this.tokens = capacity;
    this.lastRefill = now();
  }

  async take(): Promise<void> {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }
    const waitMs = Math.ceil(((1 - this.tokens) / this.refillPerSec) * 1000);
    await this.sleep(Math.max(0, waitMs));
    this.refill();
    this.tokens = Math.max(0, this.tokens - 1);
  }

  private refill(): void {
    const now = this.now();
    const elapsed = Math.max(0, now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSec);
    this.lastRefill = now;
  }
}

export function isOwnedName(name: string, prefix: string): boolean {
  return name.startsWith(prefix);
}

export type CfClient = {
  accountId: string;
  request: (method: string, path: string, body?: unknown) => Promise<CfEnvelope>;
  graphql: (query: string, variables?: Record<string, unknown>) => Promise<unknown>;
  listLists: () => Promise<GatewayList[]>;
  getList: (listId: string) => Promise<GatewayList>;
  listListItems: (listId: string) => Promise<GatewayListItem[]>;
  listRules: () => Promise<GatewayRule[]>;
  ownedLists: (prefix: string) => Promise<GatewayList[]>;
  ownedRules: (prefix: string) => Promise<GatewayRule[]>;
};

export function createCfClient(options: CfClientOptions): CfClient {
  const fetchFn = options.fetch ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxAttempts = options.maxAttempts ?? 5;
  const token = options.token;
  const accountId = options.accountId;
  const bucket = new TokenBucket(
    options.bucketCapacity ?? CF_BUCKET_CAPACITY,
    options.refillPerSec ?? CF_BUCKET_REFILL_PER_SEC,
    now,
    sleep,
  );

  const fail = (message: string, status?: number): never => {
    throw new CloudflareApiError(redactSecrets(message, [token]), status);
  };

  const requestHttp = async (
    method: string,
    url: string,
    label: string,
    body?: unknown,
  ): Promise<unknown> => {
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      await bucket.take();
      try {
        const response = await fetchFn(url, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            accept: "application/json",
            ...(body !== undefined ? { "content-type": "application/json" } : {}),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });

        const text = await response.text();
        let json: unknown = {};
        if (text !== "") {
          try {
            json = JSON.parse(text);
          } catch {
            fail(`Cloudflare API ${label}: HTTP ${response.status} (non-JSON)`, response.status);
          }
        }

        if (response.status === 429) {
          lastError = new CloudflareApiError(
            redactSecrets(`Cloudflare API ${label}: HTTP 429`, [token]),
            429,
          );
          if (attempt === maxAttempts) throw lastError;
          await sleep(cloudflareRetryWaitMs(response));
          continue;
        }

        if (response.status >= 500) {
          lastError = new CloudflareApiError(
            redactSecrets(
              `Cloudflare API ${label}: HTTP ${response.status}${formatCfErrors(json)}`,
              [token],
            ),
            response.status,
          );
          if (attempt === maxAttempts) throw lastError;
          await sleep(2_000);
          continue;
        }

        if (!response.ok) {
          fail(
            `Cloudflare API ${label}: HTTP ${response.status}${formatCfErrors(json)}`,
            response.status,
          );
        }

        if (isRecord(json) && json.success === false) {
          fail(`Cloudflare API ${label}: success=false${formatCfErrors(json)}`, response.status);
        }

        return json;
      } catch (error) {
        if (error instanceof CloudflareApiError) throw error;
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt === maxAttempts) {
          fail(`Cloudflare API ${label}: ${lastError.message}`);
        }
        await sleep(2_000);
      }
    }

    throw lastError ?? new CloudflareApiError("Cloudflare API request failed");
  };

  const request = async (method: string, path: string, body?: unknown): Promise<CfEnvelope> => {
    const suffix = path.startsWith("/") ? path : `/${path}`;
    const json = await requestHttp(
      method,
      `${CF_API_BASE}/accounts/${accountId}${suffix}`,
      `${method} ${suffix}`,
      body,
    );
    return json as CfEnvelope;
  };

  const graphql = async (query: string, variables?: Record<string, unknown>): Promise<unknown> => {
    const json = await requestHttp("POST", `${CF_API_BASE}${CF_GRAPHQL_PATH}`, "POST /graphql", {
      query,
      variables,
    });
    if (!isRecord(json)) fail("Cloudflare API POST /graphql: non-object response");
    const gqlErrors = Array.isArray(json.errors) ? json.errors : [];
    const messages = gqlErrors.flatMap((item) => {
      if (isRecord(item) && typeof item.message === "string" && item.message.trim() !== "") {
        return [item.message];
      }
      return [];
    });
    if (json.data == null) {
      fail(
        messages.length > 0
          ? `Cloudflare API POST /graphql: ${messages.join("; ")}`
          : "Cloudflare API POST /graphql: missing data",
      );
    }
    return json.data;
  };

  const paginate = async <T>(path: string, map: (row: unknown) => T | null): Promise<T[]> => {
    const collected: T[] = [];
    let page = 1;
    const perPage = 1000;
    const joiner = path.includes("?") ? "&" : "?";

    for (;;) {
      const envelope = await request("GET", `${path}${joiner}page=${page}&per_page=${perPage}`);
      const batch = Array.isArray(envelope.result) ? envelope.result : [];
      for (const row of batch) {
        const mapped = map(row);
        if (mapped) collected.push(mapped);
      }

      const info = envelope.result_info;
      if (info?.total_count !== undefined && collected.length >= info.total_count) break;
      if (info?.total_pages !== undefined && page >= info.total_pages) break;
      if (batch.length < perPage) break;
      page += 1;
      if (page > 1000) fail(`Cloudflare API GET ${path}: pagination exceeded 1000 pages`);
    }
    return collected;
  };

  const asList = (row: unknown): GatewayList | null => {
    if (!isRecord(row) || typeof row.id !== "string" || typeof row.name !== "string") return null;
    return {
      id: row.id,
      name: row.name,
      description: typeof row.description === "string" ? row.description : undefined,
      type: typeof row.type === "string" ? row.type : undefined,
      count: typeof row.count === "number" ? row.count : undefined,
    };
  };

  const asItem = (row: unknown): GatewayListItem | null => {
    if (!isRecord(row) || typeof row.value !== "string") return null;
    return {
      value: row.value,
      description: typeof row.description === "string" ? row.description : undefined,
    };
  };

  const asRule = (row: unknown): GatewayRule | null => {
    if (!isRecord(row) || typeof row.id !== "string" || typeof row.name !== "string") return null;
    return {
      id: row.id,
      name: row.name,
      precedence: typeof row.precedence === "number" ? row.precedence : undefined,
      action: typeof row.action === "string" ? row.action : undefined,
      enabled: typeof row.enabled === "boolean" ? row.enabled : undefined,
      traffic: typeof row.traffic === "string" ? row.traffic : undefined,
      filters: Array.isArray(row.filters)
        ? row.filters.filter((item): item is string => typeof item === "string")
        : undefined,
    };
  };

  const listLists = (): Promise<GatewayList[]> => paginate("/gateway/lists", asList);

  const getList = async (listId: string): Promise<GatewayList> => {
    const envelope = await request("GET", `/gateway/lists/${listId}`);
    const mapped = asList(envelope.result);
    if (!mapped) {
      throw new CloudflareApiError(
        redactSecrets(`Cloudflare API GET /gateway/lists/${listId}: missing list`, [token]),
      );
    }
    return mapped;
  };

  const listListItems = (listId: string): Promise<GatewayListItem[]> =>
    paginate(`/gateway/lists/${listId}/items`, asItem);

  const listRules = (): Promise<GatewayRule[]> => paginate("/gateway/rules", asRule);

  return {
    accountId,
    request,
    graphql,
    listLists,
    getList,
    listListItems,
    listRules,
    ownedLists: async (prefix: string) => (await listLists()).filter((row) => isOwnedName(row.name, prefix)),
    ownedRules: async (prefix: string) => (await listRules()).filter((row) => isOwnedName(row.name, prefix)),
  };
}
