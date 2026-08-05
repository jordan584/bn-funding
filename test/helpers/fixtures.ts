import type {
  ExchangeSymbol,
  FundingHistoryRecord,
  FundingIntervalInfo,
  FundingHistorySettlement,
  PremiumIndexRecord,
  VenueFundingSnapshot,
  VenueId,
  VenueSnapshot
} from '../../src/domain.js';

export const AS_OF = Date.UTC(2026, 7, 3, 8, 5, 0);
export const VENUE_AS_OF = Date.UTC(2026, 7, 5, 8, 5, 0);
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

export function venueMarket(
  venue: VenueId,
  asset: string,
  rate = '0.0001',
  intervalHours = venue === 'hyperliquid' ? 1 : 8
): VenueFundingSnapshot {
  return {
    venue,
    marketId: `${asset}-${venue}`,
    rawBaseAsset: asset,
    quoteAsset: venue === 'hyperliquid' ? 'USD' : 'USDT',
    settleAsset: venue === 'hyperliquid' ? 'USDC' : 'USDT',
    nextFundingRate: rate,
    intervalHours,
    nextFundingTime: VENUE_AS_OF + intervalHours * HOUR,
    listedAt: VENUE_AS_OF - 30 * DAY
  };
}

export function venueSnapshot(venue: VenueId, markets: VenueFundingSnapshot[]): VenueSnapshot {
  return {
    venue,
    observedAt: VENUE_AS_OF,
    markets,
    stats: { marketCount: markets.length, requestCount: 1, pageCount: 1 }
  };
}

export function settlement(
  venue: VenueId,
  marketId: string,
  fundingRate: string,
  fundingTime: number
): FundingHistorySettlement {
  return { venue, marketId, fundingRate, fundingTime };
}
