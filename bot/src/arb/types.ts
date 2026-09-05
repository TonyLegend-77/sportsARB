export type ArbPlatform = 'sx' | 'polymarket';

export interface ArbLeg {
  outcomeId: string;
  marketId: string;
  platform: ArbPlatform;
  label: string;
  odds: number;
  stakeUsd: number;
}

export interface ArbOpportunity {
  id: string;
  eventLabel: string;
  sport: string;
  league: string;
  legA: ArbLeg;
  legB: ArbLeg;
  combinedImplied: number;
  marginPct: number;
  totalStakeUsd: number;
}

export interface ArbExecutionResult {
  opp: ArbOpportunity;
  filledA: boolean;
  filledB: boolean;
  txHashA?: string;
  txHashB?: string;
  failReasonA?: string;
  failReasonB?: string;
}
