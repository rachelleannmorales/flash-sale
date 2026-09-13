/**
 * Throughput-focused stress test using autocannon.
 *
 * Fires purchase requests continuously for a fixed duration. Each request uses
 * a unique userId so we actually exercise the atomic decrement path.
 *
 * Note: this measures raw throughput of the API + store. For correctness
 * verification (no oversell), use `runStress.ts` — it inspects sale state.
 */

// @ts-expect-error autocannon ships no types; usage is typed locally below
import autocannon from 'autocannon';

type Req = { method: string; headers: Record<string, string>; body: string };
type AC = {
  (opts: unknown, cb: (err: Error | null, result: unknown) => void): unknown;
  track: (instance: unknown, opts: unknown) => void;
  printResult: (result: unknown) => string;
};
const ac = autocannon as unknown as AC;

const URL = process.env.API_URL ?? 'http://127.0.0.1:3000';
const DURATION = Number(process.env.DURATION ?? '15');
const CONNECTIONS = Number(process.env.CONNECTIONS ?? '200');
const PIPELINING = Number(process.env.PIPELINING ?? '1');

const instance = ac(
  {
    url: `${URL}/api/sale/purchase`,
    connections: CONNECTIONS,
    pipelining: PIPELINING,
    duration: DURATION,
    requests: [
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: 'placeholder' }),
        setupRequest(req: Req) {
          const uid = `ac-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
          req.body = JSON.stringify({ userId: uid });
          return req;
        },
      },
    ],
  },
  (err, result) => {
    if (err) {
      console.error(err);
      process.exit(1);
    }
    console.log(ac.printResult(result));
  },
);

ac.track(instance, { renderProgressBar: true, renderLatencyTable: true });
