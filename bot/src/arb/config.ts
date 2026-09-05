import { prisma } from '../db';

export type ArbMode = 'off' | 'manual' | 'auto';

export interface ArbSettings {
  mode: ArbMode;
  /** Minimum combined edge required before an opportunity is even surfaced. */
  minMarginPct: number;
  /** Hard cap on total stake (both legs combined) for a single opportunity. */
  maxStakeUsd: number;
  /** Hard cap on total stake across all arb trades in a rolling UTC day. */
  dailyCapUsd: number;
}

// Deliberately conservative — this is real money with no default expectation
// of profit. Raise these once you've watched it run in manual mode for a
// while and trust the numbers.
const DEFAULTS: ArbSettings = {
  mode: 'off',
  minMarginPct: 1.5,
  maxStakeUsd: 25,
  dailyCapUsd: 100,
};

const KEYS = {
  mode: 'arbMode',
  minMarginPct: 'arbMinMarginPct',
  maxStakeUsd: 'arbMaxStakeUsd',
  dailyCapUsd: 'arbDailyCapUsd',
} as const;

async function readConfigValue(key: string): Promise<string | null> {
  const row = await prisma.botConfig.findUnique({ where: { key } });
  return row?.value ?? null;
}

export async function getArbSettings(): Promise<ArbSettings> {
  const [modeRaw, marginRaw, stakeRaw, dailyRaw] = await Promise.all([
    readConfigValue(KEYS.mode),
    readConfigValue(KEYS.minMarginPct),
    readConfigValue(KEYS.maxStakeUsd),
    readConfigValue(KEYS.dailyCapUsd),
  ]);

  const mode: ArbMode = modeRaw === 'manual' || modeRaw === 'auto' ? modeRaw : 'off';
  const minMarginPct = marginRaw != null && !isNaN(parseFloat(marginRaw)) ? parseFloat(marginRaw) : DEFAULTS.minMarginPct;
  const maxStakeUsd = stakeRaw != null && !isNaN(parseFloat(stakeRaw)) ? parseFloat(stakeRaw) : DEFAULTS.maxStakeUsd;
  const dailyCapUsd = dailyRaw != null && !isNaN(parseFloat(dailyRaw)) ? parseFloat(dailyRaw) : DEFAULTS.dailyCapUsd;

  return { mode, minMarginPct, maxStakeUsd, dailyCapUsd };
}

export async function setArbMode(mode: ArbMode): Promise<void> {
  await prisma.botConfig.upsert({
    where: { key: KEYS.mode },
    update: { value: mode },
    create: { key: KEYS.mode, value: mode },
  });
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

const SPENT_KEY = 'arbDailySpentUsd';
const SPENT_DATE_KEY = 'arbDailySpentDate';

/** Returns cumulative arb stake spent so far today (UTC), resetting the counter if the day rolled over. */
export async function getArbDailySpent(): Promise<number> {
  const [dateRow, spentRow] = await Promise.all([
    readConfigValue(SPENT_DATE_KEY),
    readConfigValue(SPENT_KEY),
  ]);
  if (dateRow !== todayUtc()) return 0;
  const spent = spentRow != null ? parseFloat(spentRow) : 0;
  return isNaN(spent) ? 0 : spent;
}

/** Adds to today's cumulative spend, resetting the counter first if the day rolled over. */
export async function addArbDailySpent(amountUsd: number): Promise<void> {
  const current = await getArbDailySpent();
  const next = current + amountUsd;
  const today = todayUtc();
  await Promise.all([
    prisma.botConfig.upsert({
      where: { key: SPENT_DATE_KEY },
      update: { value: today },
      create: { key: SPENT_DATE_KEY, value: today },
    }),
    prisma.botConfig.upsert({
      where: { key: SPENT_KEY },
      update: { value: String(next) },
      create: { key: SPENT_KEY, value: String(next) },
    }),
  ]);
}
