import { randomUUID } from 'crypto';
import { prisma } from '../db';
import { createLogger } from '../logger';
import { complementKeyOf } from './canonical';
import { getArbSettings, getArbDailySpent, addArbDailySpent, setArbMode, type ArbSettings } from './config';
import { createPendingTrade, markTradeFilled, markTradeFailed } from '../db/trades';
import { executeSxBetFill } from '../executor/sxbet';
import { executePolymarketOrder } from '../executor/polymarket';
import { liveLevelsFor } from '../router';
import { sendArbConfirmPrompt, sendArbResultNotification, sendOneLeggedAlert } from '../telegram/notify';
import type { ArbPlatform, ArbOpportunity, ArbExecutionResult } from './types';

const log = createLogger('arb-scanner');

// Below this, a leg's stake is too small to be worth the gas/friction. Skip
// the whole opportunity rather than fire a token-sized trade.
const MIN_TRADE_USD = 2;
// How long a manual-mode confirm prompt stays valid before it's discarded.
const CONFIRM_TTL_MS = 25_000;
// How long a dedupe key stays blocked after resolving, so the same pair
// doesn't get re-alerted/re-fired on the very next tick off a stale DB read.
const DEDUPE_COOLDOWN_MS = 15_000;

interface ScannedLeg {
  outcomeId: string;
  marketId: string;
  platform: ArbPlatform;
  label: string;
  externalId: string | null;
  currentOdds: number;
  liquidityDepth: number;
  liquidityLevels: string | null;
}

interface PendingConfirmation {
  opp: ArbOpportunity;
  dedupeKey: string;
  expiresAt: number;
}

let timer: NodeJS.Timeout | null = null;
let lastTickAt: number | null = null;
let lastTickOppCount = 0;

const inFlight = new Set<string>();
const pendingConfirmations = new Map<string, PendingConfirmation>();

export function startArbScanner(intervalMs: number): void {
  if (timer) return;
  timer = setInterval(() => {
    tick().catch((err) => log.error({ err }, 'arb scan tick failed'));
  }, intervalMs);
  log.info({ intervalMs }, 'arb scanner started (mode-gated — check /arbstatus)');
}

export function stopArbScanner(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

export function getScannerStatus() {
  return {
    lastTickAt,
    lastTickOppCount,
    pendingConfirmations: pendingConfirmations.size,
    inFlight: inFlight.size,
  };
}

export function getPendingConfirmation(id: string): PendingConfirmation | undefined {
  const entry = pendingConfirmations.get(id);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    pendingConfirmations.delete(id);
    inFlight.delete(entry.dedupeKey);
    return undefined;
  }
  return entry;
}

export function discardPendingConfirmation(id: string): void {
  const entry = pendingConfirmations.get(id);
  pendingConfirmations.delete(id);
  if (entry) releaseDedupe(entry.dedupeKey);
}

function releaseDedupe(dedupeKey: string): void {
  setTimeout(() => inFlight.delete(dedupeKey), DEDUPE_COOLDOWN_MS);
}

async function tick(): Promise<void> {
  lastTickAt = Date.now();
  lastTickOppCount = 0;

  const settings = await getArbSettings();
  if (settings.mode === 'off') return;

  const dailySpent = await getArbDailySpent();
  if (dailySpent >= settings.dailyCapUsd) return;

  const canonicalBets = await prisma.canonicalBet.findMany({
    include: {
      event: { select: { homeTeam: true, awayTeam: true, sport: true, league: true, status: true } },
      outcomes: { include: { market: { select: { id: true, platform: true, externalId: true, status: true } } } },
    },
  });

  const byEventKey = new Map<string, (typeof canonicalBets)[number]>();
  for (const cb of canonicalBets) byEventKey.set(`${cb.eventId}|${cb.key}`, cb);

  for (const cb of canonicalBets) {
    if (cb.event.status !== 'active') continue;
    const compKey = complementKeyOf(cb.key);
    if (!compKey || compKey <= cb.key) continue; // visit each unordered pair once
    const other = byEventKey.get(`${cb.eventId}|${compKey}`);
    if (!other) continue;

    // eslint-disable-next-line no-await-in-loop -- sequential on purpose, keeps the daily-cap check race-free within a tick
    await evaluatePair(cb, other, settings);
  }
}

function bestPerPlatform(outcomes: Array<{
  id: string;
  marketId: string;
  label: string;
  externalId: string | null;
  currentOdds: number;
  liquidityDepth: number;
  liquidityLevels: string | null;
  market: { platform: string; status: string };
}>): Partial<Record<ArbPlatform, ScannedLeg>> {
  const result: Partial<Record<ArbPlatform, ScannedLeg>> = {};
  for (const o of outcomes) {
    if (o.market.status !== 'active') continue;
    if (o.market.platform !== 'sx' && o.market.platform !== 'polymarket') continue;
    const platform = o.market.platform as ArbPlatform;
    const existing = result[platform];
    if (!existing || o.currentOdds < existing.currentOdds) {
      result[platform] = {
        outcomeId: o.id,
        marketId: o.marketId,
        platform,
        label: o.label,
        externalId: o.externalId,
        currentOdds: o.currentOdds,
        liquidityDepth: o.liquidityDepth,
        liquidityLevels: o.liquidityLevels,
      };
    }
  }
  return result;
}

async function evaluatePair(
  cbA: { id: string; outcomes: Parameters<typeof bestPerPlatform>[0]; event: { homeTeam: string; awayTeam: string; sport: string; league: string } },
  cbB: { id: string; outcomes: Parameters<typeof bestPerPlatform>[0] },
  settings: ArbSettings,
): Promise<void> {
  const bestA = bestPerPlatform(cbA.outcomes);
  const bestB = bestPerPlatform(cbB.outcomes);

  const combos: Array<[ArbPlatform, ArbPlatform]> = [
    ['sx', 'polymarket'],
    ['polymarket', 'sx'],
  ];

  for (const [platformA, platformB] of combos) {
    const legA = bestA[platformA];
    const legB = bestB[platformB];
    if (!legA || !legB) continue;

    const combined = legA.currentOdds + legB.currentOdds;
    const marginPct = (1 - combined) * 100;
    if (marginPct < settings.minMarginPct) continue;

    const dedupeKey = `${cbA.id}:${cbB.id}:${platformA}:${platformB}`;
    if (inFlight.has(dedupeKey)) continue;

    const dailySpent = await getArbDailySpent();
    const remaining = settings.dailyCapUsd - dailySpent;
    const totalStake = Math.min(settings.maxStakeUsd, remaining);
    if (totalStake < MIN_TRADE_USD) continue;

    const stakeSplitA = legA.currentOdds / combined;
    const stakeSplitB = legB.currentOdds / combined;

    const opp: ArbOpportunity = {
      id: randomUUID(),
      eventLabel: `${cbA.event.homeTeam} vs ${cbA.event.awayTeam}`,
      sport: cbA.event.sport,
      league: cbA.event.league,
      legA: { outcomeId: legA.outcomeId, marketId: legA.marketId, platform: legA.platform, label: legA.label, odds: legA.currentOdds, stakeUsd: totalStake * stakeSplitA },
      legB: { outcomeId: legB.outcomeId, marketId: legB.marketId, platform: legB.platform, label: legB.label, odds: legB.currentOdds, stakeUsd: totalStake * stakeSplitB },
      combinedImplied: combined,
      marginPct,
      totalStakeUsd: totalStake,
    };

    lastTickOppCount += 1;
    inFlight.add(dedupeKey);

    if (settings.mode === 'auto') {
      try {
        await executeOpportunity(opp, settings);
      } finally {
        releaseDedupe(dedupeKey);
      }
    } else {
      pendingConfirmations.set(opp.id, { opp, dedupeKey, expiresAt: Date.now() + CONFIRM_TTL_MS });
      setTimeout(() => {
        if (pendingConfirmations.has(opp.id)) {
          pendingConfirmations.delete(opp.id);
          releaseDedupe(dedupeKey);
        }
      }, CONFIRM_TTL_MS + 1000);
      sendArbConfirmPrompt(opp);
    }
  }
}

async function fireLeg(
  platform: ArbPlatform,
  externalMarketId: string,
  externalOutcomeId: string,
  size: number,
  expectedOdds: number,
): Promise<{ txHash: string }> {
  if (platform === 'sx') {
    const fill = await executeSxBetFill(externalMarketId, externalOutcomeId, size, expectedOdds);
    return { txHash: fill.fillHash };
  }
  const order = await executePolymarketOrder(externalOutcomeId, size, expectedOdds);
  return { txHash: order.orderId };
}

function reasonToMessage(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  if (typeof reason === 'string') return reason;
  return 'unknown_error';
}

/**
 * Executes both legs. Used by both auto-mode (called straight from the
 * scanner) and manual-mode (called from the Telegram confirm callback).
 * Always re-verifies live top-of-book immediately before firing — the
 * opportunity that triggered this could be several seconds (auto) or up to
 * 25s (manual) stale by the time we get here.
 */
export async function executeOpportunity(opp: ArbOpportunity, settings: ArbSettings): Promise<void> {
  const [outcomeA, outcomeB] = await Promise.all([
    prisma.outcome.findUnique({ where: { id: opp.legA.outcomeId }, include: { market: true } }),
    prisma.outcome.findUnique({ where: { id: opp.legB.outcomeId }, include: { market: true } }),
  ]);

  if (!outcomeA || !outcomeB || !outcomeA.externalId || !outcomeB.externalId) {
    log.warn({ oppId: opp.id }, 'arb leg outcome missing at execution time, aborting');
    return;
  }

  const outcomeAExternalId: string = outcomeA.externalId;
  const outcomeBExternalId: string = outcomeB.externalId;
  const marketAExternalId: string = outcomeA.market.externalId;
  const marketBExternalId: string = outcomeB.market.externalId;

  const levelsA = liveLevelsFor(opp.legA.platform, outcomeAExternalId, outcomeA.liquidityLevels, outcomeA.currentOdds, outcomeA.liquidityDepth);
  const levelsB = liveLevelsFor(opp.legB.platform, outcomeBExternalId, outcomeB.liquidityLevels, outcomeB.currentOdds, outcomeB.liquidityDepth);
  const liveOddsA = levelsA[0]?.odds ?? outcomeA.currentOdds;
  const liveOddsB = levelsB[0]?.odds ?? outcomeB.currentOdds;
  const liveCombined = liveOddsA + liveOddsB;
  const liveMarginPct = (1 - liveCombined) * 100;

  if (liveMarginPct < settings.minMarginPct) {
    log.info({ oppId: opp.id, liveMarginPct, requiredPct: settings.minMarginPct }, 'arb opportunity evaporated before execution, aborting');
    return;
  }

  const dailySpent = await getArbDailySpent();
  const remaining = settings.dailyCapUsd - dailySpent;
  const totalStake = Math.min(opp.totalStakeUsd, remaining);
  if (totalStake < MIN_TRADE_USD) {
    log.info({ oppId: opp.id, remaining }, 'daily cap reached before execution, aborting');
    return;
  }

  const stakeSplitA = liveOddsA / liveCombined;
  const stakeSplitB = liveOddsB / liveCombined;
  const stakeA = Math.round(totalStake * stakeSplitA * 100) / 100;
  const stakeB = Math.round(totalStake * stakeSplitB * 100) / 100;

  const arbGroupId = opp.id;

  const [tradeIdA, tradeIdB] = await Promise.all([
    createPendingTrade({ marketId: outcomeA.marketId, outcomeId: outcomeA.id, platform: opp.legA.platform, side: 'buy', requestedSize: stakeA, requestedOdds: liveOddsA, arbGroupId }),
    createPendingTrade({ marketId: outcomeB.marketId, outcomeId: outcomeB.id, platform: opp.legB.platform, side: 'buy', requestedSize: stakeB, requestedOdds: liveOddsB, arbGroupId }),
  ]);

  log.info({ oppId: opp.id, tradeIdA, tradeIdB, stakeA, stakeB, liveMarginPct }, 'firing arb legs');

  const [resultA, resultB] = await Promise.allSettled([
    fireLeg(opp.legA.platform, marketAExternalId, outcomeAExternalId, stakeA, liveOddsA),
    fireLeg(opp.legB.platform, marketBExternalId, outcomeBExternalId, stakeB, liveOddsB),
  ]);

  const filledA = resultA.status === 'fulfilled';
  const filledB = resultB.status === 'fulfilled';

  const txHashA = filledA ? (resultA as PromiseFulfilledResult<{ txHash: string }>).value.txHash : undefined;
  const txHashB = filledB ? (resultB as PromiseFulfilledResult<{ txHash: string }>).value.txHash : undefined;
  const failReasonA = !filledA ? reasonToMessage((resultA as PromiseRejectedResult).reason) : undefined;
  const failReasonB = !filledB ? reasonToMessage((resultB as PromiseRejectedResult).reason) : undefined;

  if (filledA && txHashA) {
    await markTradeFilled(tradeIdA, txHashA, stakeA, liveOddsA);
  } else {
    await markTradeFailed(tradeIdA, failReasonA ?? 'unknown_error');
  }
  if (filledB && txHashB) {
    await markTradeFilled(tradeIdB, txHashB, stakeB, liveOddsB);
  } else {
    await markTradeFailed(tradeIdB, failReasonB ?? 'unknown_error');
  }

  const execResult: ArbExecutionResult = {
    opp: { ...opp, legA: { ...opp.legA, stakeUsd: stakeA, odds: liveOddsA }, legB: { ...opp.legB, stakeUsd: stakeB, odds: liveOddsB }, marginPct: liveMarginPct, combinedImplied: liveCombined, totalStakeUsd: totalStake },
    filledA,
    filledB,
    txHashA,
    txHashB,
    failReasonA,
    failReasonB,
  };

  if (filledA && filledB) {
    await addArbDailySpent(stakeA + stakeB);
    log.info({ oppId: opp.id, totalStake: stakeA + stakeB, marginPct: liveMarginPct }, 'arb executed cleanly, both legs filled');
    sendArbResultNotification(execResult);
  } else if (filledA !== filledB) {
    // The dangerous case. Kill the master switch immediately — do not let
    // the scanner fire another leg while a human hasn't looked at this yet.
    await setArbMode('off');
    log.error({ oppId: opp.id, filledA, filledB }, 'ONE-LEGGED ARB — arb mode auto-disabled');
    sendOneLeggedAlert(execResult);
  } else {
    log.info({ oppId: opp.id }, 'both arb legs failed cleanly, no funds moved');
    sendArbResultNotification(execResult);
  }
}
