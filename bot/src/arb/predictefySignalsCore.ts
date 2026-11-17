import { fetchArbitrageAll, fetchSportsScreen, PredictefyError, type ArbitrageRow } from '../adapters/predictefy';

/**
 * Shared signal loader — used by the Telegram scanner, the bot's /api/signals route and the
 * Vercel serverless function. Reads process.env only (no ../config) so it is safe to bundle
 * into the read-only dashboard function. SIGNALS ONLY: nothing here places orders.
 */

export type SignalMode = 'arbitrage' | 'screen';
export type SignalKind = 'arbitrage' | 'indicative';

export interface SignalLeg {
  venue: string;
  label: string;
  price: number | null; // VWAP (arbitrage) or implied probability 0-1 (screen)
  size: number | null;
}

export interface Signal {
  id: string;
  kind: SignalKind;
  title: string;
  subtitle: string;
  roiPct: number;
  legs: SignalLeg[];
  detail: string;
  asOf: string;
}

export interface SignalsResult {
  mode: SignalMode;
  /** true when the key's plan has no arbitrage feed and we fell back to the sports screen */
  planFallback: boolean;
  generatedAt: string;
  signals: Signal[];
}

export interface SignalSettings {
  contracts: number;
  minRoi: number;
  /** If set, EVERY leg must be on one of these venues (Predictefy's own `venues` filter only needs one leg). */
  allowedVenues: Set<string> | null;
  /** No leg may be on these venues (default: kalshi). */
  excludedVenues: Set<string>;
  sportsOnly: boolean;
  marketTypes: string[];
}

const list = (v: string | undefined) => (v ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);

/** Number from an env var; empty, missing, non-numeric or out-of-range values fall back to the default. */
export function envNum(v: string | undefined, def: number, min = 0): number {
  const n = v === undefined || v.trim() === '' ? NaN : Number(v);
  return Number.isFinite(n) && n >= min ? n : def;
}

export function readSignalSettings(): SignalSettings {
  const e = process.env;
  return {
    contracts: envNum(e.PREDICTEFY_CONTRACTS, 100, 1),
    minRoi: envNum(e.PREDICTEFY_MIN_ROI, 0.005, 0),
    allowedVenues: list(e.PREDICTEFY_VENUES).length ? new Set(list(e.PREDICTEFY_VENUES)) : null,
    excludedVenues: new Set(e.PREDICTEFY_EXCLUDE_VENUES === undefined || e.PREDICTEFY_EXCLUDE_VENUES.trim() === '' ? ['kalshi'] : list(e.PREDICTEFY_EXCLUDE_VENUES)),
    sportsOnly: e.PREDICTEFY_SPORTS_ONLY !== 'false',
    marketTypes: (e.PREDICTEFY_SPORTS_MARKET_TYPES || 'moneyline').split(',').map((s) => s.trim()).filter(Boolean),
  };
}

const venueOk = (s: SignalSettings, v: string) =>
  !s.excludedVenues.has(v.toLowerCase()) && (!s.allowedVenues || s.allowedVenues.has(v.toLowerCase()));

// Best effort: arbitrage rows carry no documented sport/category field, so a row counts as sports
// if either leg has a mapped sports selection (home/away/over/under…) or its question reads like a game.
const SPORTS_RE =
  /\b(vs\.?)\b|\bspread\b|\bo\/u\b|\bover\/under\b|\bmoneyline\b|\btotal (goals|points|runs)\b|\b(nba|nfl|mlb|nhl|epl|ucl|ufc|atp|wta|premier league|champions league|la liga|serie a|bundesliga|ligue 1|world cup)\b/i;
const looksLikeSports = (r: ArbitrageRow) =>
  !!(r.legs.buyYes.selection || r.legs.buyNo.selection) || SPORTS_RE.test(r.question);

function fromArbitrage(r: ArbitrageRow): Signal {
  const y = r.legs.buyYes;
  const n = r.legs.buyNo;
  return {
    id: `${r.clusterId}|${y.venue}|${n.venue}`,
    kind: 'arbitrage',
    title: r.question,
    subtitle: `${r.contracts} contracts · rules ${r.resolutionEquivalence} (match ${r.matchScore ?? 'n/a'})`,
    roiPct: (r.roi ?? 0) * 100,
    legs: [
      { venue: y.venue, label: 'Buy YES', price: y.vwap, size: y.filled },
      { venue: n.venue, label: 'Buy NO', price: n.vwap, size: n.filled },
    ],
    detail: `Net edge $${r.netEdge?.toFixed(2)} on cost $${r.totalCost?.toFixed(2)}. Executable per Predictefy: live asks, depth, fees and rules all passed.`,
    asOf: r.asOf,
  };
}

export async function loadArbitrageSignals(s: SignalSettings): Promise<Signal[]> {
  // Venue/sport filtering is done client-side below (Predictefy's `venues` filter keeps a row if EITHER leg matches).
  const rows = await fetchArbitrageAll({ contracts: s.contracts });
  return rows
    .filter(
      (r) =>
        r.executable &&
        r.label === 'arbitrage' &&
        r.roi !== null && // null = not priced, never zero
        r.netEdge !== null &&
        r.legs.buyYes.fullyFilled &&
        r.legs.buyNo.fullyFilled &&
        r.roi >= s.minRoi &&
        venueOk(s, r.legs.buyYes.venue) &&
        venueOk(s, r.legs.buyNo.venue) &&
        (!s.sportsOnly || looksLikeSports(r)),
    )
    .map(fromArbitrage)
    .sort((a, b) => b.roiPct - a.roiPct);
}

/**
 * Indicative only: cheapest live, non-stale ask per selection summing to < 1. No depth,
 * fee/gas or rules-equivalence verification (that is what the Pro arbitrage feed adds).
 */
export async function loadScreenSignals(s: SignalSettings): Promise<Signal[]> {
  const out: Signal[] = [];
  for (const marketType of s.marketTypes) {
    const games = await fetchSportsScreen({
      marketType,
      venues: s.allowedVenues ? [...s.allowedVenues].join(',') : undefined,
    });
    for (const g of games) {
      const sels: any[] = g.market?.selections ?? [];
      if (sels.length < 2) continue;

      const picks = sels.map((sel) => {
        const eligible = (sel.cells ?? [])
          .filter((c: any) => c.source === 'live' && !c.stale && c.gross?.probability != null && venueOk(s, c.venue))
          .map((c: any) => {
            const feeUnknown = !!c.feeUnknown || !c.net;
            return {
              venue: c.venue as string,
              p: (feeUnknown ? c.gross : c.net).probability as number,
              feeUnknown,
              size: (c.sizeAtPrice ?? null) as number | null,
              label: (sel.selection ?? sel.label ?? '?') as string,
            };
          })
          .sort((a: any, b: any) => a.p - b.p);
        return eligible[0];
      });
      if (picks.some((p) => !p)) continue; // an empty cell is absent, never zero
      if (new Set(picks.map((p) => p.venue)).size < 2) continue;

      const implied = picks.reduce((sum, p) => sum + p.p, 0);
      const roi = 1 / implied - 1;
      if (implied >= 1 || roi < s.minRoi) continue;

      const teams = (g.teams ?? []).map((t: any) => t.name).join(' vs ');
      out.push({
        id: `screen|${g.fixtureId ?? g.id ?? teams}|${marketType}`,
        kind: 'indicative',
        title: teams || 'Unknown fixture',
        subtitle: `${marketType}${g.kickoffAt ? ` · ${g.kickoffAt}` : ''}`,
        roiPct: roi * 100,
        legs: picks.map((p) => ({ venue: p.venue, label: p.label, price: p.p, size: p.size })),
        detail: `Indicative gap, unverified: depth, fees${picks.some((p) => p.feeUnknown) ? ' (some gross-only, fees unknown)' : ''} and rules equivalence were not checked.`,
        asOf: g.asOf ?? new Date().toISOString(),
      });
    }
  }
  return out.sort((a, b) => b.roiPct - a.roiPct);
}

/** Loads signals for `preferred` mode; falls back to the sports screen if the plan has no arbitrage feed. */
export async function loadSignals(s: SignalSettings, preferred: SignalMode = 'arbitrage'): Promise<SignalsResult> {
  const generatedAt = new Date().toISOString();
  if (preferred === 'arbitrage') {
    try {
      return { mode: 'arbitrage', planFallback: false, generatedAt, signals: await loadArbitrageSignals(s) };
    } catch (err) {
      if (!(err instanceof PredictefyError) || err.code !== 'PLAN_REQUIRED') throw err;
      return { mode: 'screen', planFallback: true, generatedAt, signals: await loadScreenSignals(s) };
    }
  }
  return { mode: 'screen', planFallback: true, generatedAt, signals: await loadScreenSignals(s) };
}
