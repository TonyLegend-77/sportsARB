import { Router, Request, Response } from 'express';
import { loadSignals, readSignalSettings, type SignalsResult } from '../arb/predictefySignalsCore';
import { PredictefyError } from '../adapters/predictefy';

const router = Router();

// Short in-process cache so many dashboard viewers never multiply Predictefy credit spend.
const TTL_MS = 30_000;
let cache: { at: number; result: SignalsResult } | null = null;
let inflight: Promise<SignalsResult> | null = null;

router.get('/api/signals', async (_req: Request, res: Response) => {
  if (!process.env.PREDICTEFY_API_KEY) {
    res.status(404).json({ error: 'signals_disabled' });
    return;
  }
  try {
    if (!cache || Date.now() - cache.at > TTL_MS) {
      inflight ??= loadSignals(readSignalSettings(), cache?.result.mode ?? 'arbitrage').finally(() => {
        inflight = null;
      });
      cache = { at: Date.now(), result: await inflight };
    }
    res.json(cache.result);
  } catch (err) {
    if (err instanceof PredictefyError) {
      res.status(502).json({ error: err.code, message: err.message });
      return;
    }
    res.status(500).json({ error: 'internal_server_error' });
  }
});

export default router;
