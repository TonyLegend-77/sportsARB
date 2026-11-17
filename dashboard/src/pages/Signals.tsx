import { useSignals } from '../hooks/useSignals';
import type { Signal } from '../lib/api';
import { cn } from '../lib/utils';

const fmtPct = (n: number) => `${n >= 10 ? n.toFixed(1) : n.toFixed(2)}%`;

function legPrice(s: Signal, p: number | null): string {
  if (p == null) return '—';
  return s.kind === 'arbitrage' ? p.toFixed(3) : `${(p * 100).toFixed(1)}%`;
}

function SignalCard({ s }: { s: Signal }) {
  const verified = s.kind === 'arbitrage';
  return (
    <div className="border border-tm-bd rounded-md bg-tm-bg-el p-3 flex flex-col gap-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-mono text-[13px] font-semibold text-tm-tx">{s.title}</div>
          <div className="font-mono text-[10px] text-tm-tx-mut">{s.subtitle}</div>
        </div>
        <div className="shrink-0 flex flex-col items-end gap-1">
          <div
            className={cn(
              'font-mono text-[13px] font-bold px-2 py-1 rounded-sm',
              verified ? 'bg-tm-pos/15 text-tm-pos' : 'bg-tm-warn/15 text-tm-warn',
            )}
          >
            +{fmtPct(s.roiPct)}
          </div>
          <div className="font-mono text-[9px] tracking-[0.1em] text-tm-tx-mut">
            {verified ? 'EXECUTABLE' : 'INDICATIVE'}
          </div>
        </div>
      </div>

      <div className="flex flex-col sm:flex-row sm:items-stretch gap-2">
        {s.legs.map((l, i) => (
          <div
            key={`${l.venue}-${l.label}-${i}`}
            className="flex-1 min-w-0 bg-tm-bg-sunk border border-tm-bd rounded-sm px-2.5 py-2"
          >
            <div className="font-mono text-[10px] uppercase tracking-[0.08em] text-tm-tx-mut">{l.venue}</div>
            <div className="font-mono text-[12px] text-tm-tx truncate">{l.label}</div>
            <div className="font-mono text-[10px] text-tm-tx-mut">
              {legPrice(s, l.price)} · size {l.size ?? '?'}
            </div>
          </div>
        ))}
      </div>

      <div className="font-mono text-[10px] text-tm-tx-mut border-t border-tm-bd pt-2">
        {s.detail} As of {new Date(s.asOf).toLocaleTimeString()}.
      </div>
    </div>
  );
}

export function Signals() {
  const { data, loading, error } = useSignals();
  const disabled = error?.message === 'signals_disabled';

  return (
    <div className="max-w-3xl mx-auto p-3 md:p-6 flex flex-col gap-4">
      <div>
        <h1 className="font-mono text-[15px] font-bold text-tm-tx tracking-wide">CROSS-VENUE SIGNALS</h1>
        <p className="font-mono text-[11px] text-tm-tx-mut mt-1">
          Sports signals from Predictefy across Polymarket, SX Bet, Limitless, Predict.fun and more. Signals only — verify both books
          before trading.
        </p>
        {data && (
          <p
            className={cn(
              'font-mono text-[10px] mt-1',
              data.mode === 'arbitrage' ? 'text-tm-pos' : 'text-tm-warn',
            )}
          >
            {data.mode === 'arbitrage'
              ? 'Executable arbitrage feed: live asks, depth, fees and resolution rules are checked.'
              : 'Indicative mode: price gaps only. Depth, fees and resolution rules are NOT checked (arbitrage feed needs a Pro key).'}
          </p>
        )}
      </div>

      {loading && !data && <div className="font-mono text-[12px] text-tm-tx-mut py-8 text-center">Loading signals…</div>}

      {disabled && (
        <div className="font-mono text-[12px] text-tm-tx-mut py-8 text-center border border-dashed border-tm-bd rounded-md">
          Signals are not enabled on this deployment. Set PREDICTEFY_API_KEY and SIGNALS_ENABLED=true.
        </div>
      )}

      {error && !disabled && (
        <div className="font-mono text-[12px] text-tm-neg py-4 text-center border border-dashed border-tm-bd rounded-md">
          Could not load signals: {error.message}
        </div>
      )}

      {data && data.signals.length === 0 && (
        <div className="font-mono text-[12px] text-tm-tx-mut py-8 text-center border border-dashed border-tm-bd rounded-md">
          No qualifying signals right now. This is normal — real gaps are rare and close fast.
        </div>
      )}

      <div className="flex flex-col gap-2.5">
        {data?.signals.map((s) => <SignalCard key={s.id} s={s} />)}
      </div>
    </div>
  );
}
