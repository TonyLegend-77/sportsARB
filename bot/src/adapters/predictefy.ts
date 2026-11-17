// NOTE: reads process.env directly (not ../config) so the Vercel serverless function can import this
// without the bot's full env validation.
const apiUrl = () => process.env.PREDICTEFY_API_URL || 'https://data.predictefy.com';
const apiKey = () => process.env.PREDICTEFY_API_KEY;

/** Error envelope from Predictefy: { success:false, error:{ code, message, retryable } }. */
export class PredictefyError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly retryable: boolean,
  ) {
    super(`${code}: ${message}`);
  }
}

export interface ArbLegAssessment {
  venue: string;
  canonicalMarketId: string;
  side: 'yes' | 'no';
  selection?: string;
  executable: boolean;
  reasons: string[];
  vwap: number | null;
  cost: number | null;
  fee: number | null;
  filled: number;
  fullyFilled: boolean;
  asOf?: string | null;
}

export interface ArbitrageRow {
  clusterId: string;
  question: string;
  contracts: number;
  legs: { buyYes: ArbLegAssessment; buyNo: ArbLegAssessment };
  resolutionEquivalence: string;
  matchScore: number | null;
  matchBand: string;
  totalCost: number | null;
  payout: number | null;
  netEdge: number | null; // USD at `contracts` size; null = not priced (NOT zero)
  roi: number | null; // ratio, e.g. 0.0087 = 0.87%
  executable: boolean;
  reasons: string[];
  label: 'arbitrage' | 'indicative price discrepancy';
  asOf: string;
}

async function pf(path: string, params: Record<string, string | number | undefined> = {}): Promise<any> {
  if (!apiKey()) throw new PredictefyError(500, 'NO_API_KEY', 'PREDICTEFY_API_KEY is not set', false);
  const url = new URL(path, apiUrl());
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, String(v));

  const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey()}` } });
  const body: any = await res.json().catch(() => null);
  if (!res.ok || !body?.success) {
    const e = body?.error ?? {};
    throw new PredictefyError(res.status, e.code ?? 'HTTP_ERROR', e.message ?? res.statusText, !!e.retryable);
  }
  return body;
}

/**
 * Executable cross-venue arbitrage (Pro plan+). Walks cursor pages; restarts from page 1
 * (max 3x) if a cursor snapshot expires. Mirrors the docs' arbitrage-scanner recipe.
 */
export async function fetchArbitrageAll(opts: { contracts: number; venues?: string }): Promise<ArbitrageRow[]> {
  let restarts = 0;
  let cursor: string | undefined;
  const rows: ArbitrageRow[] = [];

  for (;;) {
    try {
      const body = await pf('/api/router/fetchArbitrage', {
        executableOnly: 'true',
        contracts: opts.contracts,
        limit: 500,
        snapshotTTL: 0,
        venues: opts.venues,
        cursor,
      });
      // 'computed-fallback' = bounded on-demand compute over <=10 clusters, not the full published set.
      if (body.meta?.source !== 'published') throw new PredictefyError(503, 'NOT_PUBLISHED', 'published surface unavailable', true);
      rows.push(...(body.data as ArbitrageRow[]));
      cursor = body.page?.hasMore ? body.page.nextCursor : undefined;
      if (!cursor) return rows;
    } catch (err) {
      if (err instanceof PredictefyError && err.status === 400 && err.message.includes('Cursor has expired') && restarts < 3) {
        restarts += 1;
        cursor = undefined;
        rows.length = 0;
        continue;
      }
      throw err;
    }
  }
}

/** Sports price grid (all plans where the route is enabled; 5 credits/call). */
export async function fetchSportsScreen(params: { marketType: string; limit?: number; venues?: string }): Promise<any[]> {
  const body = await pf('/v1/sports/screen', { marketType: params.marketType, limit: params.limit ?? 100, venues: params.venues });
  return body.data ?? [];
}
