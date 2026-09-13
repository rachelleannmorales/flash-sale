import type { PurchaseOutcome, SaleSnapshot, Store } from '../stores/types.js';

export type SaleState = 'upcoming' | 'active' | 'ended' | 'sold_out';

export interface StatusView {
  saleId: string;
  state: SaleState;
  totalStock: number;
  remaining: number;
  startsAt: string;
  endsAt: string;
  now: string;
}

export type PurchaseResult = PurchaseOutcome;

export class SaleService {
  constructor(private readonly store: Store) {}

  private deriveState(s: SaleSnapshot, now: number): SaleState {
    if (now < s.startsAt) return 'upcoming';
    if (now >= s.endsAt) return 'ended';
    if (s.remaining <= 0) return 'sold_out';
    return 'active';
  }

  async getStatus(): Promise<StatusView> {
    const [snap, now] = await Promise.all([this.store.getSnapshot(), this.store.now()]);
    return {
      saleId: snap.saleId,
      state: this.deriveState(snap, now),
      totalStock: snap.totalStock,
      remaining: snap.remaining,
      startsAt: new Date(snap.startsAt).toISOString(),
      endsAt: new Date(snap.endsAt).toISOString(),
      now: new Date(now).toISOString(),
    };
  }

  async attemptPurchase(userId: string): Promise<PurchaseResult> {
    return this.store.attemptPurchase(userId);
  }

  async hasPurchased(userId: string): Promise<boolean> {
    return this.store.hasPurchased(userId);
  }

  async ping(): Promise<boolean> {
    return this.store.ping();
  }
}
