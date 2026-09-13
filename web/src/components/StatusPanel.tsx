import type { SaleState, Status } from '../lib/sale.ts';

export function StatusPanel({
  status,
  displayState,
  unreachable,
}: {
  status: Status | null;
  displayState: SaleState | null;
  unreachable: boolean;
}) {
  return (
    <section className="card status">
      <StatusBadge status={status} displayState={displayState} unreachable={unreachable} />
      {unreachable && !status && (
        <p className="note note-error">Can't reach the sale API. Retrying…</p>
      )}
      {status && (
        <>
          <div className="stock">
            <span className="stock-remaining">{status.remaining}</span>
            <span className="stock-total"> / {status.totalStock}</span>
            <div className="stock-label">remaining</div>
          </div>
          <div className="times">
            <div><span>Opens:</span> {new Date(status.startsAt).toLocaleString()}</div>
            <div><span>Closes:</span> {new Date(status.endsAt).toLocaleString()}</div>
          </div>
        </>
      )}
    </section>
  );
}

function StatusBadge({
  status,
  displayState,
  unreachable,
}: {
  status: Status | null;
  displayState: SaleState | null;
  unreachable: boolean;
}) {
  if (unreachable && !status) return <div className="badge badge-error">Offline</div>;
  if (!status || !displayState) return <div className="badge badge-loading">Loading…</div>;
  const label: Record<SaleState, string> = {
    upcoming: 'Upcoming',
    active: 'Live',
    ended: 'Ended',
    sold_out: 'Sold out',
  };
  return (
    <div className={`badge badge-${displayState}`}>
      {unreachable ? 'Reconnecting…' : label[displayState]}
    </div>
  );
}
