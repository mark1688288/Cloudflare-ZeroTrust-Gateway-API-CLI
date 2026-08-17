import assert from "node:assert/strict";
import { test } from "node:test";
import { FETCH_ACCEPT_ENCODING, fetchBytes, fetchText, HttpError, retryAfterMs } from "./fetch-source.ts";

function mockFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): typeof fetch {
  return (async (input, init) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return handler(url, init);
  }) as typeof fetch;
}

test("200 returns text and etag", async () => {
  let acceptEncoding = "";
  let ifNoneMatch: string | null = null;
  const fetched = await fetchText("https://small.oisd.nl/", {
    fetch: mockFetch((_url, init) => {
      const headers = new Headers(init?.headers);
      acceptEncoding = headers.get("accept-encoding") ?? "";
      ifNoneMatch = headers.get("if-none-match");
      return new Response("||ads.example.com^\n", {
        status: 200,
        headers: { etag: '"abc"' },
      });
    }),
  });
  assert.equal(fetched.status, 200);
  assert.equal(fetched.text, "||ads.example.com^\n");
  assert.equal(fetched.etag, '"abc"');
  assert.equal(acceptEncoding, FETCH_ACCEPT_ENCODING);
  assert.equal(ifNoneMatch, null);
});

test("sends one If-None-Match and treats 304 as success", async () => {
  let ifNoneMatch: string | null = null;
  const fetched = await fetchText("https://small.oisd.nl/", {
    ifNoneMatch: '"6a7fbb38-13470b"',
    fetch: mockFetch((_url, init) => {
      const headers = new Headers(init?.headers);
      ifNoneMatch = headers.get("if-none-match");
      return new Response(null, { status: 304, headers: { etag: '"6a7fbb38-13470b"' } });
    }),
  });
  assert.equal(ifNoneMatch, '"6a7fbb38-13470b"');
  assert.equal(fetched.status, 304);
  assert.equal(fetched.text, "");
  assert.equal(fetched.etag, '"6a7fbb38-13470b"');
});

test("fetchBytes returns the body and treats 304 as empty success", async () => {
  const body = Uint8Array.from([1, 2, 3, 4]);
  const fetched = await fetchBytes("https://git.io/GeoLite2-ASN.mmdb", {
    fetch: mockFetch(() => new Response(body, { status: 200, headers: { etag: '"m1"' } })),
  });
  assert.equal(fetched.status, 200);
  assert.deepEqual(fetched.bytes, body);
  assert.equal(fetched.etag, '"m1"');

  const notModified = await fetchBytes("https://git.io/GeoLite2-ASN.mmdb", {
    ifNoneMatch: '"m1"',
    fetch: mockFetch(() => new Response(null, { status: 304, headers: { etag: '"m1"' } })),
  });
  assert.equal(notModified.status, 304);
  assert.equal(notModified.bytes.length, 0);
});

test("404 is not retried", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      fetchText("https://example.com/missing", {
        fetch: mockFetch(() => {
          calls += 1;
          return new Response("nope", { status: 404 });
        }),
        maxAttempts: 3,
      }),
    (error: unknown) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.status, 404);
      return true;
    },
  );
  assert.equal(calls, 1);
});

test("500 then 200 retries", async () => {
  let calls = 0;
  const sleeps: number[] = [];
  const fetched = await fetchText("https://small.oisd.nl/", {
    fetch: mockFetch(() => {
      calls += 1;
      if (calls === 1) return new Response("err", { status: 500 });
      return new Response("||ok.example.com^\n", { status: 200 });
    }),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    backoffMs: 10,
  });
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [10]);
  assert.match(fetched.text, /ok\.example\.com/);
});

test("429 honours Retry-After", async () => {
  let calls = 0;
  const sleeps: number[] = [];
  await fetchText("https://small.oisd.nl/", {
    fetch: mockFetch(() => {
      calls += 1;
      if (calls === 1) {
        return new Response("slow", { status: 429, headers: { "retry-after": "2" } });
      }
      return new Response("ok", { status: 200 });
    }),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    maxRetryAfterMs: 30_000,
  });
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [2000]);
});

test("retryAfterMs caps and falls back", () => {
  const retry = new Response("", { headers: { "retry-after": "99" } });
  assert.equal(retryAfterMs(retry, 5_000, 1000), 5_000);
  const none = new Response("");
  assert.equal(retryAfterMs(none, 5_000, 1500), 1500);
});
