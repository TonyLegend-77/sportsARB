import { Wallet, hexlify, randomBytes } from 'ethers';
import { config } from '../config';

// SX Bet V3 cut over August 26, 2026 — the V2 /orders/fill/v2 endpoint and its
// "FillObject" EIP-712 struct are gone. Taking liquidity is now the same
// endpoint as posting (POST /orders-v3), distinguished only by timeInForce.
// See https://docs.sx.bet/developers/migrate-to-v3 and
// https://docs.sx.bet/developers/taking-liquidity.
//
// Domain and baseToken are no longer hardcoded — they come from GET
// /metadata/obv3 on every call. That endpoint is cheap and this isn't a
// hot path (one call per arb leg), so no caching layer here beyond a short
// TTL; simpler, and can't go stale mid-trade.

const ODDS_PRECISION = 10n ** 20n; // percentageOdds scale
const USDC_DECIMALS = 1_000_000; // totalBetSize scale

const ORDER_TYPES = {
  Order: [
    { name: 'marketHash', type: 'bytes32' },
    { name: 'baseToken', type: 'address' },
    { name: 'totalBetSize', type: 'uint256' },
    { name: 'percentageOdds', type: 'uint256' },
    { name: 'salt', type: 'uint256' },
    { name: 'expiry', type: 'uint256' },
    { name: 'maker', type: 'address' },
    { name: 'isMakerBettingOutcomeOne', type: 'bool' },
  ],
};

interface Metadata {
  domain: { name: string; version: string; chainId: number; verifyingContract: string };
  activeAsset: { baseToken: string };
}

interface OrdersV3Response {
  status: 'success' | 'FAILED';
  data?: {
    orders: Array<{
      orderId: string;
      status: 'SUBMITTED' | 'FAILED';
      outcome?: {
        state: 'FULLY_FILLED' | 'PARTIAL_FILL_DONE' | 'NO_FILL' | string;
        remainingAmount: string;
        fillAmount: string;
        blendedOdds: string;
        tradeId?: string;
      };
    }>;
  };
  errors?: unknown;
}

export interface SxFillResult {
  fillHash: string; // tradeId (or orderId if a trade never formed) — used as our internal reference
  isPartialFill: boolean;
  filledSize: number; // USDC actually filled
  fillOdds: number; // 0–1, blended taker odds actually received
}

let metadataCache: { data: Metadata; fetchedAt: number } | null = null;
const METADATA_TTL_MS = 60_000;

async function getMetadata(): Promise<Metadata> {
  if (metadataCache && Date.now() - metadataCache.fetchedAt < METADATA_TTL_MS) {
    return metadataCache.data;
  }
  const res = await fetch(`${config.SX_BET_API_URL}/metadata/obv3`);
  if (!res.ok) throw new Error(`SX metadata fetch failed (${res.status})`);
  const body = (await res.json()) as { data: Metadata };
  metadataCache = { data: body.data, fetchedAt: Date.now() };
  return body.data;
}

/**
 * Execute a taker fill on SX Bet V3 by posting an IOC order.
 *
 * @param _gameExternalId  - unused (kept for call-site compatibility with the arb scanner / router)
 * @param externalOutcomeId - outcome externalId in format "${specificMarketHash}:0|1", where the
 *   suffix is which side we're betting — see adapters/sxbet.ts for how this is built.
 *   "0" means we bet outcomeOne, "1" means outcomeTwo.
 * @param size - USDC amount to stake
 * @param desiredOddsDecimal - worst acceptable taker odds (0–1), e.g. 0.475 — matches at this
 *   price or better; V3 has no separate slippage field, percentageOdds itself is the bound.
 */
export async function executeSxBetFill(
  _gameExternalId: string,
  externalOutcomeId: string,
  size: number,
  desiredOddsDecimal: number,
): Promise<SxFillResult> {
  const colonIdx = externalOutcomeId.lastIndexOf(':');
  if (colonIdx < 0) {
    throw new Error(`Invalid SX Bet outcome externalId (expected "hash:index"): ${externalOutcomeId}`);
  }
  const marketHash = externalOutcomeId.slice(0, colonIdx);
  const outcomeIndex = externalOutcomeId.slice(colonIdx + 1);
  const isMakerBettingOutcomeOne = outcomeIndex === '0';

  if (!config.SX_PRIVATE_KEY) throw new Error('SX trading credentials are not configured (READ_ONLY_MODE is active)');
  const wallet = new Wallet(config.SX_PRIVATE_KEY);

  const meta = await getMetadata();

  const totalBetSize = String(Math.round(size * USDC_DECIMALS));
  // percentageOdds is our own outcome's implied probability, worst-acceptable, at 10^20 scale.
  const percentageOdds = String(BigInt(Math.round(desiredOddsDecimal * 1e18)) * 100n);
  const salt = hexlify(randomBytes(32));
  const expiry = Math.floor(Date.now() / 1000) + 3600; // 1 hour out — real unix seconds, required in V3

  const order = {
    marketHash,
    baseToken: meta.activeAsset.baseToken,
    totalBetSize,
    percentageOdds,
    salt,
    expiry,
    maker: wallet.address,
    isMakerBettingOutcomeOne,
  };

  const orderSignature = await wallet.signTypedData(meta.domain, ORDER_TYPES, order);

  const res = await fetch(`${config.SX_BET_API_URL}/orders-v3`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-sx-api-key': config.SX_BET_API_KEY },
    body: JSON.stringify({
      orders: [{ ...order, timeInForce: 'IOC', orderSignature }],
      // Block for the match result instead of the new-default async behavior —
      // we need to know the fill outcome synchronously to report it back to
      // the arb scanner / trade route.
      waitForOutcome: true,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`SX Bet order failed (${res.status}): ${text}`);
  }

  const result = (await res.json()) as OrdersV3Response;
  const orderResult = result.data?.orders?.[0];

  if (result.status !== 'success' || !orderResult) {
    throw new Error(`SX Bet order rejected: ${JSON.stringify(result)}`);
  }
  if (orderResult.status === 'FAILED') {
    throw new Error(`SX Bet order failed: ${JSON.stringify(orderResult)}`);
  }

  const outcome = orderResult.outcome;
  const fillAmountRaw = outcome?.fillAmount ?? '0';
  const filledSize = parseInt(fillAmountRaw, 10) / USDC_DECIMALS;

  if (filledSize <= 0) {
    // IOC with nothing matched — SUBMITTED but no trade. Treat as a failure
    // so the caller's fail-handling path runs (no funds moved, nothing to mark filled).
    throw new Error(`SX Bet IOC did not match: ${outcome?.state ?? 'NO_FILL'}`);
  }

  const fillOdds = outcome?.blendedOdds
    ? Number(BigInt(outcome.blendedOdds)) / Number(ODDS_PRECISION)
    : desiredOddsDecimal;

  const isPartialFill = outcome?.state === 'PARTIAL_FILL_DONE';
  const fillHash = outcome?.tradeId ?? orderResult.orderId;

  return { fillHash, isPartialFill, filledSize, fillOdds };
}
