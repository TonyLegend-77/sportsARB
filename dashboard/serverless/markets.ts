/**
 * Source for the read-only public `/api/markets` Vercel function.
 *
 * This file is NOT the deployed function — it's the esbuild entry point. The
 * build bundles it (and the bot code it imports) into a single self-contained
 * `dashboard/api/markets.js` (CommonJS, node deps left external). We bundle
 * ourselves rather than relying on Vercel's per-file transpile, which ships
 * the raw `import` + unresolved bot paths and fails at runtime.
 *
 * Cost model: the `Cache-Control` header makes Vercel's edge CDN cache the
 * response for 60s and serve stale for 5 more minutes while revalidating in
 * the background — upstream is hit ~once/minute regardless of visitor count,
 * and nothing runs when the site is idle.
 *
 * Requires env vars on the Vercel project (see api/README.md):
 *   READ_ONLY_MODE=true, SX_BET_API_KEY=<any>, DATABASE_URL=<any>
 */
interface ResponseLike {
  setHeader(key: string, value: string): void;
  status(code: number): ResponseLike;
  json(body: unknown): void;
}

export default async function handler(_req: unknown, res: ResponseLike): Promise<void> {
  try {
    // Dynamic import, not a static top-level one, deliberately. A static
    // `import` resolves (and can throw, e.g. config.ts's env validation)
    // during Vercel's cold-start module load, which happens BEFORE this
    // function body runs — that kind of throw bypasses this try/catch
    // entirely and shows up as a bare "Serverless Function has crashed"
    // page with no detail. Importing here means a cold-start failure is
    // caught like any other error and comes back as readable JSON instead.
    const { fetchPublicMarkets } = await import('../../bot/src/public/fetchMarkets');
    const markets = await fetchPublicMarkets();
    res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
    res.status(200).json(markets);
  } catch (err) {
    console.error('[api/markets] fetch failed', err);
    res.status(500).json({
      error: 'internal_server_error',
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}
