import Decimal, { Decimal as DecimalInstance } from 'decimal.js';

export type RunMode = 'daemon' | 'send' | 'dry-run';
export type TriggerSource = 'cron' | 'startup-catchup' | 'manual';

export interface AppConfig {
  binanceBaseUrl: URL;
  googleChatWebhookUrl?: URL;
  stateFile: string;
  timezone: 'Asia/Shanghai';
  schedule: '5 0,8,16 * * *';
  catchUpWindowMs: number;
  binanceTimeoutMs: number;
  chatTimeoutMs: number;
}

export interface ExchangeSymbol {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  contractType: string;
  status: string;
  onboardDate: number;
}

export interface FundingHistoryRecord {
  symbol: string;
  fundingRate: string;
  fundingTime: number;
  rateType: 'Regular' | 'Special';
}

export interface PremiumIndexRecord {
  symbol: string;
  lastFundingRate: string;
  nextFundingTime: number;
}

export interface FundingIntervalInfo {
  symbol: string;
  fundingIntervalHours: number;
}

export interface FundingRow {
  rank: number;
  symbol: string;
  asset: string;
  exchange: 'Binance';
  intervalHours: number;
  currentRate: DecimalInstance;
  currentApr: DecimalInstance;
  funding24h: DecimalInstance;
  apr24h: DecimalInstance;
  funding7d: DecimalInstance;
  apr7d: DecimalInstance;
  partialSevenDayHistory: boolean;
}

export interface FundingLeaderboard {
  asOf: number;
  eligibleContractCount: number;
  historyRecordCount: number;
  rows: FundingRow[];
}

export interface GoogleChatMessage {
  text: string;
  cardsV2: Array<{ cardId: string; card: Record<string, unknown> }>;
}

export interface ScheduledSlot {
  key: string;
  scheduledAtMs: number;
}

export type JobResult =
  | { status: 'sent'; slot: string; rowCount: 20 }
  | { status: 'dry-run'; slot: string; rowCount: 20; text: string }
  | { status: 'skipped'; slot: string; reason: 'already-sent' };

export interface RunFundingJobOptions {
  slot: ScheduledSlot;
  trigger: TriggerSource;
  dryRun: boolean;
  force: boolean;
}

export interface Logger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}
