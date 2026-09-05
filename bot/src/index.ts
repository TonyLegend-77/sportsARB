import './config'; // validates env vars first — exits process if any are missing
import { config } from './config';
import { prisma } from './db';
import app from './app';
import publicApp from './publicApp';
import { startMarketSync } from './sync/marketSync';
import { startTelegramBot } from './telegram/bot';
import { startWsRelay } from './ws/relay';
import { startCentrifugoService } from './services/centrifugo';
import { startPolymarketWsService } from './services/polymarketWs';
import { startPersistentPolyOddsService } from './services/persistentPolyOdds';
import { startFixtureFinalizer } from './services/sxFixtureService';
import { startArbScanner } from './arb/scanner';
import { createLogger } from './logger';

const dbLog = createLogger('db');
const apiLog = createLogger('api');
const publicApiLog = createLogger('api:public');

async function main() {
  try {
    await prisma.$connect();
    dbLog.info('connected');
  } catch (err) {
    dbLog.error({ err }, 'failed to connect');
    process.exit(1);
  }

  const port = Number(config.PORT);

  if (config.READ_ONLY_MODE) {
    const server = publicApp.listen(port, () => {
      publicApiLog.info({ port, logLevel: config.LOG_LEVEL }, 'Public read-only API listening');
      startWsRelay(server);
      startFixtureFinalizer();
      startCentrifugoService();
      startPolymarketWsService();
      startPersistentPolyOddsService();
      startMarketSync();
    });
    return;
  }

  const server = app.listen(port, () => {
    apiLog.info({ port, logLevel: config.LOG_LEVEL }, 'Sports Prediction Market Router API listening');
    startWsRelay(server);
    startFixtureFinalizer();
    startCentrifugoService();
    startPolymarketWsService();
    startPersistentPolyOddsService();
    startMarketSync();
    if (config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_AUTHORIZED_CHAT_ID) {
      startTelegramBot();
    } else {
      apiLog.info('Telegram bot disabled (TELEGRAM_BOT_TOKEN and/or TELEGRAM_AUTHORIZED_CHAT_ID not set)');
    }

    // Arb scanner always starts (interval is cheap), but its own mode check
    // (BotConfig 'arbMode', default 'off') keeps it a no-op until you flip
    // it on with /arbon or /arbmanual. Manual mode without Telegram running
    // is a dead end (nowhere to see the confirm prompt), so warn about it.
    startArbScanner(Number(config.ARB_SCAN_INTERVAL_MS));
    if (!config.TELEGRAM_BOT_TOKEN || !config.TELEGRAM_AUTHORIZED_CHAT_ID) {
      apiLog.info('Arb scanner started, but Telegram is disabled — auto mode will still execute and log, but manual-mode prompts have nowhere to go.');
    }
  });

  if (config.PUBLIC_PORT) {
    const publicPort = Number(config.PUBLIC_PORT);
    const publicServer = publicApp.listen(publicPort, () => {
      publicApiLog.info({ port: publicPort }, 'Public read-only API listening');
      startWsRelay(publicServer);
    });
  }
}

main();
