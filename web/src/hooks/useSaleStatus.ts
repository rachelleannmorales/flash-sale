import { useCallback, useEffect, useRef, useState } from 'react';
import { deriveState, isTerminal, nextPollDelayMs, type SaleState, type Status } from '../lib/sale.ts';

export function useSaleStatus() {
  const [status, setStatus] = useState<Status | null>(null);
  const [statusUnreachable, setStatusUnreachable] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const statusRef = useRef<Status | null>(null);
  const clockOffsetMs = useRef(0);

  const applyStatus = useCallback((next: Status) => {
    clockOffsetMs.current = Date.parse(next.now) - Date.now();
    statusRef.current = next;
    setStatus(next);
    setNowMs(Date.now() + clockOffsetMs.current);
  }, []);

  const refreshStatus = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await fetch('/api/sale/status', { signal });
      if (!res.ok) {
        setStatusUnreachable(true);
        return;
      }
      applyStatus((await res.json()) as Status);
      setStatusUnreachable(false);
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      setStatusUnreachable(true);
    }
  }, [applyStatus]);

  const displayState: SaleState | null = status
    ? deriveState(status.startsAt, status.endsAt, status.remaining, nowMs)
    : null;

  useEffect(() => {
    if (!status || displayState === 'ended') return;
    const now = Date.now() + clockOffsetMs.current;
    const start = Date.parse(status.startsAt);
    const end = Date.parse(status.endsAt);
    const next = now < start ? start : end;
    if (now >= end) return;
    const id = setTimeout(
      () => setNowMs(Date.now() + clockOffsetMs.current),
      Math.max(0, next - now),
    );
    return () => clearTimeout(id);
  }, [status, displayState]);

  const shouldPoll = displayState !== 'sold_out' && displayState !== 'ended';

  useEffect(() => {
    if (!shouldPoll) return;
    const ac = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;

    const clearTimer = () => {
      if (timer) { clearTimeout(timer); timer = null; }
    };

    const schedule = () => {
      clearTimer();
      const snap = statusRef.current;
      if (!snap) return;
      const now = Date.now() + clockOffsetMs.current;
      if (isTerminal(snap, now)) return;
      const delay = nextPollDelayMs(snap, now);
      if (delay == null) return;
      timer = setTimeout(() => {
        void refreshStatus(ac.signal).then(() => {
          if (!ac.signal.aborted && document.visibilityState === 'visible') schedule();
        });
      }, delay);
    };

    const start = () => {
      const snap = statusRef.current;
      if (snap && isTerminal(snap, Date.now() + clockOffsetMs.current)) return;
      void refreshStatus(ac.signal).then(() => {
        if (!ac.signal.aborted && document.visibilityState === 'visible') schedule();
      });
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible') start();
      else clearTimer();
    };

    onVisibility();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      clearTimer();
      ac.abort();
    };
  }, [refreshStatus, shouldPoll]);

  return { status, statusUnreachable, displayState, refreshStatus };
}
