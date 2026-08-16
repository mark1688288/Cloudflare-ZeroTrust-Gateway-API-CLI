# cloudflare-zero-trust-gateway-list-CLI

Private-repo GitOps CLI for **Cloudflare Zero Trust Gateway** allowlists and blocklists.

Files in git are the **desired state**. `compile` fetches sources, folds child domains, and writes a snapshot. After you review that snapshot, `apply` aligns Gateway lists and rules whose names start with `gateway-list`. GitHub Actions compiles weekly; **it does not change Cloudflare unless you opt in**.

Allow is its own Gateway list plus an Allow policy with higher precedence than Block. Blocking a parent does not also block a child you have allowed.

## Workflow

Each command does one job: `compile` never writes to Cloudflare, and `apply` never re-fetches sources.

```
Edit allowlist / blocklist / config.yaml
        │
        ▼
     compile          fetch sources, fold, budget → snapshots/desired.json
        │
        ├─ summary    diff vs the previous desired; Job Summary
        ├─ why        explain one domain (allow / block / fold)
        └─ suggested  last week's blocked DNS → allowlist/suggested.txt (copy by hand)
        │
        ├─ lists      live Gateway lists / rules + quota
        └─ diff       desired vs live owned lists
        │
        ▼
  apply --dry-run     plan PATCH / create; write nothing
        │
        ▼
      apply           incremental PATCH of owned lists, then upsert the policy pack
```

To add a remote source or change a personal list, edit `config.yaml` / the `*.txt` files and run `compile`. A new source is labelled `new` (full GET). Later compiles use ETag + SHA-256 to decide `unchanged` (reuse cache) or `updated` (fetch again). If a block set contains both a parent and a child (for example `tracker.example.com` and `ads.tracker.example.com`), the child is folded away so it does not use a list slot.

## Compile

`compile` reads the sources in [`config.yaml`](config.yaml) and merges them into a desired snapshot. It works without a Cloudflare token. With credentials it also reads live list `count` values (read-only), subtracts items on lists you manage by hand, then applies the budget.

Default sources:

| Role | Source | Kind |
| --- | --- | --- |
| allow | `allowlist/personal.txt` | git-managed, highest priority |
| block | `blocklist/personal.txt` | git-managed, next |
| block | [OISD Small](https://small.oisd.nl/) | remote, required |
| block | [HaGeZi Light](https://github.com/hagezi/dns-blocklists) | remote, required |

Personal sources always beat remotes (higher priority). If the same domain appears more than once, only the highest-priority entry is kept. Add another remote block source under `sources.block` if you need one; the defaults stay conservative on purpose.

Writes:

- `snapshots/desired.json` — allow / block / folded (this is what `apply` uses)
- `snapshots/dropped.json` — domains dropped for budget
- `snapshots/sources.json` — per-source ETag, SHA-256, and `new` / `unchanged` / `updated`
- `snapshots/account-quota.json` — only when credentials are present

All of those are gitignored. Remote bodies are stored at `snapshots/cache/<id>.txt`.

### ETag and SHA-256

Remotes are not downloaded in full every week. Each compile records the source **ETag** (HTTP) and the **SHA-256** of the body.

1. Read that source's previous `sha256` and `etag` from `snapshots/sources.json`.
2. Read `snapshots/cache/<id>.txt`. The cache is valid only if it exists and `sha256(cache)` **exactly matches** the previous hash. A mismatch is treated as no cache.
3. Send `If-None-Match: <etag>` only when the cache is valid. Only **one** ETag is sent (OISD returns 503 if the header is a comma-separated list).
4. Requests pin `Accept-Encoding: identity` so the stored ETag matches the bytes that are hashed (OISD sends `Vary: Accept-Encoding`).
5. **304** → reuse the cache; do not download the body. 304 with an invalid cache → GET again without `If-None-Match`.
6. **200** → overwrite the cache with the new body and hash it.
7. Compare to the previous SHA-256: no previous hash → `new` (first compile, or you added a source); same → `unchanged`; different → `updated`.

A failed cache write does not fail compile; the next run falls back to a full GET. A required remote that parses to 0 domains aborts. An optional source that fails is skipped and marked `optional-failed`.

### Fold

After block sources are merged, child domains are folded. Gateway Allow / Block rules use:

```
any(dns.domains[*] in $LIST) or dns.fqdn in $LIST
```

`dns.domains` is the suffix chain, so `tracker.example.com` in the list already covers `ads.tracker.example.com`. Keeping the child would waste a slot.

- Only **block** is folded. Allow stays as written.
- Folding stops at the public suffix (nothing is folded into `co.uk` or `github.io`).
- Folded children are recorded in `desired.json` under `folded` and show up in `why`.

Adding a new list or updating a remote runs fold again whenever the new set has a parent/child relationship with what is already there.

### Quota and dropped

Account `max_items` defaults to 300000. Lists you create in the dashboard (names that do not start with `gateway-list`) still count toward that quota. When live counts are available:

```
budget = max_items − other_items
```

Domains over budget are dropped by priority (local / pinned sources are kept first) and written to `dropped.json`. `lists`, `summary`, and `apply` all show compiled + other.

## Safety

Two layers of guards: one stops a truncated download from looking like “delete half the blocklist”, and the other stops a huge apply from hammering the Gateway API.

**Compile** (against the previous `sources.json`):

| `config.yaml` | Default | Effect |
| --- | ---: | --- |
| `abort_if_source_shrinks_pct` | 40 | Abort if a remote lost ≥ 40% of its lines. A truncated or empty file cannot become a mass delete. |

**Apply** (desired vs live owned lists; add/remove caps are skipped on a first apply to an empty account):

| `config.yaml` | Default | Effect |
| --- | ---: | --- |
| `abort_if_allowlist_shrinks` | 10 | Abort if allow would lose ≥ 10 domains |
| `abort_if_adds_over` | 50000 | Abort if the apply would add more than 50k domains |
| `require_review_if_removes_over` | 1000 | Abort if the apply would remove more than 1000 domains |

`apply` itself is an **incremental PATCH** (`append` / `remove` of drift only). It never deletes every list and recreates them. The client uses a token bucket (burst 8, refill 4/s) and retries HTTP 429 with `Retry-After` (up to 5 attempts). If other + desired exceeds `max_items`, apply refuses. A tripped guard fails the job — do not assume a half-applied rule set is in effect.

Only lists and rules whose names start with `gateway-list` are managed. Dashboard-created objects are left alone.

## Policy pack

`apply` upserts these three (names and precedence come from `config.yaml`):

| Precedence | Name | Action | Contents |
| ---: | --- | --- | --- |
| 1000 | `gateway-list:allow` | Allow | personal allow list (and any you add later) |
| 2000 | `gateway-list:security` | Block | Cloudflare security categories |
| 3000 | `gateway-list:block` | Block | compiled block chunks |

Each list holds at most `items_per_list` items (default 1000). If the traffic filter exceeds 4096 characters it is split into `gateway-list:block-1` and so on. An empty allow set disables the Allow rule instead of attaching it to an empty list.

## Review

- `summary` — adds/removes vs the previous desired (top 50), each source as `new` / `unchanged` / `updated`, quota, and suggested. Actions writes this to the Job Summary.
- `why <domain>` — explains the snapshot: source, parent-fold / dropped, whether allow wins, and a best-effort guess at which Gateway policy would match. An allow hit notes that the `dns.domains` suffix match also covers children.
- `suggested` — reads last week's blocked queries from Gateway DNS analytics (`gatewayResolverQueriesAdaptiveGroups`) and writes `allowlist/suggested.txt` plus `snapshots/suggested.json` for review. It **does not** write `personal.txt`, and it **is not** committed (live DNS activity). The token also needs Account Analytics Read; missing that permission is a warning, not a failed compile. To allow a domain, copy it into `allowlist/personal.txt` and compile again.

## Requirements

- Node.js 22+ (24 is fine; uses official type stripping, no `tsc` build)
- A Cloudflare Zero Trust account (Free is enough)
- API token: Account → Zero Trust → Read + Edit; `suggested` also needs Account Analytics Read
- Account ID (store it as an Actions **variable**, not a secret)

## Local

```bash
cd cloudflare-zero-trust-gateway-list-CLI
npm install
cp .env.example .env   # token / account id; needed for lists / diff / apply / suggested

node src/cli.ts --help
node src/cli.ts compile
node src/cli.ts summary        # Job Summary vs the previous desired
node src/cli.ts lists          # read Gateway lists/rules (needs .env)
node src/cli.ts diff           # desired.json vs live lists; drift is still exit 0
node src/cli.ts why ads.google.com
node src/cli.ts suggested      # last week's blocked domains → allowlist/suggested.txt (never personal)
node src/cli.ts apply --dry-run
node src/cli.ts apply          # write owned gateway-list* lists/rules
npm test
```

## Config

- [`config.yaml`](config.yaml) — sources, account `max_items` (300k), safety thresholds; optional `plan.max_lists`
- [`allowlist/personal.txt`](allowlist/personal.txt) — your allow domains (git-managed)
- [`blocklist/personal.txt`](blocklist/personal.txt) — extra domains you want blocked

One domain per line. Lines starting with `#`, `//`, or `!` are comments; a trailing `#` / `//` is stripped too.

## GitHub Actions (private repo)

1. Use this repository.
2. Secrets:
   - `CLOUDFLARE_API_TOKEN`
3. Variables:
   - `CLOUDFLARE_ACCOUNT_ID`
   - `AUTO_APPLY` (optional; set to `true` to apply on the Monday schedule)
4. [`.github/workflows/sync.yml`](.github/workflows/sync.yml) is already in the repo.
   - Every Monday 03:00 UTC: `compile` + `suggested` + Job Summary + upload the snapshot artifact
   - `workflow_dispatch`: checking apply writes the **artifact's** `desired.json` to Cloudflare
   - Scheduled apply also requires `AUTO_APPLY=true`; a tripped safety guard fails the job
   - No `pull_request` trigger, so a fork PR cannot run apply
   - A push to `main` that touches `src/`, `config.yaml`, allowlist, or blocklist compiles only — it does not apply

Leave `AUTO_APPLY` off at first. Remote sources change every week; read the Job Summary, then run `workflow_dispatch` with apply checked.

## Commands

```
gateway-list compile [--config config.yaml]
gateway-list summary [--config config.yaml]
gateway-list lists   [--config config.yaml]
gateway-list diff    [--config config.yaml]
gateway-list apply   [--config config.yaml] [--dry-run]
gateway-list why     <domain>
gateway-list suggested
```

## Docs

- [`roadmap.txt`](roadmap.txt) — what might come next
- [`feasibility_study.txt`](feasibility_study.txt) — notes on the Gateway API and why there is an Allow policy

## License

Private repository. All rights reserved unless you add a license later.
