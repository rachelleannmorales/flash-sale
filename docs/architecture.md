# Architecture

## Component diagram

```
┌────────────────────┐      HTTP/JSON      ┌────────────────────────────┐
│  web (React :5173) │ ───────────────────▶│  api × N (Express)         │
│                    │                     │  /livez  /readyz           │
│  • polls status    │◀─────────────────── │  • Rate limit (Redis)     │
│  • POST purchase   │                     │  • zod validation          │
│  • checks own state│                     │                            │
└────────────────────┘                     └───────┬───────────┬────────┘
                                                   │           │
                                                   │           ▼
                                                   │    ┌─────────────────┐
                                                   │    │ Redis           │
                                                   │    │ shared 429 cap  │
                                                   │    └─────────────────┘
                                                   │
                                      BEGIN … FOR UPDATE … COMMIT
                                                   │
                                                   ▼
                              ┌────────────────────────────────────────┐
                              │  Postgres  — one sale row + purchases  │
                              │  sales       remaining, window         │
                              │  purchases   (sale_id, user_id) UNIQUE │
                              └────────────────────────────────────────┘
```



## Concurrency model

The only place where correctness matters is **the sequence of two operations**:

1. Check whether `userId` is already in `purchases`.
2. If not, and stock > 0: decrement `remaining`, insert the buyer.

If those aren't in one transaction, two things can go wrong:

- Two purchases from the same user can both "check first" (both see no row), then both insert.
- N + 1 successful purchases when stock is N, because N processes all see `remaining=1`.

The sale row is locked with `SELECT … FOR UPDATE` inside a transaction. Postgres
grants that lock to **one** transaction at a time. The second buyer waits,
then sees the updated `remaining` and the new `purchases` row.

`UNIQUE (sale_id, user_id)` is a second seatbelt: a duplicate insert becomes
`already_purchased` (`23505`) instead of a second item.

The sale window is checked **inside the same transaction**, against `NOW()`,
so two API pods with NTP skew cannot disagree about open/close.

```
BEGIN
  SELECT remaining, starts_at, ends_at FROM sales WHERE sale_id = $1 FOR UPDATE
  if now < starts_at          → not_started
  if now >= ends_at           → ended
  if user already in purchases → already_purchased
  if remaining = 0            → sold_out
  UPDATE sales SET remaining = remaining - 1
  INSERT INTO purchases
COMMIT
```



## Why not other approaches?

- **Redis Lua for stock.** Fast under a stampede, but if Lua decrements before Postgres commits, Lua can say "yes" first — a second source of truth. That belongs **in front of** this same transaction only if one locked row is no longer enough. Not instead of Postgres; the database stays who bought.
- **A queue.** Lines people up; the worker still runs this transaction. "Yes" is the commit, not enqueue. Different UX (wait), not a second stock counter.
- **A distributed lock (Redlock).** Adds latency, still needs a table to record the outcome, and is easy to get wrong when locks expire. Skip it — the row lock *is* the lock.
- **In-memory only.** Breaks as soon as two API processes run — each has its own stock. There is no memory store; tests use the same Postgres transaction as production.
- **Optimistic** `UPDATE … WHERE remaining > 0` **without a lock.** Works if the insert is in the same transaction; easier to leave a TOCTOU gap. `FOR UPDATE` makes the serialisation obvious.



## Failure modes and how they're handled


| Failure                           | Effect                                                                                                                                                                                                                          | Mitigation                                                                                   |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| API pod crashes mid-request       | Client retries. Unique `(sale_id, user_id)` makes the retry `already_purchased` if the first commit landed.                                                                                                                     | Transaction + unique constraint.                                                             |
| Crash after UPDATE, before INSERT | Transaction rolls back. No leaked slot, no phantom buyer.                                                                                                                                                                       | One transaction.                                                                             |
| Two pods boot at once             | `CREATE TABLE IF NOT EXISTS` races Postgres system catalogs; without protection one pod loses to "tuple concurrently updated" and crash-loops. Re-init updates the window from env and never refills `remaining`.               | `pg_advisory_xact_lock` around DDL + `ON CONFLICT` that only writes `starts_at` / `ends_at`. |
| Postgres is unreachable           | In-flight requests return **503** `{ error: "store_unavailable" }`. `/readyz` also 503 so the LB drains the pod.                                                                                                                | Express error handler maps `pg` connection errors.                                           |
| Postgres is slow / hung           | A single query can't wedge an API worker forever. `statement_timeout=3s`, `lock_timeout=5s`, and `idle_in_transaction_session_timeout=10s` cap the damage; the API returns **503** (`55P03` / `57014`) so the client can retry. | Sent in the connection startup packet by `PostgresStore`.                                    |
| Legit traffic spike               | Connections queue on the pool, then on the sale-row lock. Rate limit is a Redis counter shared by every API replica.                                                                                                            | Scale API pods; overflow is 503.                                                             |
| Redis unreachable at boot         | Process refuses to start.                                                                                                                                                                                                       | Same honesty as a missing `DATABASE_URL`.                                                    |
| Redis dies mid-sale               | Limiter **fails open**; Buy still hits Postgres. No 429s until Redis returns.                                                                                                                                                   | Abuse guard must not take the cash register down.                                            |
| Clock skew between pods           | Two API pods with drifting NTP can't disagree about "is the sale open?" — both the transaction and `GET /status` read `NOW()` from Postgres, not their local clocks.                                                            | Database `NOW()` inside the transaction; `Store.now()` used by the status view.              |
| Bot spam from one user            | First win commits; the rest wait the lock then get `409 already_purchased`.                                                                                                                                                     | Unique constraint + lock.                                                                    |


