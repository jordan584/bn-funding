import type {
  FundingVenueAdapter,
  VenueHistoryRequest,
  VenueHistoryResult,
  VenueRequestTelemetrySink,
  VenueSnapshot
} from '../domain.js';
import { BinanceClient, type BinanceClientOptions, BinanceRequestError } from './client.js';

const DEFAULT_FUNDING_INTERVAL_HOURS = 8;

export interface BinanceVenueAdapterOptions extends BinanceClientOptions {
  stocksOnly?: boolean;
}

export class BinanceVenueAdapter implements FundingVenueAdapter {
  readonly id = 'binance' as const;
  private readonly client: BinanceClient;
  private readonly stocksOnly: boolean;

  constructor(options: BinanceVenueAdapterOptions) {
    this.client = new BinanceClient(options);
    this.stocksOnly = options.stocksOnly ?? false;
  }

  async getCurrentSnapshot(onRequestTelemetry?: VenueRequestTelemetrySink): Promise<VenueSnapshot> {
    const [observedAt, symbols, premiumIndexes, fundingIntervals] = await Promise.all([
      this.client.getServerTime(onRequestTelemetry),
      this.client.getExchangeSymbols(onRequestTelemetry),
      this.client.getPremiumIndexes(onRequestTelemetry),
      this.client.getFundingIntervals(onRequestTelemetry)
    ]);
    const eligibleSymbols = symbols.filter((symbol) => (
      symbol.status === 'TRADING'
      && symbol.contractType === (this.stocksOnly ? 'TRADIFI_PERPETUAL' : 'PERPETUAL')
      && symbol.quoteAsset === 'USDT'
    ));
    if (eligibleSymbols.length === 0) {
      throw new BinanceRequestError(
        this.stocksOnly
          ? 'No eligible Binance stock USDT perpetuals'
          : 'No eligible Binance USDT perpetuals'
      );
    }
    const eligibleSymbolIds = new Set(eligibleSymbols.map(({ symbol }) => symbol));
    const premiumBySymbol = new Map<string, typeof premiumIndexes[number]>();
    for (const premium of premiumIndexes) {
      if (!eligibleSymbolIds.has(premium.symbol)) continue;
      if (premiumBySymbol.has(premium.symbol)) {
        throw new BinanceRequestError(`Duplicate Binance premium for ${premium.symbol}`);
      }
      premiumBySymbol.set(premium.symbol, premium);
    }
    const intervalBySymbol = new Map<string, number>();
    for (const interval of fundingIntervals) {
      if (!eligibleSymbolIds.has(interval.symbol)) continue;
      if (intervalBySymbol.has(interval.symbol)) {
        throw new BinanceRequestError(`Duplicate Binance interval for ${interval.symbol}`);
      }
      intervalBySymbol.set(interval.symbol, interval.fundingIntervalHours);
    }
    const markets = eligibleSymbols.map((symbol) => {
      const premium = premiumBySymbol.get(symbol.symbol);
      if (premium === undefined) {
        throw new BinanceRequestError(`Missing Binance current Funding for ${symbol.symbol}`);
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

  async getFundingHistory(
    request: VenueHistoryRequest,
    onRequestTelemetry?: VenueRequestTelemetrySink
  ): Promise<VenueHistoryResult> {
    const { records, pageCount } = await this.client.getFundingHistoryForMarket(
      request.market.marketId,
      request.startTime,
      request.endTime,
      onRequestTelemetry
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
