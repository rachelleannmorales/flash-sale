import { useCallback, useEffect, useRef, useState } from 'react';
import { ResultBanner } from './components/ResultBanner.tsx';
import { StatusPanel } from './components/StatusPanel.tsx';
import { useSaleStatus } from './hooks/useSaleStatus.ts';
import type { PurchaseView } from './lib/sale.ts';

const USER_LOOKUP_DEBOUNCE_MS = 300;
const BUY_TIMEOUT_MS = 8_000;

interface PurchaseBody {
  status?: string;
  userId?: string;
  remaining?: number;
  error?: string;
}

export default function App() {
  const { status, statusUnreachable, displayState, refreshStatus } = useSaleStatus();
  const [userId, setUserId] = useState('');
  const [alreadyPurchased, setAlreadyPurchased] = useState<boolean | null>(null);
  const [view, setView] = useState<PurchaseView>({ kind: 'idle' });
  const buyAbortRef = useRef<AbortController | null>(null);
  const userIdRef = useRef(userId);
  userIdRef.current = userId;

  const isCurrentUser = (who: string) => userIdRef.current.trim() === who;

  useEffect(() => {
    buyAbortRef.current?.abort();
    setAlreadyPurchased(null);
    setView({ kind: 'idle' });
    const trimmed = userId.trim();
    if (!trimmed) return;

    const ac = new AbortController();
    const timeout = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/sale/purchase/${encodeURIComponent(trimmed)}`,
          { signal: ac.signal },
        );
        if (!res.ok || !isCurrentUser(trimmed)) return;
        const body = await res.json();
        setAlreadyPurchased(Boolean(body.purchased));
      } catch {
        /* aborted or transient */
      }
    }, USER_LOOKUP_DEBOUNCE_MS);

    return () => {
      clearTimeout(timeout);
      ac.abort();
    };
  }, [userId]);

  const buy = useCallback(async () => {
    const trimmed = userId.trim();
    if (!trimmed) {
      setView({ kind: 'invalid_user' });
      return;
    }

    buyAbortRef.current?.abort();
    const ac = new AbortController();
    buyAbortRef.current = ac;
    const timeoutId = setTimeout(() => ac.abort(), BUY_TIMEOUT_MS);

    setView({ kind: 'pending' });
    try {
      const res = await fetch('/api/sale/purchase', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: trimmed }),
        signal: ac.signal,
      });
      const body = (await res.json().catch(() => ({}))) as PurchaseBody;
      if (!isCurrentUser(trimmed)) return;

      if (res.status === 201 && body.status === 'ok') {
        setView({ kind: 'ok', remaining: body.remaining ?? 0 });
        setAlreadyPurchased(true);
      } else if (res.status === 409) {
        switch (body.status) {
          case 'already_purchased': setView({ kind: 'already_purchased' }); break;
          case 'sold_out':          setView({ kind: 'sold_out' }); break;
          case 'ended':             setView({ kind: 'ended' }); break;
          case 'not_started':       setView({ kind: 'not_started' }); break;
          default:                  setView({ kind: 'error', message: 'unexpected_conflict' });
        }
      } else if (res.status === 400) {
        setView({ kind: 'invalid_user' });
      } else if (res.status === 429) {
        setView({ kind: 'rate_limited' });
      } else if (res.status === 503) {
        setView({ kind: 'error', message: 'Service temporarily unavailable' });
      } else {
        setView({ kind: 'error', message: `HTTP ${res.status}` });
      }
    } catch (err) {
      if (!isCurrentUser(trimmed)) return;
      if ((err as Error).name === 'AbortError' && buyAbortRef.current !== ac) return;
      const msg = (err as Error).name === 'AbortError'
        ? 'Request timed out — please try again.'
        : (err as Error).message;
      setView({ kind: 'error', message: msg });
    } finally {
      clearTimeout(timeoutId);
      if (buyAbortRef.current === ac) buyAbortRef.current = null;
      void refreshStatus();
    }
  }, [userId, refreshStatus]);

  return (
    <main className="page">
      <header className="hero">
        <h1>Flash Sale</h1>
        <p className="tagline">One item per user. Limited stock. Good luck.</p>
      </header>

      <StatusPanel
        status={status}
        displayState={displayState}
        unreachable={statusUnreachable}
      />

      <section className="card">
        <label className="field">
          <span>User identifier</span>
          <input
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            placeholder="e.g. test@example.com"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            inputMode="email"
          />
        </label>

        {alreadyPurchased === true && view.kind !== 'ok' && (
          <p className="note note-success">You've already secured an item on this sale.</p>
        )}

        <button
          className="buy"
          onClick={buy}
          disabled={
            view.kind === 'pending' ||
            !status ||
            displayState !== 'active' ||
            alreadyPurchased === true
          }
        >
          {view.kind === 'pending' ? 'Buying…' : 'Buy Now'}
        </button>

        <ResultBanner view={view} />
      </section>
    </main>
  );
}
