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

export interface ScheduledSlot {
  key: string;
  scheduledAtMs: number;
}

export interface Logger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}
