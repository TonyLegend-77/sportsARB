import { useState, useEffect } from 'react';
import { getSignals, type SignalsResponse } from '../lib/api';

// Server edge-caches ~60s (arbitrage) / ~5min (screen); polling faster gains nothing.
const POLL_INTERVAL_MS = 60_000;

export function useSignals() {
  const [data, setData] = useState<SignalsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const result = await getSignals();
        if (alive) {
          setData(result);
          setError(null);
        }
      } catch (err) {
        if (alive) setError(err instanceof Error ? err : new Error('unknown error'));
      } finally {
        if (alive) setLoading(false);
      }
    }
    load();
    const t = setInterval(load, POLL_INTERVAL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  return { data, loading, error };
}
