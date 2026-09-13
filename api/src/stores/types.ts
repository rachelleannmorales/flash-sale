export type PurchaseOutcome =
  | { status: 'ok'; remaining: number }
  | { status: 'already_purchased' }
  | { status: 'sold_out' }
  | { status: 'not_started' }
  | { status: 'ended' };

export interface SaleSnapshot {
  saleId: string;
  totalStock: number;
  remaining: number;
  startsAt: number; // epoch ms
  endsAt: number; // epoch ms
}

export interface Store {
  init(snapshot: SaleSnapshot): Promise<void>;

  getSnapshot(): Promise<SaleSnapshot>;

  attemptPurchase(userId: string): Promise<PurchaseOutcome>;

  hasPurchased(userId: string): Promise<boolean>;

  now(): Promise<number>;

  ping(): Promise<boolean>;

  close(): Promise<void>;
}
