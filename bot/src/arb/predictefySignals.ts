import { config } from '../config';
import { createLogger } from '../logger';
import { sendSignalAlert } from '../telegram/notify';
import { PredictefyError } from '../adapters/predictefy';
import { loadSignals, readSignalSettings, type Signal, type SignalMode } from './predictefySignalsCore';

const log = createLogger('predictefy-signals');

// Signals only. This module NEVER places orders — it alerts, you decide.
const ALERT_COOLDOWN_MS = 5 * 60 * 1000;

let mode: SignalMode = 'arbitrage';
let timer: NodeJS.Timeout | null = null;
let running = false;
const lastAlert = new Map<string, { at: number; roiPct: number }>();

function shouldAlert(s: Signal): boolean {
  const prev = lastAlert.get(s.id);
  const now = Date.now();
  if (prev && now - prev.at < ALERT_COOLDOWN_MS && s.roiPct <= prev.roiPct * 1.2) return false;
  lastAlert.set(s.id, { at: now, roiPct: s.roiPct });
  return true;
}

function formatSignal(s: Signal): string {
  const head = s.kind === 'arbitrage' ? `✅ ARBITRAGE (executable) ${s.roiPct.toFixed(2)}% ROI` : `⚠️ INDICATIVE gap ${s.roiPct.toFixed(2)}% (unverified)`;
  const legs = s.legs
    .map((l) => `${l.label} @ ${l.venue} ${l.price == null ? '?' : s.kind === 'arbitrage' ? l.price : `${(l.price * 100).toFixed(1)}%`} · size ${l.size ?? '?'}`)
    .join('\n');
  return `${head}\n${s.title}\n${s.subtitle}\n${legs}\n${s.detail}\nAs of ${s.asOf} — re-check both books before acting.`;
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const result = await loadSignals(readSignalSettings(), mode);
    if (result.mode !== mode) {
      mode = result.mode;
      log.warn('arbitrage feed needs the Pro plan — falling back to sports screen (indicative only)');
      sendSignalAlert("Predictefy: your key's plan has no arbitrage feed (Pro+). Falling back to indicative sports-screen gaps.");
      reschedule(Number(config.PREDICTEFY_SCREEN_INTERVAL_MS));
    }
    let alerts = 0;
    for (const s of result.signals) {
      if (shouldAlert(s)) {
        sendSignalAlert(formatSignal(s));
        alerts++;
      }
    }
    log.info({ mode: result.mode, signals: result.signals.length, alerts }, 'predictefy tick');
  } catch (err) {
    if (err instanceof PredictefyError) {
      if (err.code === 'INSUFFICIENT_CREDITS') log.error('Predictefy credits exhausted — pausing until next scheduled tick');
      else log.warn({ code: err.code, status: err.status }, `predictefy tick failed: ${err.message}`);
    } else {
      log.error({ err }, 'predictefy tick failed');
    }
  } finally {
    running = false;
  }
}

function reschedule(ms: number): void {
  if (timer) clearInterval(timer);
  timer = setInterval(() => void tick(), ms);
}

export function startPredictefySignals(): void {
  if (!config.PREDICTEFY_API_KEY) {
    log.info('Predictefy signals disabled (PREDICTEFY_API_KEY not set)');
    return;
  }
  log.info({ mode }, 'Predictefy signal scanner started');
  void tick();
  reschedule(Number(config.PREDICTEFY_SCAN_INTERVAL_MS));
}

export function stopPredictefySignals(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
