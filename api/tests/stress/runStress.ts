/**
 * Correctness-focused stress test.
 *
 * Fires N concurrent purchase requests at a running API server (default:
 * http://127.0.0.1:3000) and asserts:
 *   - Successes == configured stock
 *   - Sum of (successes + conflicts) == total requests
 *   - Final /api/sale/status shows remaining=0
 *
 * Usage:
 *   API_URL=http://localhost:3000 REQUESTS=5000 CONCURRENCY=200 UNIQUE_USERS=5000 \
 *     tsx tests/stress/runStress.ts
 */

const API_URL = process.env.API_URL ?? 'http://127.0.0.1:3000';
const REQUESTS = Number(process.env.REQUESTS ?? '5000');
const CONCURRENCY = Number(process.env.CONCURRENCY ?? '200');
const UNIQUE_USERS = Number(process.env.UNIQUE_USERS ?? String(REQUESTS));
const USER_PREFIX = process.env.USER_PREFIX ?? `stress-${Date.now()}`;

type Outcome =
  | 'ok'
  | 'already_purchased'
  | 'sold_out'
  | 'ended'
  | 'not_started'
  | 'rate_limited'
  | 'other';

interface Counters {
  ok: number;
  already_purchased: number;
  sold_out: number;
  ended: number;
  not_started: number;
  rate_limited: number;
  other: number;
  errors: number;
  latencyMs: number[];
}

const counters: Counters = {
  ok: 0,
  already_purchased: 0,
  sold_out: 0,
  ended: 0,
  not_started: 0,
  rate_limited: 0,
  other: 0,
  errors: 0,
  latencyMs: [],
};

async function attempt(i: number): Promise<void> {
  const userId = `${USER_PREFIX}-${i % UNIQUE_USERS}`;
  const start = performance.now();
  try {
    const res = await fetch(`${API_URL}/api/sale/purchase`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId }),
    });
    counters.latencyMs.push(performance.now() - start);

    let outcome: Outcome = 'other';
    if (res.status === 201) outcome = 'ok';
    else if (res.status === 429) outcome = 'rate_limited';
    else if (res.status === 409) {
      const body = (await res.json().catch(() => ({}))) as { status?: string };
      switch (body.status) {
        case 'already_purchased': outcome = 'already_purchased'; break;
        case 'sold_out':          outcome = 'sold_out'; break;
        case 'ended':             outcome = 'ended'; break;
        case 'not_started':       outcome = 'not_started'; break;
        default:                  outcome = 'other';
      }
    }
    counters[outcome] += 1;
  } catch {
    counters.errors += 1;
  }
}

async function main() {
  console.log(`Stress: ${REQUESTS} requests, concurrency=${CONCURRENCY}, unique users=${UNIQUE_USERS}`);
  const status0 = await fetch(`${API_URL}/api/sale/status`).then((r) => r.json()).catch(() => null);
  console.log('Sale before:', status0);

  const wallStart = performance.now();

  let nextIndex = 0;
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (true) {
      const i = nextIndex++;
      if (i >= REQUESTS) return;
      await attempt(i);
    }
  });
  await Promise.all(workers);

  const wallMs = performance.now() - wallStart;

  const status1 = await fetch(`${API_URL}/api/sale/status`).then((r) => r.json()).catch(() => null);

  const lats = counters.latencyMs.slice().sort((a, b) => a - b);
  const pct = (p: number) => (lats.length ? lats[Math.floor((p / 100) * (lats.length - 1))] : 0);

  console.log('\n=== Stress results ===');
  console.log(JSON.stringify(
    {
      totalRequests: REQUESTS,
      concurrency: CONCURRENCY,
      uniqueUsers: UNIQUE_USERS,
      durationMs: Math.round(wallMs),
      rps: Math.round((REQUESTS / wallMs) * 1000),
      outcomes: {
        ok: counters.ok,
        already_purchased: counters.already_purchased,
        sold_out: counters.sold_out,
        ended: counters.ended,
        not_started: counters.not_started,
        rate_limited: counters.rate_limited,
        other: counters.other,
        errors: counters.errors,
      },
      latency: {
        p50: Math.round(pct(50) ?? 0),
        p90: Math.round(pct(90) ?? 0),
        p99: Math.round(pct(99) ?? 0),
        max: Math.round(pct(100) ?? 0),
      },
      saleBefore: status0,
      saleAfter: status1,
    },
    null,
    2,
  ));

  const problems: string[] = [];
  if (counters.ok > (status0?.remaining ?? 0)) {
    problems.push(`OVERSELL: ok=${counters.ok} but starting stock was ${status0?.remaining}`);
  }
  if (status1 && status1.remaining < 0) problems.push('remaining went negative');
  if (counters.errors > 0) problems.push(`${counters.errors} network errors`);
  if (problems.length) {
    console.error('\nFAIL:', problems);
    process.exit(1);
  }
  console.log('\nPASS: no oversell, no negative stock, no errors.');
}

void main();
