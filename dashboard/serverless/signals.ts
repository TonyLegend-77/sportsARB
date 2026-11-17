/**
 * Source for the `/api/signals` Vercel function (Predictefy cross-venue signals).
 *
 * esbuild entry, same pattern as serverless/markets.ts. The bundle is DB-free and needs no
 * dummy bot env: bot/src/arb/predictefySignalsCore.ts reads process.env directly.
 *
 * Opt-in: returns 404 unless BOTH are set in Vercel (server-side, no VITE_ prefix):
 *   PREDICTEFY_API_KEY=pk_live_...      SIGNALS_ENABLED=true
 *
 * Edge cache protects credits: the arbitrage feed costs 15 credits/call, so s-maxage=60 means upstream
 * is hit at most 1x/min (~648k credits/30 days, Pro includes 2M) no matter how many visitors.
 */
interface RequestLike {
  url?: string;
}
interface ResponseLike {
  setHeader(key: string, value: string): void;
  status(code: number): ResponseLike;
  json(body: unknown): void;
}

export default async function handler(_req: RequestLike, res: ResponseLike): Promise<void> {
  if (process.env.SIGNALS_ENABLED !== 'true' || !process.env.PREDICTEFY_API_KEY) {
    res.status(404).json({ error: 'signals_disabled' });
    return;
  }
  try {
    const { loadSignals, readSignalSettings } = await import('../../bot/src/arb/predictefySignalsCore');
    const result = await loadSignals(readSignalSettings(), 'arbitrage');
    // Screen mode (Free/Builder keys) costs 5 credits/call and is slower-moving: cache longer.
    const sMaxAge = result.mode === 'arbitrage' ? 60 : 300;
    res.setHeader('Cache-Control', `public, s-maxage=${sMaxAge}, stale-while-revalidate=${sMaxAge * 2}`);
    res.status(200).json(result);
  } catch (err) {
    console.error('[api/signals] failed', err);
    const code = (err as { code?: string }).code;
    res.status(502).json({
      error: code ?? 'internal_server_error',
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}
