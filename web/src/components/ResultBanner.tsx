import type { PurchaseView } from '../lib/sale.ts';

export function ResultBanner({ view }: { view: PurchaseView }) {
  switch (view.kind) {
    case 'ok':
      return (
        <p className="note note-success">
          Success! You got one.
        </p>
      );
    case 'already_purchased':
      return <p className="note note-warn">You've already purchased. Only one per user.</p>;
    case 'sold_out':
      return <p className="note note-warn">Sold out — better luck next time.</p>;
    case 'ended':
      return <p className="note note-warn">The sale has ended.</p>;
    case 'not_started':
      return <p className="note note-warn">The sale hasn't started yet.</p>;
    case 'invalid_user':
      return <p className="note note-error">Please enter a valid identifier.</p>;
    case 'rate_limited':
      return <p className="note note-warn">Slow down — you're being rate limited.</p>;
    case 'error':
      return <p className="note note-error">Something went wrong: {view.message}</p>;
    default:
      return null;
  }
}
