import { useMemo } from 'react';
import { useMarketList } from '../hooks/useMarketList';
import { findArbitrageOpportunities, type ArbitrageOpportunity } from '../lib/arbitrage';
import { VenueLogo } from '../components/VenueLogo';
import { formatDate } from '../lib/marketUtils';
import { cn } from '../lib/utils';

function fmtUSD(n: number): string {
  if (!isFinite(n) || n <= 0) return '$0';
  if (n >= 1000) return `$${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return `$${Math.round(n)}`;
}

function fmtPct(n: number): string {
  return `${n >= 10 ? n.toFixed(1) : n.toFixed(2)}%`;
}

function LegCard({ leg }: { leg: ArbitrageOpportunity['legA'] }) {
  return (
    <div className="flex items-center gap-2 bg-tm-bg-sunk border border-tm-bd rounded-sm px-2.5 py-2 flex-1 min-w-0">
      <VenueLogo platform={leg.platform} size={16} />
      <div className="min-w-0 flex-1">
        <div className="font-mono text-[12px] text-tm-tx truncate">{leg.label}</div>
        <div className="font-mono text-[10px] text-tm-tx-mut">
          {(leg.impliedOdds * 100).toFixed(1)}% implied · {fmtUSD(leg.availableSize)} avail
        </div>
      </div>
    </div>
  );
}

function OpportunityCard({ opp }: { opp: ArbitrageOpportunity }) {
  const highConfidence = opp.marginPct >= 1;
  return (
    <div className="border border-tm-bd rounded-md bg-tm-bg-el p-3 flex flex-col gap-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-mono text-[13px] font-semibold text-tm-tx truncate">{opp.matchName}</div>
          <div className="font-mono text-[10px] text-tm-tx-mut">
            {opp.league} · {formatDate(opp.startTime)}
          </div>
        </div>
        <div
          className={cn(
            'shrink-0 font-mono text-[13px] font-bold px-2 py-1 rounded-sm',
            highConfidence ? 'bg-tm-pos/15 text-tm-pos' : 'bg-tm-warn/15 text-tm-warn',
          )}
        >
          +{fmtPct(opp.roiPct)}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <LegCard leg={opp.legA} />
        <span className="font-mono text-[10px] text-tm-tx-mut shrink-0">+</span>
        <LegCard leg={opp.legB} />
      </div>

      <div className="flex items-center justify-between font-mono text-[10px] text-tm-tx-mut border-t border-tm-bd pt-2">
        <span>
          Combined implied {(opp.combinedImplied * 100).toFixed(1)}% · margin {fmtPct(opp.marginPct)}
        </span>
        <span>
          Stake split {Math.round(opp.stakeSplitA * 100)}/{Math.round(opp.stakeSplitB * 100)} · max{' '}
          {fmtUSD(opp.maxTotalStake)}
        </span>
      </div>
    </div>
  );
}

export function Arbitrage() {
  const { markets, loading } = useMarketList();
  const opportunities = useMemo(() => findArbitrageOpportunities(markets), [markets]);

  return (
    <div className="max-w-3xl mx-auto p-3 md:p-6 flex flex-col gap-4">
      <div>
        <h1 className="font-mono text-[15px] font-bold text-tm-tx tracking-wide">ARBITRAGE</h1>
        <p className="font-mono text-[11px] text-tm-tx-mut mt-1">
          Complementary outcomes priced on both venues where the combined implied probability is under 100%.
          Stake split is the allocation that locks equal profit regardless of outcome. Quotes refresh every 60s —
          verify live prices on each venue before betting.
        </p>
      </div>

      {loading && opportunities.length === 0 && (
        <div className="font-mono text-[12px] text-tm-tx-mut py-8 text-center">Loading markets…</div>
      )}

      {!loading && opportunities.length === 0 && (
        <div className="font-mono text-[12px] text-tm-tx-mut py-8 text-center border border-dashed border-tm-bd rounded-md">
          No arbitrage opportunities right now. This is normal — locks are rare and close fast when they appear.
        </div>
      )}

      <div className="flex flex-col gap-2.5">
        {opportunities.map((opp) => (
          <OpportunityCard key={opp.id} opp={opp} />
        ))}
      </div>
    </div>
  );
}
