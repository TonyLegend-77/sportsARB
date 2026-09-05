import { InlineKeyboard } from 'grammy';
import { getBotInstance } from './bot';
import { config } from '../config';
import { createLogger } from '../logger';
import type { ArbOpportunity, ArbExecutionResult } from '../arb/types';

const log = createLogger('telegram-notify');

function platformLabel(p: string): string {
  return p === 'sx' ? 'SX Bet' : 'Polymarket';
}

function chatId(): number {
  return Number(config.TELEGRAM_AUTHORIZED_CHAT_ID);
}

export interface TradeNotificationData {
  marketName: string;
  outcomeLabel: string;
  platform: string;
  side: string;
  size: number;
  fillOdds?: number;
  txHash?: string;
  status: 'filled' | 'failed';
  failureReason?: string;
}

export function sendTradeNotification(data: TradeNotificationData): void {
  const bot = getBotInstance();
  if (!bot) return;

  const statusIcon = data.status === 'filled' ? '✅' : '❌';
  const platformLabel = data.platform === 'sx' ? 'SX Bet' : 'Polymarket';
  const oddsStr = data.fillOdds != null ? (data.fillOdds * 100).toFixed(1) + '%' : '—';

  let text =
    `${statusIcon} Trade ${data.status.toUpperCase()}\n` +
    `Market: ${data.marketName}\n` +
    `Outcome: ${data.outcomeLabel}\n` +
    `Side: ${data.side} | Size: $${data.size}\n` +
    `Platform: ${platformLabel} | Odds: ${oddsStr}`;

  if (data.txHash) {
    text += `\nTx: ${data.txHash}`;
  }
  if (data.status === 'failed' && data.failureReason) {
    text += `\nReason: ${data.failureReason}`;
  }

  const chatId = Number(config.TELEGRAM_AUTHORIZED_CHAT_ID);
  bot.api.sendMessage(chatId, text).catch((err: unknown) => {
    log.error({ err, chatId }, 'failed to send trade notification');
  });
}

/** Manual-mode: alert with a confirm/skip button. The opportunity expires client-side (see arb/scanner.ts) — this message just prompts the tap. */
export function sendArbConfirmPrompt(opp: ArbOpportunity): void {
  const bot = getBotInstance();
  if (!bot) return;

  const text =
    `⚡ <b>Arb opportunity — confirm within 25s</b>\n\n` +
    `${opp.eventLabel} (${opp.league})\n\n` +
    `${platformLabel(opp.legA.platform)}: ${opp.legA.label} — $${opp.legA.stakeUsd.toFixed(2)} @ ${(opp.legA.odds * 100).toFixed(1)}%\n` +
    `${platformLabel(opp.legB.platform)}: ${opp.legB.label} — $${opp.legB.stakeUsd.toFixed(2)} @ ${(opp.legB.odds * 100).toFixed(1)}%\n\n` +
    `Combined implied: ${(opp.combinedImplied * 100).toFixed(1)}% | Margin: ${opp.marginPct.toFixed(2)}%\n` +
    `Total stake: $${opp.totalStakeUsd.toFixed(2)}\n\n` +
    `Price will be re-verified live the instant you tap — if it's moved past your margin floor, it'll abort instead of firing.`;

  const kb = new InlineKeyboard()
    .text('✅ Execute both legs', `arbexec:${opp.id}`)
    .text('❌ Skip', `arbskip:${opp.id}`);

  bot.api.sendMessage(chatId(), text, { parse_mode: 'HTML', reply_markup: kb }).catch((err: unknown) => {
    log.error({ err }, 'failed to send arb confirm prompt');
  });
}

/** Both legs filled, or both legs failed cleanly (no funds moved). Not used for the one-legged case — see sendOneLeggedAlert. */
export function sendArbResultNotification(result: ArbExecutionResult): void {
  const bot = getBotInstance();
  if (!bot) return;

  const { opp, filledA, filledB } = result;
  const bothFilled = filledA && filledB;
  const icon = bothFilled ? '✅' : '⚪';
  const headline = bothFilled ? 'Arb executed — both legs filled' : 'Arb aborted — no funds moved';

  let text = `${icon} <b>${headline}</b>\n\n${opp.eventLabel} (${opp.league})\n`;
  text += `${platformLabel(opp.legA.platform)}: ${opp.legA.label} — $${opp.legA.stakeUsd.toFixed(2)}${result.txHashA ? ` (${result.txHashA.slice(0, 10)}…)` : ''}\n`;
  text += `${platformLabel(opp.legB.platform)}: ${opp.legB.label} — $${opp.legB.stakeUsd.toFixed(2)}${result.txHashB ? ` (${result.txHashB.slice(0, 10)}…)` : ''}\n`;

  if (bothFilled) {
    text += `\nLocked margin: ${opp.marginPct.toFixed(2)}% on $${opp.totalStakeUsd.toFixed(2)} staked.`;
  } else if (result.failReasonA || result.failReasonB) {
    text += `\nReason: ${result.failReasonA ?? result.failReasonB}`;
  }

  bot.api.sendMessage(chatId(), text, { parse_mode: 'HTML' }).catch((err: unknown) => {
    log.error({ err }, 'failed to send arb result notification');
  });
}

/**
 * THE dangerous case: one leg filled, the other didn't. This is not a
 * locked arb anymore — it's a naked directional position. The scanner
 * auto-disables arb mode the moment this fires; this message exists to get
 * a human looking at it immediately.
 */
export function sendOneLeggedAlert(result: ArbExecutionResult): void {
  const bot = getBotInstance();
  if (!bot) return;

  const { opp, filledA } = result;
  const filledLeg = filledA ? opp.legA : opp.legB;
  const failedLeg = filledA ? opp.legB : opp.legA;
  const failReason = filledA ? result.failReasonB : result.failReasonA;
  const txHash = filledA ? result.txHashA : result.txHashB;

  const text =
    `🚨 <b>ONE-LEGGED ARB — MANUAL ACTION NEEDED</b>\n\n` +
    `${opp.eventLabel} (${opp.league})\n\n` +
    `FILLED: ${platformLabel(filledLeg.platform)} — ${filledLeg.label} — $${filledLeg.stakeUsd.toFixed(2)} @ ${(filledLeg.odds * 100).toFixed(1)}%` +
    `${txHash ? `\nTx: ${txHash}` : ''}\n\n` +
    `DID NOT FILL: ${platformLabel(failedLeg.platform)} — ${failedLeg.label}\n` +
    `Reason: ${failReason ?? 'unknown'}\n\n` +
    `You are now holding a naked position on ${platformLabel(filledLeg.platform)}, not a locked arb. Arb mode has been switched OFF automatically. ` +
    `Decide manually: hedge the other side yourself, or hold the position and accept the outcome risk. Use /arbon or /arbmanual to resume once you're clear.`;

  bot.api.sendMessage(chatId(), text, { parse_mode: 'HTML' }).catch((err: unknown) => {
    log.error({ err }, 'failed to send one-legged arb alert');
  });
}
