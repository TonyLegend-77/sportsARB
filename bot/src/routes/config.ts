import { Router, Request, Response } from 'express';
import { prisma } from '../db';
import { orderBookCache } from '../services/orderBookCache';
import { polymarketBookCache } from '../services/polymarketBookCache';
import { createLogger } from '../logger';

const log = createLogger('config');
const router = Router();

router.get('/api/config', async (_req: Request, res: Response) => {
  try {
    const rows = await prisma.botConfig.findMany({ orderBy: { key: 'asc' } });
    res.json(rows);
  } catch (err) {
    log.error({ err }, 'failed to fetch config');
    res.status(500).json({ error: 'internal_server_error' });
  }
});

router.put('/api/config/:key', async (req: Request, res: Response) => {
  const { key } = req.params;
  const { value } = req.body as { value?: string };

  if (value == null) {
    res.status(400).json({ error: 'value is required' });
    return;
  }

  if (key === 'orderBookLevels') {
    const parsed = parseInt(value, 10);
    if (isNaN(parsed) || parsed < 3 || parsed > 25) {
      res.status(400).json({ error: 'orderBookLevels must be an integer between 3 and 25' });
      return;
    }
  }

  if (key === 'arbMode') {
    if (value !== 'off' && value !== 'manual' && value !== 'auto') {
      res.status(400).json({ error: 'arbMode must be one of: off, manual, auto' });
      return;
    }
  }

  if (key === 'arbMinMarginPct' || key === 'arbMaxStakeUsd' || key === 'arbDailyCapUsd') {
    const parsed = parseFloat(value);
    if (isNaN(parsed) || parsed <= 0) {
      res.status(400).json({ error: `${key} must be a positive number` });
      return;
    }
    if (key === 'arbMaxStakeUsd' && parsed > 5000) {
      res.status(400).json({ error: 'arbMaxStakeUsd capped at 5000 as a sanity limit — raise this in code if you really mean it' });
      return;
    }
  }

  try {
    const row = await prisma.botConfig.upsert({
      where: { key },
      update: { value },
      create: { key, value },
    });
    if (key === 'orderBookLevels') {
      orderBookCache.setTopLevels(parseInt(value, 10));
      polymarketBookCache.setTopLevels(parseInt(value, 10));
    }
    res.json(row);
  } catch (err) {
    log.error({ err, key }, 'failed to update config');
    res.status(500).json({ error: 'internal_server_error' });
  }
});

export default router;
