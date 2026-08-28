import { config } from '../config';
import type { MarketQuote, OutcomeOdds } from '../types';
import { canonicalTeamName } from './teamNames';
import { type LeagueConfig, ACTIVE_LEAGUE } from '../leagues';
import { createLogger } from '../logger';

const log = createLogger('sxbet');

const TOP_LEVELS = 5;
const SNAPSHOT_BATCH_SIZE = 20; // concurrent snapshot fetches per round
const BATCH_DELAY_MS = 300;

interface SxMarket {
  marketHash: string;
  outcomeOneName: string;
  outcomeTwoName: string;
  teamOneName?: string;
  teamTwoName?: string;
  sportId: number;
  sportLabel: string;
  leagueId: number;
  sportXeventId?: string; // e.g. "L18511902" — groups all bet types for the same game
  type: number;
  line?: number; // Handicap or total value for spread/total markets
  mainLine?: boolean; // true if this is the primary line for its type
  gameTime: number; // UNIX timestamp (seconds)
}

// One entry per game — holds the three 1X2 binary markets
interface GameEntry {
  homeTeam: string; // canonical
  awayTeam: string; // canonical
  gameTime: number;
  sportLabel: string;
  sxEventId?: string; // sportXeventId shared across all bet types for this game
  homeWinMarket?: SxMarket; // outcomeOneName === teamOneName
  drawMarket?: SxMarket; // outcomeOneName === 'Tie'
  awayWinMarket?: SxMarket; // outcomeOneName === teamTwoName
}

interface SnapshotLevel {
  percentageOdds: string;
  size: string;
}

interface OrderbookSnapshot {
  outcomeOne: SnapshotLevel[];
  outcomeTwo: SnapshotLevel[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(url: string): Promise<Response> {
  const res = await fetch(url);
  if (res.status === 429) {
    log.warn('rate limited, retrying in 10s');
    await sleep(10_000);
    return fetch(url);
  }
  return res;
}

async function fetchAllActiveMarkets(leagueId: number): Promise<SxMarket[]> {
  const markets: SxMarket[] = [];
  let paginationKey: string | undefined;

  do {
    const params = new URLSearchParams({
      pageSize: '50',
      leagueId: String(leagueId),
    });
    if (paginationKey) params.set('paginationKey', paginationKey);

    const res = await fetchWithRetry(`${config.SX_BET_API_URL}/markets/active?${params}`);
    if (!res.ok) throw new Error(`GET /markets/active returned ${res.status}`);

    const body = (await res.json()) as {
      data: { markets: SxMarket[]; nextKey?: string };
    };

    markets.push(...body.data.markets);
    paginationKey = body.data.nextKey || undefined;
  } while (paginationKey);

  return markets;
}

/**
 * V3: GET /orderbook-v3/snapshot with showTakerPerspective=true returns
 * outcomeOne/outcomeTwo already in the TAKER's own frame — no more manual
 * maker→taker inversion or per-order bucketing (that used to happen in
 * buildOutcome against raw GET /orders rows, which no longer exists as a
 * public market-wide endpoint post-V3).
 */
async function fetchOrderbookSnapshot(marketHash: string): Promise<OrderbookSnapshot | null> {
  const url = `${config.SX_BET_API_URL}/orderbook-v3/snapshot?marketHash=${marketHash}&showTakerPerspective=true`;
  const res = await fetchWithRetry(url);
  if (!res.ok) {
    log.error({ marketHash, status: res.status }, 'orderbook-v3 snapshot fetch failed');
    return null;
  }
  const body = (await res.json()) as { data: OrderbookSnapshot };
  return body.data;
}

async function fetchSnapshotsForHashes(hashes: string[]): Promise<Map<string, OrderbookSnapshot>> {
  const out = new Map<string, OrderbookSnapshot>();
  for (let i = 0; i < hashes.length; i += SNAPSHOT_BATCH_SIZE) {
    const batch = hashes.slice(i, i + SNAPSHOT_BATCH_SIZE);
    const results = await Promise.all(
      batch.map(async (hash) => [hash, await fetchOrderbookSnapshot(hash)] as const),
    );
    for (const [hash, snapshot] of results) {
      if (snapshot) out.set(hash, snapshot);
    }
    if (i + SNAPSHOT_BATCH_SIZE < hashes.length) {
      await sleep(BATCH_DELAY_MS);
    }
  }
  return out;
}

function levelsFromSnapshot(levels: SnapshotLevel[]): { odds: number; size: number }[] {
  return levels
    .map((l) => ({
      odds: parseFloat((Number(l.percentageOdds) / 1e20).toFixed(8)),
      size: Number(l.size) / 1_000_000,
    }))
    .filter((l) => l.odds > 0 && l.odds < 1 && l.size > 0);
}

export function levelsFromSnapshotSide(levels: SnapshotLevel[]): { odds: number; size: number }[] {
  return levelsFromSnapshot(levels);
}

export { fetchOrderbookSnapshot };

/**
 * label: the outcome's display name.
 * levels: already taker-frame, already sorted best-first per the API (index 0
 * = best price) — this function just slices/summarizes, it does no odds math.
 */
export function buildOutcome(label: string, levels: { odds: number; size: number }[]): OutcomeOdds {
  const topLevels = levels.slice(0, TOP_LEVELS);
  const totalAvailableUsdc = levels.reduce((sum, l) => sum + l.size, 0);
  const bestOdds = topLevels[0]?.odds ?? 0;

  return {
    label,
    impliedOdds: bestOdds,
    liquidityDepth: { availableSize: totalAvailableUsdc, topLevels },
  };
}

function emptyOutcome(label: string): OutcomeOdds {
  return { label, impliedOdds: 0, liquidityDepth: { availableSize: 0, topLevels: [] } };
}

// Types 226/342/28 are the "Including Overtime" equivalents used by NBA/NHL
const GAME_LINE_TYPES = new Set([52, 226, 3, 342, 2, 28]);

function betTypeFromSxType(type: number): string {
  if (type === 52 || type === 226) return '12';
  if (type === 3 || type === 342) return 'spread';
  return 'total'; // types 2, 28
}

// SX returns game-lines outcome names with the platform's full team name (e.g.
// "Paris Saint Germain -1.5"). Replace the team-name prefix with our canonical
// short form so labels match `Event.homeTeam`/`awayTeam` everywhere downstream.
// Totals labels ("Over 2.5" / "Under 2.5") have no team prefix and pass through.
function canonicalizeOutcomeLabel(
  rawLabel: string,
  rawHome: string,
  rawAway: string,
  homeCanonical: string,
  awayCanonical: string,
): string {
  if (rawLabel.startsWith(rawHome)) return homeCanonical + rawLabel.slice(rawHome.length);
  if (rawLabel.startsWith(rawAway)) return awayCanonical + rawLabel.slice(rawAway.length);
  return rawLabel;
}

export async function fetchSxBetMarkets(league: LeagueConfig = ACTIVE_LEAGUE): Promise<MarketQuote[]> {
  const allMarkets = await fetchAllActiveMarkets(league.sxbet.leagueId);
  if (allMarkets.length === 0) {
    log.warn({ league: league.name, leagueId: league.sxbet.leagueId }, 'API returned 0 markets');
    return [];
  }

  const type1Markets = league.hasDraw ? allMarkets.filter((m) => m.type === 1) : [];
  const gameLinesMarkets = allMarkets.filter(
    (m) => GAME_LINE_TYPES.has(m.type) && m.teamOneName && m.teamTwoName,
  );

  // Group the three 1X2 binary markets (home win, draw, away win) by game.
  // Double-chance markets (e.g. "Home or Draw") are ignored — their outcomeOneName
  // won't match teamOneName, teamTwoName, or 'Tie', so they fall through cleanly.
  const gameMap = new Map<string, GameEntry>();

  for (const market of type1Markets) {
    const rawHome = (market.teamOneName ?? '').trim();
    const rawAway = (market.teamTwoName ?? '').trim();
    if (!rawHome || !rawAway) continue;

    const key = `${market.gameTime}|${rawHome}|${rawAway}`;
    if (!gameMap.has(key)) {
      gameMap.set(key, {
        homeTeam: canonicalTeamName(rawHome, league.sport),
        awayTeam: canonicalTeamName(rawAway, league.sport),
        gameTime: market.gameTime,
        sportLabel: market.sportLabel,
        sxEventId: market.sportXeventId,
      });
    }

    const entry = gameMap.get(key)!;
    const o1Lower = market.outcomeOneName.toLowerCase().trim();

    if (o1Lower === rawHome.toLowerCase()) {
      entry.homeWinMarket = market;
    } else if (o1Lower === 'tie') {
      entry.drawMarket = market;
    } else if (o1Lower === rawAway.toLowerCase()) {
      entry.awayWinMarket = market;
    }
    // else: double-chance or unknown variant — skip
  }

  // Collect all market hashes: 1X2 entries + game-lines markets
  const allHashes: string[] = [];
  for (const entry of gameMap.values()) {
    if (entry.homeWinMarket) allHashes.push(entry.homeWinMarket.marketHash);
    if (entry.drawMarket) allHashes.push(entry.drawMarket.marketHash);
    if (entry.awayWinMarket) allHashes.push(entry.awayWinMarket.marketHash);
  }
  for (const m of gameLinesMarkets) allHashes.push(m.marketHash);

  const snapshots = await fetchSnapshotsForHashes(allHashes);

  const quotes: MarketQuote[] = [];

  // Build one MarketQuote per game with up to 3 true 1X2 outcomes
  for (const [, entry] of gameMap) {
    // Require at least the home-win binary for a stable externalId
    if (!entry.homeWinMarket) continue;

    const name = `${entry.homeTeam} vs ${entry.awayTeam}`;
    const outcomes: OutcomeOdds[] = [];

    // Home-win binary market: outcomeOne = home team, outcomeTwo = "not home"
    const homeSnapshot = snapshots.get(entry.homeWinMarket.marketHash);
    const homeOut = homeSnapshot ? buildOutcome(entry.homeTeam, levelsFromSnapshot(homeSnapshot.outcomeOne)) : emptyOutcome(entry.homeTeam);
    homeOut.externalId = `${entry.homeWinMarket.marketHash}:0`;
    outcomes.push(homeOut);

    const notHomeOut = homeSnapshot ? buildOutcome(`Not ${entry.homeTeam}`, levelsFromSnapshot(homeSnapshot.outcomeTwo)) : emptyOutcome(`Not ${entry.homeTeam}`);
    notHomeOut.externalId = `${entry.homeWinMarket.marketHash}:1`;
    outcomes.push(notHomeOut);

    // Draw binary market: outcomeOne = Tie, outcomeTwo = "not draw"
    if (entry.drawMarket) {
      const drawSnapshot = snapshots.get(entry.drawMarket.marketHash);
      const drawOut = drawSnapshot ? buildOutcome('Draw', levelsFromSnapshot(drawSnapshot.outcomeOne)) : emptyOutcome('Draw');
      drawOut.externalId = `${entry.drawMarket.marketHash}:0`;
      outcomes.push(drawOut);

      const notDrawOut = drawSnapshot ? buildOutcome('Not Draw', levelsFromSnapshot(drawSnapshot.outcomeTwo)) : emptyOutcome('Not Draw');
      notDrawOut.externalId = `${entry.drawMarket.marketHash}:1`;
      outcomes.push(notDrawOut);
    }

    // Away-win binary market: outcomeOne = away team, outcomeTwo = "not away"
    if (entry.awayWinMarket) {
      const awaySnapshot = snapshots.get(entry.awayWinMarket.marketHash);
      const awayOut = awaySnapshot ? buildOutcome(entry.awayTeam, levelsFromSnapshot(awaySnapshot.outcomeOne)) : emptyOutcome(entry.awayTeam);
      awayOut.externalId = `${entry.awayWinMarket.marketHash}:0`;
      outcomes.push(awayOut);

      const notAwayOut = awaySnapshot ? buildOutcome(`Not ${entry.awayTeam}`, levelsFromSnapshot(awaySnapshot.outcomeTwo)) : emptyOutcome(`Not ${entry.awayTeam}`);
      notAwayOut.externalId = `${entry.awayWinMarket.marketHash}:1`;
      outcomes.push(notAwayOut);
    }

    quotes.push({
      platform: 'sx',
      externalId: entry.homeWinMarket.marketHash, // home-win hash is the game's stable ID
      sport: entry.sportLabel,
      league: league.name,
      homeTeam: entry.homeTeam,
      awayTeam: entry.awayTeam,
      name,
      startTime: new Date(entry.homeWinMarket.gameTime * 1000),
      betType: '1x2',
      mainLine: true,
      sxEventId: entry.sxEventId,
      outcomes,
    });
  }

  // Build one MarketQuote per game-lines binary (types 52, 3, 2).
  // Each of these is a single binary market — outcomeOneName/outcomeTwoName already
  // embed the line value (e.g. "Lakers -3.5" / "Celtics +3.5", "Over 2.5" / "Under 2.5").
  for (const market of gameLinesMarkets) {
    const rawHome = (market.teamOneName ?? '').trim();
    const rawAway = (market.teamTwoName ?? '').trim();
    if (!rawHome || !rawAway) continue;

    const homeTeam = canonicalTeamName(rawHome, league.sport);
    const awayTeam = canonicalTeamName(rawAway, league.sport);
    const snapshot = snapshots.get(market.marketHash);

    const labelOne = canonicalizeOutcomeLabel(market.outcomeOneName, rawHome, rawAway, homeTeam, awayTeam);
    const labelTwo = canonicalizeOutcomeLabel(market.outcomeTwoName, rawHome, rawAway, homeTeam, awayTeam);

    const outcomeOne = snapshot ? buildOutcome(labelOne, levelsFromSnapshot(snapshot.outcomeOne)) : emptyOutcome(labelOne);
    outcomeOne.externalId = `${market.marketHash}:0`;

    const outcomeTwo = snapshot ? buildOutcome(labelTwo, levelsFromSnapshot(snapshot.outcomeTwo)) : emptyOutcome(labelTwo);
    outcomeTwo.externalId = `${market.marketHash}:1`;

    quotes.push({
      platform: 'sx',
      externalId: market.marketHash,
      sport: market.sportLabel,
      league: league.name,
      homeTeam,
      awayTeam,
      name: `${homeTeam} vs ${awayTeam}`,
      startTime: new Date(market.gameTime * 1000),
      betType: betTypeFromSxType(market.type),
      line: market.line,
      mainLine: market.mainLine ?? true,
      sxEventId: market.sportXeventId,
      outcomes: [outcomeOne, outcomeTwo],
    });
  }

  const glCount = quotes.filter((q) => q.betType !== '1x2').length;
  log.info(
    { league: league.name, total: quotes.length, oneXTwo: quotes.length - glCount, gameLines: glCount, sourceMarkets: allMarkets.length },
    'fetched quotes',
  );
  return quotes;
}
