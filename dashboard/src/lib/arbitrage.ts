/**
 * Cross-venue arbitrage detection.
 *
 * IMPORTANT DISTINCTION FROM `getBestOdds()` (marketUtils.ts):
 * `getBestOdds` picks the cheaper venue for ONE side of a bet — that's a
 * best-execution comparison, not arbitrage. True arbitrage requires TWO
 * COMPLEMENTARY outcomes (one wins iff the other loses) priced on TWO
 * DIFFERENT venues whose implied probabilities sum to less than 1. That
 * combination locks a profit regardless of which side wins.
 *
 * Complementary pairs, by bet type:
 *   1x2    — home ↔ not_home, draw ↔ not_draw, away ↔ not_away
 *            (home/draw/away do NOT pair with each other — that's a 3-way
 *            market, not a binary complement)
 *   12     — home ↔ away (only two outcomes possible)
 *   spread — home:-L ↔ away:+L (see spreadComplementKey)
 *   total  — over:L ↔ under:L
 *
 * This reuses `groupMarkets` from marketUtils.ts, which already merges
 * same-canonical-key outcomes per platform and picks the best price if a
 * platform lists the same side more than once (e.g. alt-line duplicates).
 * We just add the missing piece: summing complementary sides ACROSS venues.
 */
import { groupMarkets, type MatchGroup, type OutcomeRow } from './marketUtils';
import type { Market } from './api';

export type ArbPlatform = 'sx' | 'polymarket';

export interface ArbLeg {
  platform: ArbPlatform;
  label: string;
  impliedOdds: number;
  availableSize: number;
}

export interface ArbitrageOpportunity {
  id: string;
  matchName: string;
  sport: string;
  league: string;
  startTime: string;
  legA: ArbLeg;
  legB: ArbLeg;
  /** Sum of both legs' implied probabilities. Must be < 1 for this to exist. */
  combinedImplied: number;
  /** (1 - combinedImplied) * 100 — the raw edge. */
  marginPct: number;
  /** Profit per $1 total staked, if split optimally across both legs. Always > marginPct. */
  roiPct: number;
  /** Fraction of total stake to put on legA to equalize payout either way. */
  stakeSplitA: number;
  stakeSplitB: number;
  /** Largest total stake this opportunity supports before one leg's liquidity caps it. */
  maxTotalStake: number;
}

// Ignore anything with less than a 0.1% combined edge — that's quote noise /
// rounding, not a real opportunity. Raise this if the 60s cache staleness or
// thin books are giving you false positives.
const MIN_MARGIN = 0.001;

function spreadComplementKey(side: 'home' | 'away', signedLine: number): string {
  const otherSide = side === 'home' ? 'away' : 'home';
  const complement = -signedLine;
  const v = complement === 0 ? 0 : complement;
  const norm = v > 0 ? `+${v}` : `${v}`;
  return `spread:${otherSide}:${norm}`;
}

/** Mirrors bot/src/router/canonicalize.ts's key scheme. Kept in sync manually. */
function complementKeyOf(key: string): string | null {
  switch (key) {
    case '1x2:home': return '1x2:not_home';
    case '1x2:not_home': return '1x2:home';
    case '1x2:draw': return '1x2:not_draw';
    case '1x2:not_draw': return '1x2:draw';
    case '1x2:away': return '1x2:not_away';
    case '1x2:not_away': return '1x2:away';
    case '12:home': return '12:away';
    case '12:away': return '12:home';
    default:
      break;
  }
  const totalM = key.match(/^total:(over|under):(.+)$/);
  if (totalM) {
    const other = totalM[1] === 'over' ? 'under' : 'over';
    return `total:${other}:${totalM[2]}`;
  }
  const spreadM = key.match(/^spread:(home|away):([+-]?\d+(?:\.\d+)?)$/);
  if (spreadM) return spreadComplementKey(spreadM[1] as 'home' | 'away', parseFloat(spreadM[2]));
  return null;
}

function venueEntry(
  row: OutcomeRow,
  platform: ArbPlatform,
): { impliedOdds: number; availableSize: number } | undefined {
  return platform === 'sx' ? row.sx : row.polymarket;
}

function buildOpportunity(
  group: MatchGroup,
  rowId: string,
  a: { impliedOdds: number; availableSize: number },
  aPlatform: ArbPlatform,
  aLabel: string,
  b: { impliedOdds: number; availableSize: number },
  bPlatform: ArbPlatform,
  bLabel: string,
): ArbitrageOpportunity | null {
  if (a.impliedOdds <= 0 || b.impliedOdds <= 0) return null;
  const combined = a.impliedOdds + b.impliedOdds;
  if (combined >= 1 - MIN_MARGIN) return null;

  const margin = 1 - combined;
  const roiPct = (margin / combined) * 100;
  const stakeSplitA = a.impliedOdds / combined;
  const stakeSplitB = b.impliedOdds / combined;
  const maxTotalStake = Math.min(
    a.availableSize > 0 ? (a.availableSize * combined) / a.impliedOdds : Infinity,
    b.availableSize > 0 ? (b.availableSize * combined) / b.impliedOdds : Infinity,
  );

  return {
    id: `${rowId}|${aLabel}@${aPlatform}|${bLabel}@${bPlatform}`,
    matchName: group.name,
    sport: group.sport,
    league: group.league,
    startTime: group.startTime,
    legA: { platform: aPlatform, label: aLabel, impliedOdds: a.impliedOdds, availableSize: a.availableSize },
    legB: { platform: bPlatform, label: bLabel, impliedOdds: b.impliedOdds, availableSize: b.availableSize },
    combinedImplied: combined,
    marginPct: margin * 100,
    roiPct,
    stakeSplitA,
    stakeSplitB,
    maxTotalStake: Number.isFinite(maxTotalStake) ? maxTotalStake : 0,
  };
}

function pairOpportunities(group: MatchGroup, rowA: OutcomeRow, rowB: OutcomeRow): ArbitrageOpportunity[] {
  const out: ArbitrageOpportunity[] = [];
  const rowId = `${group.name}|${rowA.canonicalKey ?? rowA.id}`;

  // Two cross-venue combos: (A on SX, B on Poly) and (A on Poly, B on SX).
  // Both are distinct real strategies — show whichever clears the threshold.
  const sxA = venueEntry(rowA, 'sx');
  const polyB = venueEntry(rowB, 'polymarket');
  if (sxA && polyB) {
    const opp = buildOpportunity(group, rowId, sxA, 'sx', rowA.label, polyB, 'polymarket', rowB.label);
    if (opp) out.push(opp);
  }

  const polyA = venueEntry(rowA, 'polymarket');
  const sxB = venueEntry(rowB, 'sx');
  if (polyA && sxB) {
    const opp = buildOpportunity(group, rowId, polyA, 'polymarket', rowA.label, sxB, 'sx', rowB.label);
    if (opp) out.push(opp);
  }

  return out;
}

export function findArbitrageOpportunities(markets: Market[]): ArbitrageOpportunity[] {
  const groups = groupMarkets(markets);
  const results: ArbitrageOpportunity[] = [];

  for (const group of groups) {
    const byKey = new Map<string, OutcomeRow>();
    for (const row of group.outcomes) {
      if (row.canonicalKey) byKey.set(row.canonicalKey, row);
    }
    for (const [key, row] of byKey) {
      const complementKey = complementKeyOf(key);
      // String-ordering guard visits each unordered {key, complement} pair
      // exactly once (complementKeyOf is its own inverse for every bet type).
      if (!complementKey || complementKey <= key) continue;
      const other = byKey.get(complementKey);
      if (!other) continue;
      results.push(...pairOpportunities(group, row, other));
    }
  }

  return results.sort((a, b) => b.roiPct - a.roiPct);
}
