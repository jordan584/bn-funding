import type {
  ExchangeSymbol,
  FundingHistoryRecord,
  FundingIntervalInfo,
  PremiumIndexRecord
} from '../../src/domain.js';

export const AS_OF = Date.UTC(2026, 7, 3, 8, 5, 0);
export const HOUR = 60 * 60 * 1_000;
export const DAY = 24 * HOUR;

export function contract(symbol: string, baseAsset = symbol.replace(/USDT$/, '')): ExchangeSymbol {
  return {
    symbol,
    baseAsset,
    quoteAsset: 'USDT',
    contractType: 'PERPETUAL',
    status: 'TRADING',
    onboardDate: AS_OF - 8 * DAY
  };
}

export function premium(symbol: string, lastFundingRate = '0.00010000'): PremiumIndexRecord {
  return { symbol, lastFundingRate, nextFundingTime: AS_OF + 8 * HOUR };
}

export function history(
  symbol: string,
  fundingRate: string,
  fundingTime: number,
  rateType: 'Regular' | 'Special' = 'Regular'
): FundingHistoryRecord {
  return { symbol, fundingRate, fundingTime, rateType };
}

export function interval(symbol: string, fundingIntervalHours: number): FundingIntervalInfo {
  return { symbol, fundingIntervalHours };
}
