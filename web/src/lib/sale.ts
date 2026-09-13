export type SaleState = 'upcoming' | 'active' | 'ended' | 'sold_out';

export interface Status {
  saleId: string;
  state: SaleState;
  totalStock: number;
  remaining: number;
  startsAt: string;
  endsAt: string;
  now: string;
}

export type PurchaseView =
  | { kind: 'idle' }
  | { kind: 'pending' }
  | { kind: 'ok'; remaining: number }
  | { kind: 'already_purchased' }
  | { kind: 'sold_out' }
  | { kind: 'not_started' }
  | { kind: 'ended' }
  | { kind: 'invalid_user' }
  | { kind: 'rate_limited' }
  | { kind: 'error'; message: string };

const POLL_UPCOMING_MS = 8_000;
const POLL_ACTIVE_MS = 4_000;

export function deriveState(
  startsAt: string,
  endsAt: string,
  remaining: number,
  nowMs: number,
): SaleState {
  if (nowMs < Date.parse(startsAt)) return 'upcoming';
  if (nowMs >= Date.parse(endsAt)) return 'ended';
  if (remaining <= 0) return 'sold_out';
  return 'active';
}

export function isTerminal(status: Status, nowMs: number): boolean {
  if (status.remaining <= 0) return true;
  if (status.state === 'sold_out' || status.state === 'ended') return true;
  const phase = deriveState(status.startsAt, status.endsAt, status.remaining, nowMs);
  return phase === 'sold_out' || phase === 'ended';
}

export function nextPollDelayMs(status: Status, nowMs: number): number | null {
  if (isTerminal(status, nowMs)) return null;
  const phase = deriveState(status.startsAt, status.endsAt, status.remaining, nowMs);
  if (phase === 'upcoming') {
    return Math.min(POLL_UPCOMING_MS, Math.max(0, Date.parse(status.startsAt) - nowMs));
  }
  const untilEnd = Date.parse(status.endsAt) - nowMs;
  if (untilEnd <= 0) return null;
  return Math.min(POLL_ACTIVE_MS, untilEnd);
}
