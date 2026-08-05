import type {
  FundingVenueAdapter,
  VenueHistoryRequest,
  VenueHistoryResult,
  VenueSnapshot
} from '../domain.js';
import { BinanceClient, type BinanceClientOptions } from './client.js';

const DEFAULT_FUNDING_INTERVAL_HOURS = 8;

export class BinanceVenueAdapter implements FundingVenueAdapter {
  readonly id = 'binance' as const;
  private readonly client: BinanceClient;

  constructor(options: BinanceClientOptions) {
    this.client = new BinanceClient(options);
  }

  async getCurrentSnapshot(): Promise<VenueSnapshot> {
    const [observedAt, symbols, premiumIndexes, fundingIntervals] = await Promise.all([
      this.client.getServerTime(),
      this.client.getExchangeSymbols(),
      this.client.getPremiumIndexes(),
      this.client.getFundingIntervals()
    ]);
    const premiumBySymbol = new Map(premiumIndexes.map((premium) => [premium.symbol, premium]));
    const intervalBySymbol = new Map(fundingIntervals.map((interval) => [
      interval.symbol,
      interval.fundingIntervalHours
    ]));
    const eligibleSymbols = symbols.filter((symbol) => (
      symbol.status === 'TRADING'
      && symbol.contractType === 'PERPETUAL'
      && symbol.quoteAsset === 'USDT'
    ));
    const markets = eligibleSymbols.map((symbol) => {
      const premium = premiumBySymbol.get(symbol.symbol);
      if (premium === undefined) {
        throw new Error(`Missing Binance current Funding for ${symbol.symbol}`);
      }
      return {
        venue: this.id,
        marketId: symbol.symbol,
        rawBaseAsset: symbol.baseAsset,
        quoteAsset: symbol.quoteAsset,
        settleAsset: 'USDT',
        nextFundingRate: premium.lastFundingRate,
        intervalHours: intervalBySymbol.get(symbol.symbol) ?? DEFAULT_FUNDING_INTERVAL_HOURS,
        nextFundingTime: premium.nextFundingTime,
        listedAt: symbol.onboardDate
      };
    });

    return {
      venue: this.id,
      observedAt,
      markets,
      stats: { marketCount: markets.length, requestCount: 4, pageCount: 0 }
    };
  }

  async getFundingHistory(request: VenueHistoryRequest): Promise<VenueHistoryResult> {
    const { records, pageCount } = await this.client.getFundingHistoryForMarket(
      request.market.marketId,
      request.startTime,
      request.endTime
    );
    return {
      records: records
        .filter((record) => record.rateType === 'Regular')
        .map((record) => ({
          venue: this.id,
          marketId: record.symbol,
          fundingRate: record.fundingRate,
          fundingTime: record.fundingTime
        })),
      requestCount: pageCount,
      pageCount,
      completeFrom: request.startTime
    };
  }
}
