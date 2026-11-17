"use strict";

/**
 * Public `/api/stats/markets` Vercel function.
 *
 * Unlike `api/markets.js` and `api/trade/orderbook.js`, this file is NOT
 * esbuild-bundled from bot source. It's plain CommonJS with zero bot
 * imports, so it needs no build step and can't go stale relative to a
 * forgotten build script.
 *
 * It works by calling this deployment's own `/api/markets` (same origin,
 * so it rides that endpoint's edge cache) and recomputing the best-odds
 * counts from the payload. This is the same event-grouping + canonical-key
 * join `bot/src/routes/stats.ts` does, ported to work off the flat public
 * market list instead of DB-backed MarketGroups.
 *
 * Live order-book edge depth (`edgeMatched24h` / `edgeAllMatched24h`) is
 * NOT computed here — that stat needs the WS-fed order-book caches the
 * always-on bot keeps warm, which a stateless serverless function doesn't
 * have. Both fields are always returned as `null`, which the dashboard
 * already renders correctly (Coverage.tsx treats `null` edge as "no clear
 * winner yet" and hides the edge line). If real edge depth is wanted here,
 * it would need on-demand REST book fetches per matched pair, similar to
 * `bot/src/public/fetchOrderBook.ts` — call `/api/trade/orderbook` per pair
 * and pick the venue with the better price.
 */

const MATCH_WINNER_BET_TYPES = new Set(["12", "1x2"]);

function computeBestOddsCount(groups, matchWinnerOnly) {
  let sx = 0;
  let poly = 0;

  for (const group of groups) {
    const outcomes = matchWinnerOnly
      ? group.outcomes.filter((o) => MATCH_WINNER_BET_TYPES.has(o.betType))
      : group.outcomes;

    const sxByKey = new Map();
    const polyByKey = new Map();

    for (const o of outcomes) {
      if (!(o.impliedOdds > 0)) continue;
      if (!o.canonicalKey) continue;
      const key = `${group.eventId}|${o.canonicalKey}`;
      const map = o.platform === "sx" ? sxByKey : o.platform === "polymarket" ? polyByKey : null;
      if (!map) continue;
      const existing = map.get(key);
      if (existing === undefined || o.impliedOdds < existing) {
        map.set(key, o.impliedOdds);
      }
    }

    const keys = new Set([...sxByKey.keys(), ...polyByKey.keys()]);

    for (const key of keys) {
      const sxOdds = sxByKey.get(key);
      const polyOdds = polyByKey.get(key);
      if (sxOdds === undefined && polyOdds === undefined) continue;
      if (matchWinnerOnly && (sxOdds === undefined || polyOdds === undefined)) continue;
      if (polyOdds === undefined) sx++;
      else if (sxOdds === undefined) poly++;
      else if (sxOdds <= polyOdds) sx++;
      else poly++;
    }
  }

  return { sx, poly, total: sx + poly };
}

// Re-groups the flat `/api/markets` list back into one entry per event
// (mirrors `bot/src/services/marketGroups.ts`'s MarketGroup, minus the
// DB-only fields computeBestOddsCount never touches).
function buildEventGroups(markets) {
  const groups = new Map();
  for (const m of markets) {
    let g = groups.get(m.eventId);
    if (!g) {
      g = { eventId: m.eventId, startTime: m.startTime, platforms: new Set(), outcomes: [] };
      groups.set(m.eventId, g);
    }
    g.platforms.add(m.platform);
    if (m.startTime < g.startTime) g.startTime = m.startTime;
    for (const o of m.outcomes || []) {
      g.outcomes.push({
        platform: o.platform,
        impliedOdds: o.impliedOdds,
        canonicalKey: o.canonicalKey,
        betType: m.betType,
      });
    }
  }
  return [...groups.values()];
}

function getOrigin(req) {
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host || process.env.VERCEL_URL;
  return `${proto}://${host}`;
}

module.exports = async function handler(req, res) {
  try {
    const origin = getOrigin(req);
    const marketsRes = await fetch(`${origin}/api/markets`);
    if (!marketsRes.ok) {
      throw new Error(`upstream /api/markets returned ${marketsRes.status}`);
    }
    const markets = await marketsRes.json();

    const cutoff = Date.now() + 24 * 60 * 60 * 1000;
    const matched24h = buildEventGroups(markets).filter(
      (g) =>
        new Date(g.startTime).getTime() <= cutoff &&
        g.platforms.has("sx") &&
        g.platforms.has("polymarket"),
    );

    const bestOddsMatched24h = computeBestOddsCount(matched24h, true);
    const bestOddsAllMatched24h = computeBestOddsCount(matched24h, false);

    res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=300");
    res.status(200).json({
      bestOddsMatched24h,
      bestOddsAllMatched24h,
      edgeMatched24h: null,
      edgeAllMatched24h: null,
    });
  } catch (err) {
    console.error("[api/stats/markets] failed", err);
    res.status(500).json({
      error: "internal_server_error",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
};
