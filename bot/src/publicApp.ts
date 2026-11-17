import cors from 'cors';
import express, { Request, Response, NextFunction } from 'express';
import compression from 'compression';
import healthRouter from './routes/health';
import marketsRouter from './routes/markets';
import statsRouter from './routes/stats';
import orderbookRouter from './routes/orderbook';
import signalsRouter from './routes/signals';
import { createLogger } from './logger';

const log = createLogger('http:public');
const publicApp = express();

publicApp.use(cors());
// gzip — see app.ts for rationale. The public API is the egress hotspot
// since the read-only Vercel dashboard hits it from many visitor sessions.
publicApp.use(compression());
publicApp.use(express.json());
publicApp.use(healthRouter);
publicApp.use(marketsRouter);
publicApp.use(statsRouter);
publicApp.use(orderbookRouter);
// Predictefy data is opt-in on the public app (see SIGNALS_ENABLED) — plan terms limit redistribution.
if (process.env.SIGNALS_ENABLED === 'true') publicApp.use(signalsRouter);

publicApp.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  log.error({ err }, 'unhandled request error');
  res.status(500).json({ error: 'internal_server_error' });
});

export default publicApp;
