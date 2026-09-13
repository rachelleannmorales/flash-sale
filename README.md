# Flash Sale

## Monorepo layout

npm workspaces. Two independently deployable services, each on its own port.

```
flash-sale-system/
├── package.json              ← workspaces + top-level scripts
├── docker-compose.yml        ← postgres + redis + api + web
├── docs/architecture.md      ← system diagram, deeper design notes
│
├── api/                      ← @flash-sale/api   →  http://localhost:3000
│   ├── src/
│   │   ├── stores/           ← PostgresStore (FOR UPDATE + database NOW())
│   │   ├── services/         ← pure formatter — no correctness logic lives here
│   │   ├── routes/           ← 3 sale endpoints + /livez /readyz
│   │   ├── server.ts         ← Express bootstrap
│   │   ├── config.ts         ← env-driven config
│   │   └── index.ts          ← entrypoint
│   ├── tests/
│   │   ├── unit/             ← store & service semantics
│   │   ├── integration/      ← full HTTP stack + 2000-request concurrency
│   │   └── stress/           ← live-server correctness + autocannon RPS
│   └── Dockerfile
│
└── web/                      ← @flash-sale/web   →  http://localhost:5173
    ├── src/
    │   ├── App.tsx           ← page
    │   ├── components/       ← status card, buy banners
    │   ├── hooks/            ← status poll + clock
    │   └── lib/              ← sale types + window helpers
    ├── vite.config.ts        ← proxies /api → api service
    ├── Dockerfile            ← nginx-served build
    └── nginx.conf
```



### Ports at a glance


| Service  | Package              | Local dev | Docker Compose host | Configured by  |
| -------- | -------------------- | --------- | ------------------- | -------------- |
| API      | `@flash-sale/api`    | **3000**  | **3080**            | `PORT` env     |
| Web      | `@flash-sale/web`    | **5173**  | **5173**            | `WEB_PORT` env |
| Postgres | `postgres:16-alpine` | **5432**  | **5433**            | `DATABASE_URL` |
| Redis    | `redis:7-alpine`     | **6379**  | **6380**            | `REDIS_URL`    |


---

## Architecture

Stateless API replicas + Postgres (stock / buyers) + Redis (shared rate-limit counter).

```
                ┌────────────────────────┐
                │  web (React, Vite)     │ :5173
                │  polls status, POST buy│
                └───────────┬────────────┘
                            │  HTTP/JSON  (same origin via Vite / nginx proxy)
                            ▼
        ┌──────────────────────────────────────┐
        │   api × N  (Node, TS, Express)       │   scale-out: add replicas
        │  /livez  /readyz                     │   (no in-process sale state)
        │  GET  /api/sale/status               │  ── SELECT sale + NOW()
        │  POST /api/sale/purchase             │  ── rate limit → Redis; then FOR UPDATE
        │  GET  /api/sale/purchase/:userId     │  ── SELECT purchase
        └───────┬──────────────────┬───────────┘
                │                  │
                │                  ▼
                │         ┌─────────────────┐
                │         │ Redis           │   shared 429 budget across pods
                │         │ (rate-limit)    │
                │         └─────────────────┘
                │
                │  BEGIN … FOR UPDATE … COMMIT
                ▼
        ┌───────────────────┐
        │     Postgres      │   one sale row + purchases
        │  sales            │
        │  purchases        │   UNIQUE (sale_id, user_id)
        └───────────────────┘
```

**The correctness primitive is one Postgres transaction**
(`[api/src/stores/postgresStore.ts](api/src/stores/postgresStore.ts)`).
`SELECT … FOR UPDATE` on the sale row means a second concurrent buyer
**waits**, then sees the updated stock and buyer list. A `UNIQUE (sale_id, user_id)`
constraint is a second seatbelt. The window is checked inside that same
transaction against database `NOW()`, and `GET /api/sale/status` also reads
`NOW()` from the store — so a pod's local clock skew cannot leak into the
correctness invariant or the state shown to users.

APIs scale out; stock and buyers live in Postgres. Concurrent Buys wait on
the sale-row lock, then see the updated stock. If Postgres is slow or the
pool is full, the API returns **503** instead of hanging.

The Express layer is deliberately dumb: request in, transaction, response
out. The `Store` [interface](api/src/stores/types.ts) is the seam
`SaleService` talks to. The only implementation is `PostgresStore`. Tests hit
a real Postgres (`DATABASE_URL`) so the same transaction, constraints, and
clock run in CI as in a demo.

See `[docs/architecture.md](docs/architecture.md)` for a longer discussion.

---



## Design choices & trade-offs


| Decision                                                  | Why                                                                                                                                                                                                                                                                                                                      | Trade-off                                                                                                                                                     |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Postgres** `SELECT … FOR UPDATE` (inventory, not Redis) | One sale row, one lock. Concurrent buys serialise; no oversell. `UNIQUE (sale_id, user_id)` rejects a second insert. The locked work is tiny (window, stock, buyer, decrement, insert), so thousands of req/s still complete - APIs scale out; only that short txn is serial. Redis stays the 429 budget, not inventory. | Buys wait their turn on that row. Fine for this sale. A cache or queue in front of this same txn only becomes worth it at six-digit req/s (~100k+). |
| **Decrement and insert in one transaction**               | Crash mid-flight rolls back. No "name on the list, no item" and no leaked slot.                                                                                                                                                                                                                                          | Slightly more lock time than a single `UPDATE`. Worth it for a clear story.                                                                                   |
| **Rate limit by userId; counters in Redis**               | Buy requires `userId` (400 if missing). Key = that id so one user cannot spend everyone else's budget. Redis means N API pods share one `RATE_LIMIT_MAX`.                                                                                                                                                                | Extra moving part. If Redis blips the limiter **fails open** (`passOnStoreError`) so Buy still hits Postgres. Rate limit is an abuse guard, not the oversell lock.      |
| **Window check inside the transaction, against** `NOW()`  | Same lock as the decrement; database clock so N API pods can't disagree at the window boundary. `GET /status` reads `NOW()` from the store too, so the state a user sees matches the decision the transaction would make.                                                                                                | You can't freeze time in unit tests — window tests use clearly-before / clearly-after sale rows.                                                              |




## Build and run



### Prerequisites

- Node.js ≥ 20 (Node 22+ recommended so `node --experimental-strip-types` works for the stress script)
- (Optional) Docker for Postgres + Redis / one-command full stack



### Install once at the monorepo root

```bash
npm install
```

Pick **one** way to run. Do not combine them — both bind web to :5173.

### Option A — Docker for Postgres + Redis, API and web on the host

Hot reload. API on **:3000**, Vite on **:5173**.

```bash
docker compose up -d postgres redis
DATABASE_URL=postgres://flash:flash@127.0.0.1:5433/flashsale \
REDIS_URL=redis://127.0.0.1:6380 npm run dev
```

```
[api] flash-sale API ready on :3000
[web] Local:  http://localhost:5173/
```

Open [http://localhost:5173](http://localhost:5173).

To start only one process: `npm run dev:api` (:3000) or `npm run dev:web` (:5173).

### Option B — full stack in Docker

Does **not** run Option A. Compose starts Postgres, Redis, API, and web.

```bash
docker compose up --build
# web → http://localhost:5173  (nginx proxies /api to the api container)
# api → http://localhost:3080
# postgres (from the host) → localhost:5433
# redis (from the host) → localhost:6380
```

Compose host ports are **3080** / **5433** / **6380** so this stack can sit next to another project using 3000 / 5432 / 6379. Default `SALE_START` / `SALE_END` in `docker-compose.yml` keep the demo sale open through 2027. Restarting the same `SALE_ID` never restocks — use a new id for a fresh inventory.

### Environment overrides

```bash
PORT=4000 npm run dev:api          # api on :4000
WEB_PORT=8080 npm run dev:web      # web on :8080
API_URL=http://localhost:4000 WEB_PORT=8080 npm run dev:web  # point web at a non-default api
```

---



## Testing

From the monorepo root:

```bash
docker compose up -d postgres redis
DATABASE_URL=postgres://flash:flash@127.0.0.1:5433/flashsale \
REDIS_URL=redis://127.0.0.1:6380 npm test
```

HTTP tests also need **Redis** (shared rate-limit counter). CI starts `postgres:16` on :5432 and `redis:7` on :6379. Locally, Compose publishes :5433 / :6380. If either is missing, tests fail with a start command — they do not skip.

- **Store tests** (`postgres.test.ts`): oversell burst, one-per-user, restart-safe init, window vs `NOW()`, unique constraint `23505`.
- **HTTP tests**: Express + `supertest` against that same store — status codes, rate-limit-per-user (including two processes sharing one Redis budget), window 409s, a 2 000-request concurrency run (`successes == stock`).



## Stress testing

Neither script starts the API. Point them at a **live** sale (`state: "active"`),
or every request comes back `409 ended` / `not_started` and stock will not move.


| How the API is running                  | Stress target                            |
| --------------------------------------- | ---------------------------------------- |
| `npm run dev:api` / `npm run start:api` | `http://127.0.0.1:3000` (script default) |
| `docker compose up` (api service)       | `API_URL=http://127.0.0.1:3080`          |


Raise `RATE_LIMIT_MAX` for the run, or you will mostly see `429` instead of `sold_out`.
A restart of the same `SALE_ID` does not refill `remaining` — use a new id for a fresh stock.

### `runStress.ts` — correctness under load (`npm run stress`)

Fires N concurrent purchases and **fails** if anyone oversells, stock goes negative, or the network errors.

**Host API (port 3000):**

```bash
# Terminal 1 — wide window, high rate-limit, known stock
DATABASE_URL=postgres://flash:flash@127.0.0.1:5433/flashsale \
REDIS_URL=redis://127.0.0.1:6380 \
SALE_ID=stress-demo TOTAL_STOCK=100 \
SALE_START=2020-01-01T00:00:00Z SALE_END=2099-01-01T00:00:00Z \
RATE_LIMIT_MAX=1000000 npm run dev:api

# Terminal 2
REQUESTS=5000 CONCURRENCY=200 UNIQUE_USERS=5000 npm run stress
```

**Compose API (port 3080):**

```bash
SALE_ID=stress-demo TOTAL_STOCK=100 \
SALE_START=2020-01-01T00:00:00Z SALE_END=2099-01-01T00:00:00Z \
RATE_LIMIT_MAX=1000000 docker compose up -d --force-recreate api

API_URL=http://127.0.0.1:3080 \
REQUESTS=5000 CONCURRENCY=200 UNIQUE_USERS=5000 npm run stress
```

Expected outcome on a fresh `SALE_ID` with `TOTAL_STOCK=100` and 5 000 unique users:

```
=== Stress results ===
{
  "totalRequests": 5000,
  "concurrency": 200,
  "outcomes": { "ok": 100, "sold_out": 4900, "errors": 0, "rate_limited": 0 },
  "saleBefore": { "state": "active", "remaining": 100 },
  "saleAfter":  { "state": "sold_out", "remaining": 0 }
}
PASS: no oversell, no negative stock, no errors.
```

Absolute RPS / latency vary by machine. What must hold:

- `ok` equals starting `remaining` (here 100)
- `ok + sold_out + already_purchased` equals `REQUESTS` (no silent drops)
- `saleAfter.remaining == 0`
- `errors == 0`

If `saleBefore.state` is `ended` and `ok` is 0, the window is closed — recreate the API with `SALE_END` in the future. If `errors` is ~`REQUESTS`, nothing is listening on that port (3000 vs 3080).

### `autocannon.ts` — raw throughput (`npm run stress:autocannon`)

Hammers `POST /api/sale/purchase` for a duration and prints RPS + latency. Unique `userId` per request so it exercises the decrement path. **Does not check stock** — use `npm run stress` for correctness.

```bash
# host API
DURATION=15 CONNECTIONS=200 npm run stress:autocannon --workspace=@flash-sale/api

# Compose API
API_URL=http://127.0.0.1:3080 DURATION=15 CONNECTIONS=200 \
  npm run stress:autocannon --workspace=@flash-sale/api
```

Expected outcome: an autocannon table (latency percentiles, requests/sec). On a live sale you should see a mix of **201** (until stock is gone) and **409** (sold out / already purchased). A wall of **409** with `ended` in the API logs means the window is closed; a wall of **429** means raise `RATE_LIMIT_MAX`. Typical local host-dev numbers are on the order of thousands of RPS with p99 in tens of milliseconds — treat that as a machine-specific hint, not a SLO.