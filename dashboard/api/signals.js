"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// ../bot/src/adapters/predictefy.ts
async function pf(path, params = {}) {
  if (!apiKey()) throw new PredictefyError(500, "NO_API_KEY", "PREDICTEFY_API_KEY is not set", false);
  const url = new URL(path, apiUrl());
  for (const [k, v] of Object.entries(params)) if (v !== void 0) url.searchParams.set(k, String(v));
  const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey()}` } });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.success) {
    const e = body?.error ?? {};
    throw new PredictefyError(res.status, e.code ?? "HTTP_ERROR", e.message ?? res.statusText, !!e.retryable);
  }
  return body;
}
async function fetchArbitrageAll(opts) {
  let restarts = 0;
  let cursor;
  const rows = [];
  for (; ; ) {
    try {
      const body = await pf("/api/router/fetchArbitrage", {
        executableOnly: "true",
        contracts: opts.contracts,
        limit: 500,
        snapshotTTL: 0,
        venues: opts.venues,
        cursor
      });
      if (body.meta?.source !== "published") throw new PredictefyError(503, "NOT_PUBLISHED", "published surface unavailable", true);
      rows.push(...body.data);
      cursor = body.page?.hasMore ? body.page.nextCursor : void 0;
      if (!cursor) return rows;
    } catch (err) {
      if (err instanceof PredictefyError && err.status === 400 && err.message.includes("Cursor has expired") && restarts < 3) {
        restarts += 1;
        cursor = void 0;
        rows.length = 0;
        continue;
      }
      throw err;
    }
  }
}
async function fetchSportsScreen(params) {
  const body = await pf("/v1/sports/screen", { marketType: params.marketType, limit: params.limit ?? 100, venues: params.venues });
  return body.data ?? [];
}
var apiUrl, apiKey, PredictefyError;
var init_predictefy = __esm({
  "../bot/src/adapters/predictefy.ts"() {
    "use strict";
    apiUrl = () => process.env.PREDICTEFY_API_URL || "https://data.predictefy.com";
    apiKey = () => process.env.PREDICTEFY_API_KEY;
    PredictefyError = class extends Error {
      constructor(status, code, message, retryable) {
        super(`${code}: ${message}`);
        this.status = status;
        this.code = code;
        this.retryable = retryable;
      }
      status;
      code;
      retryable;
    };
  }
});

// ../bot/src/arb/predictefySignalsCore.ts
var predictefySignalsCore_exports = {};
__export(predictefySignalsCore_exports, {
  envNum: () => envNum,
  loadArbitrageSignals: () => loadArbitrageSignals,
  loadScreenSignals: () => loadScreenSignals,
  loadSignals: () => loadSignals,
  readSignalSettings: () => readSignalSettings
});
function envNum(v, def, min = 0) {
  const n = v === void 0 || v.trim() === "" ? NaN : Number(v);
  return Number.isFinite(n) && n >= min ? n : def;
}
function readSignalSettings() {
  const e = process.env;
  return {
    contracts: envNum(e.PREDICTEFY_CONTRACTS, 100, 1),
    minRoi: envNum(e.PREDICTEFY_MIN_ROI, 5e-3, 0),
    allowedVenues: list(e.PREDICTEFY_VENUES).length ? new Set(list(e.PREDICTEFY_VENUES)) : null,
    excludedVenues: new Set(e.PREDICTEFY_EXCLUDE_VENUES === void 0 || e.PREDICTEFY_EXCLUDE_VENUES.trim() === "" ? ["kalshi"] : list(e.PREDICTEFY_EXCLUDE_VENUES)),
    sportsOnly: e.PREDICTEFY_SPORTS_ONLY !== "false",
    marketTypes: (e.PREDICTEFY_SPORTS_MARKET_TYPES || "moneyline").split(",").map((s) => s.trim()).filter(Boolean)
  };
}
function fromArbitrage(r) {
  const y = r.legs.buyYes;
  const n = r.legs.buyNo;
  return {
    id: `${r.clusterId}|${y.venue}|${n.venue}`,
    kind: "arbitrage",
    title: r.question,
    subtitle: `${r.contracts} contracts \xB7 rules ${r.resolutionEquivalence} (match ${r.matchScore ?? "n/a"})`,
    roiPct: (r.roi ?? 0) * 100,
    legs: [
      { venue: y.venue, label: "Buy YES", price: y.vwap, size: y.filled },
      { venue: n.venue, label: "Buy NO", price: n.vwap, size: n.filled }
    ],
    detail: `Net edge $${r.netEdge?.toFixed(2)} on cost $${r.totalCost?.toFixed(2)}. Executable per Predictefy: live asks, depth, fees and rules all passed.`,
    asOf: r.asOf
  };
}
async function loadArbitrageSignals(s) {
  const rows = await fetchArbitrageAll({ contracts: s.contracts });
  return rows.filter(
    (r) => r.executable && r.label === "arbitrage" && r.roi !== null && // null = not priced, never zero
    r.netEdge !== null && r.legs.buyYes.fullyFilled && r.legs.buyNo.fullyFilled && r.roi >= s.minRoi && venueOk(s, r.legs.buyYes.venue) && venueOk(s, r.legs.buyNo.venue) && (!s.sportsOnly || looksLikeSports(r))
  ).map(fromArbitrage).sort((a, b) => b.roiPct - a.roiPct);
}
async function loadScreenSignals(s) {
  const out = [];
  for (const marketType of s.marketTypes) {
    const games = await fetchSportsScreen({
      marketType,
      venues: s.allowedVenues ? [...s.allowedVenues].join(",") : void 0
    });
    for (const g of games) {
      const sels = g.market?.selections ?? [];
      if (sels.length < 2) continue;
      const picks = sels.map((sel) => {
        const eligible = (sel.cells ?? []).filter((c) => c.source === "live" && !c.stale && c.gross?.probability != null && venueOk(s, c.venue)).map((c) => {
          const feeUnknown = !!c.feeUnknown || !c.net;
          return {
            venue: c.venue,
            p: (feeUnknown ? c.gross : c.net).probability,
            feeUnknown,
            size: c.sizeAtPrice ?? null,
            label: sel.selection ?? sel.label ?? "?"
          };
        }).sort((a, b) => a.p - b.p);
        return eligible[0];
      });
      if (picks.some((p) => !p)) continue;
      if (new Set(picks.map((p) => p.venue)).size < 2) continue;
      const implied = picks.reduce((sum, p) => sum + p.p, 0);
      const roi = 1 / implied - 1;
      if (implied >= 1 || roi < s.minRoi) continue;
      const teams = (g.teams ?? []).map((t) => t.name).join(" vs ");
      out.push({
        id: `screen|${g.fixtureId ?? g.id ?? teams}|${marketType}`,
        kind: "indicative",
        title: teams || "Unknown fixture",
        subtitle: `${marketType}${g.kickoffAt ? ` \xB7 ${g.kickoffAt}` : ""}`,
        roiPct: roi * 100,
        legs: picks.map((p) => ({ venue: p.venue, label: p.label, price: p.p, size: p.size })),
        detail: `Indicative gap, unverified: depth, fees${picks.some((p) => p.feeUnknown) ? " (some gross-only, fees unknown)" : ""} and rules equivalence were not checked.`,
        asOf: g.asOf ?? (/* @__PURE__ */ new Date()).toISOString()
      });
    }
  }
  return out.sort((a, b) => b.roiPct - a.roiPct);
}
async function loadSignals(s, preferred = "arbitrage") {
  const generatedAt = (/* @__PURE__ */ new Date()).toISOString();
  if (preferred === "arbitrage") {
    try {
      return { mode: "arbitrage", planFallback: false, generatedAt, signals: await loadArbitrageSignals(s) };
    } catch (err) {
      if (!(err instanceof PredictefyError) || err.code !== "PLAN_REQUIRED") throw err;
      return { mode: "screen", planFallback: true, generatedAt, signals: await loadScreenSignals(s) };
    }
  }
  return { mode: "screen", planFallback: true, generatedAt, signals: await loadScreenSignals(s) };
}
var list, venueOk, SPORTS_RE, looksLikeSports;
var init_predictefySignalsCore = __esm({
  "../bot/src/arb/predictefySignalsCore.ts"() {
    "use strict";
    init_predictefy();
    list = (v) => (v ?? "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
    venueOk = (s, v) => !s.excludedVenues.has(v.toLowerCase()) && (!s.allowedVenues || s.allowedVenues.has(v.toLowerCase()));
    SPORTS_RE = /\b(vs\.?)\b|\bspread\b|\bo\/u\b|\bover\/under\b|\bmoneyline\b|\btotal (goals|points|runs)\b|\b(nba|nfl|mlb|nhl|epl|ucl|ufc|atp|wta|premier league|champions league|la liga|serie a|bundesliga|ligue 1|world cup)\b/i;
    looksLikeSports = (r) => !!(r.legs.buyYes.selection || r.legs.buyNo.selection) || SPORTS_RE.test(r.question);
  }
});

// serverless/signals.ts
var signals_exports = {};
__export(signals_exports, {
  default: () => handler
});
module.exports = __toCommonJS(signals_exports);
async function handler(_req, res) {
  if (process.env.SIGNALS_ENABLED !== "true" || !process.env.PREDICTEFY_API_KEY) {
    res.status(404).json({ error: "signals_disabled" });
    return;
  }
  try {
    const { loadSignals: loadSignals2, readSignalSettings: readSignalSettings2 } = await Promise.resolve().then(() => (init_predictefySignalsCore(), predictefySignalsCore_exports));
    const result = await loadSignals2(readSignalSettings2(), "arbitrage");
    const sMaxAge = result.mode === "arbitrage" ? 60 : 300;
    res.setHeader("Cache-Control", `public, s-maxage=${sMaxAge}, stale-while-revalidate=${sMaxAge * 2}`);
    res.status(200).json(result);
  } catch (err) {
    console.error("[api/signals] failed", err);
    const code = err.code;
    res.status(502).json({
      error: code ?? "internal_server_error",
      detail: err instanceof Error ? err.message : String(err)
    });
  }
}
