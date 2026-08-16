export class HttpError extends Error {
  readonly url: string;
  readonly status: number;

  constructor(url: string, status: number) {
    super(`GET ${url}: HTTP ${status}`);
    this.name = "HttpError";
    this.url = url;
    this.status = status;
  }

  get retryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

export type FetchTextOptions = {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  maxAttempts?: number;
  backoffMs?: number;
  maxRetryAfterMs?: number;
  /** Single previous ETag. Do not pass a comma list (OISD 503s). */
  ifNoneMatch?: string;
};

export type FetchedText = {
  url: string;
  text: string;
  etag: string | null;
  status: number;
};

export const DEFAULT_FETCH_TIMEOUT_MS = 30_000;
export const DEFAULT_FETCH_MAX_ATTEMPTS = 3;
export const DEFAULT_FETCH_BACKOFF_MS = 2_000;
export const DEFAULT_MAX_RETRY_AFTER_MS = 30_000;

const USER_AGENT = "gateway-list/0.0.0 (Cloudflare Gateway list compile)";
/** Pin identity so the stored ETag matches the bytes we hash (OISD Vary: Accept-Encoding). */
export const FETCH_ACCEPT_ENCODING = "identity";

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function retryAfterMs(response: Response, capMs: number, fallbackMs: number): number {
  const raw = response.headers.get("retry-after");
  if (raw) {
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, capMs);
    }
    const when = Date.parse(raw);
    if (!Number.isNaN(when)) {
      return Math.min(Math.max(0, when - Date.now()), capMs);
    }
  }
  return fallbackMs;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

export async function fetchText(url: string, options: FetchTextOptions = {}): Promise<FetchedText> {
  const fetchFn = options.fetch ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_FETCH_MAX_ATTEMPTS;
  const backoffMs = options.backoffMs ?? DEFAULT_FETCH_BACKOFF_MS;
  const capMs = options.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS;

  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const headers: Record<string, string> = {
        accept: "text/plain, text/*, */*",
        "user-agent": USER_AGENT,
        "accept-encoding": FETCH_ACCEPT_ENCODING,
      };
      if (options.ifNoneMatch) headers["if-none-match"] = options.ifNoneMatch;

      const response = await fetchFn(url, {
        redirect: "follow",
        signal: AbortSignal.timeout(timeoutMs),
        headers,
      });

      if (response.status === 200) {
        return {
          url,
          text: await response.text(),
          etag: response.headers.get("etag"),
          status: 200,
        };
      }

      if (response.status === 304) {
        return {
          url,
          text: "",
          etag: response.headers.get("etag"),
          status: 304,
        };
      }

      const httpError = new HttpError(url, response.status);
      if (!httpError.retryable || attempt === maxAttempts) {
        throw httpError;
      }
      lastError = httpError;
      await sleep(retryAfterMs(response, capMs, backoffMs));
      continue;
    } catch (error) {
      if (error instanceof HttpError && !error.retryable) throw error;
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt === maxAttempts) break;
      if (error instanceof HttpError) continue;
      if (isAbortError(error) || lastError.name === "TypeError") {
        await sleep(backoffMs);
        continue;
      }
      throw lastError;
    }
  }
  throw lastError ?? new Error(`GET ${url}: failed`);
}
