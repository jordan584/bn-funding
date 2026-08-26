import { Decimal } from 'decimal.js';
import { z } from 'zod';

import type {
  FundingVenueAdapter,
  VenueFundingSnapshot,
  VenueHistoryRequest,
  VenueHistoryResult,
  VenueRequestTelemetrySink,
  VenueSnapshot
} from '../domain.js';
import {
  PublicJsonClient,
  type PublicJsonClientOptions,
  requestTelemetryContext,
  VenueRequestError
} from '../exchanges/http.js';
import {
  bybitFundingHistoryEnvelopeSchema,
  bybitInstrumentsEnvelopeSchema,
  bybitTickersEnvelopeSchema
} from './schemas.js';

export interface BybitClientOptions {
  baseUrl: URL;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  maxRetries?: number;
  minRequestIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
  stocksOnly?: boolean;
}

const MAX_HISTORY_RECORDS = 200;

export class BybitClient implements FundingVenueAdapter {
  readonly id = 'bybit' as const;
  private readonly http: PublicJsonClient;
  private readonly now: () => number;
  private readonly stocksOnly: boolean;

  constructor(options: BybitClientOptions) {
    this.now = options.now ?? Date.now;
    this.stocksOnly = options.stocksOnly ?? false;
    const httpOptions: PublicJsonClientOptions = {
      venue: this.id,
      baseUrl: options.baseUrl,
      minRequestIntervalMs: options.minRequestIntervalMs ?? 55,
      now: this.now
    };
    if (options.fetch !== undefined) httpOptions.fetch = options.fetch;
    if (options.timeoutMs !== undefined) httpOptions.timeoutMs = options.timeoutMs;
    if (options.maxRetries !== undefined) httpOptions.maxRetries = options.maxRetries;
    if (options.sleep !== undefined) httpOptions.sleep = options.sleep;
    if (options.random !== undefined) httpOptions.random = options.random;
    this.http = new PublicJsonClient(httpOptions);
  }

  async getCurrentSnapshot(onRequestTelemetry?: VenueRequestTelemetrySink): Promise<VenueSnapshot> {
    const observedAt = this.now();
    if (!Number.isSafeInteger(observedAt)) {
      throw new VenueRequestError(this.id, 'Invalid Bybit observation time');
    }

    const { instruments, pageCount } = await this.getInstruments(onRequestTelemetry);
    const eligibleInstruments = instruments.filter((instrument) => (
      instrument.contractType === 'LinearPerpetual'
      && instrument.status === 'Trading'
      && instrument.settleCoin === 'USDT'
      && (!this.stocksOnly || instrument.symbolType === 'stock')
    ));
    if (eligibleInstruments.length === 0) {
      throw new VenueRequestError(
        this.id,
        this.stocksOnly
          ? 'No eligible Bybit stock USDT linear perpetuals'
          : 'No eligible Bybit USDT linear perpetuals'
      );
    }

    const eligibleBySymbol = new Map<string, typeof eligibleInstruments[number]>();
    for (const instrument of eligibleInstruments) {
      if (instrument.symbol.trim() === '' || eligibleBySymbol.has(instrument.symbol)) {
        throw new VenueRequestError(this.id, `Invalid Bybit eligible instrument ${instrument.symbol}`);
      }
      eligibleBySymbol.set(instrument.symbol, instrument);
    }

    const tickers = this.parseEnvelope(
      bybitTickersEnvelopeSchema,
      await this.http.getJson(
        '/v5/market/tickers',
        { category: 'linear' },
        requestTelemetryContext('current', onRequestTelemetry)
      )
    );
    if (tickers.category !== 'linear') {
      throw new VenueRequestError(this.id, 'Invalid Bybit ticker category');
    }
    const tickerBySymbol = new Map<string, typeof tickers.list[number]>();
    for (const ticker of tickers.list) {
      if (!eligibleBySymbol.has(ticker.symbol)) continue;
      if (tickerBySymbol.has(ticker.symbol)) {
        throw new VenueRequestError(this.id, `Duplicate Bybit current funding for ${ticker.symbol}`);
      }
      tickerBySymbol.set(ticker.symbol, ticker);
    }

    const markets: VenueFundingSnapshot[] = [];
    for (const instrument of eligibleInstruments) {
      const ticker = tickerBySymbol.get(instrument.symbol);
      if (ticker === undefined) {
        throw new VenueRequestError(this.id, `Missing Bybit current funding for ${instrument.symbol}`);
      }
      const intervalHours = resolveIntervalHours(instrument.fundingInterval, ticker.fundingIntervalHour, instrument.symbol);
      const nextFundingTime = parseTimestamp(ticker.nextFundingTime, 'nextFundingTime');
      if (nextFundingTime <= observedAt) {
        throw new VenueRequestError(this.id, `Invalid Bybit nextFundingTime for ${instrument.symbol}`);
      }
      validateFundingRate(ticker.fundingRate, instrument.symbol);
      markets.push({
        venue: this.id,
        marketId: instrument.symbol,
        rawBaseAsset: nonEmpty(instrument.baseCoin, 'baseCoin', instrument.symbol),
        quoteAsset: nonEmpty(instrument.quoteCoin, 'quoteCoin', instrument.symbol),
        settleAsset: instrument.settleCoin,
        nextFundingRate: ticker.fundingRate,
        intervalHours,
        nextFundingTime,
        listedAt: parseTimestamp(instrument.launchTime, 'launchTime')
      });
    }

    return {
      venue: this.id,
      observedAt,
      markets,
      stats: {
        marketCount: markets.length,
        requestCount: pageCount + 1,
        pageCount
      }
    };
  }

  async getFundingHistory(
    request: VenueHistoryRequest,
    onRequestTelemetry?: VenueRequestTelemetrySink
  ): Promise<VenueHistoryResult> {
    validateHistoryWindow(request.startTime, request.endTime);
    const response = this.parseEnvelope(
      bybitFundingHistoryEnvelopeSchema,
      await this.http.getJson('/v5/market/funding/history', {
        category: 'linear',
        symbol: request.market.marketId,
        startTime: String(request.startTime),
        endTime: String(request.endTime),
        limit: String(MAX_HISTORY_RECORDS)
      }, requestTelemetryContext('history', onRequestTelemetry))
    );
    if (response.category !== 'linear') {
      throw new VenueRequestError(this.id, 'Invalid Bybit funding history category');
    }

    const records: VenueHistoryResult['records'] = [];
    const seen = new Set<string>();
    for (const settlement of response.list) {
      const fundingTime = parseTimestamp(settlement.fundingRateTimestamp, 'fundingRateTimestamp');
      if (
        settlement.symbol !== request.market.marketId
        || fundingTime <= request.startTime
        || fundingTime > request.endTime
      ) {
        continue;
      }
      validateFundingRate(settlement.fundingRate, settlement.symbol);
      const key = `${settlement.symbol}:${fundingTime}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (seen.size > MAX_HISTORY_RECORDS) {
        throw new VenueRequestError(this.id, 'Bybit funding history response exceeded 200 distinct records');
      }
      records.push({
        venue: this.id,
        marketId: settlement.symbol,
        fundingRate: settlement.fundingRate,
        fundingTime
      });
    }
    records.sort((left, right) => left.fundingTime - right.fundingTime);

    return {
      records,
      requestCount: 1,
      pageCount: 1,
      completeFrom: request.startTime
    };
  }

  private async getInstruments(onRequestTelemetry?: VenueRequestTelemetrySink): Promise<{
    instruments: Array<z.infer<typeof bybitInstrumentsEnvelopeSchema>['result']['list'][number]>;
    pageCount: number;
  }> {
    const instruments: Array<z.infer<typeof bybitInstrumentsEnvelopeSchema>['result']['list'][number]> = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    let pageCount = 0;

    while (true) {
      const query: Record<string, string> = { category: 'linear', limit: '1000' };
      if (cursor !== undefined) query.cursor = cursor;
      const page = this.parseEnvelope(
        bybitInstrumentsEnvelopeSchema,
        await this.http.getJson(
          '/v5/market/instruments-info',
          query,
          requestTelemetryContext('current', onRequestTelemetry)
        )
      );
      pageCount += 1;
      instruments.push(...page.list);
      if (page.nextPageCursor === '') break;
      if (seenCursors.has(page.nextPageCursor)) {
        throw new VenueRequestError(this.id, 'Bybit instruments pagination stalled');
      }
      seenCursors.add(page.nextPageCursor);
      cursor = page.nextPageCursor;
    }
    return { instruments, pageCount };
  }

  private parseEnvelope<T>(
    schema: z.ZodType<{ retCode: number; retMsg: string; result: T; time: number }>,
    payload: unknown
  ): T {
    const result = schema.safeParse(payload);
    if (!result.success) {
      throw new VenueRequestError(this.id, 'Bybit response validation failed');
    }
    if (result.data.retCode !== 0) {
      throw new VenueRequestError(
        this.id,
        `Bybit business error ${result.data.retCode}: ${result.data.retMsg}`
      );
    }
    return result.data.result;
  }
}

function resolveIntervalHours(
  instrumentMinutes: number,
  tickerHours: string | undefined,
  symbol: string
): number {
  if (!Number.isInteger(instrumentMinutes) || instrumentMinutes <= 0 || instrumentMinutes % 60 !== 0) {
    throw new VenueRequestError('bybit', `Invalid Bybit funding interval for ${symbol}`);
  }
  const intervalHours = instrumentMinutes / 60;
  if (tickerHours === undefined) return intervalHours;
  const advertisedHours = Number(tickerHours);
  if (!Number.isInteger(advertisedHours) || advertisedHours <= 0) {
    throw new VenueRequestError('bybit', `Invalid Bybit funding interval for ${symbol}`);
  }
  if (advertisedHours !== intervalHours) {
    throw new VenueRequestError('bybit', `Bybit funding interval mismatch for ${symbol}`);
  }
  return advertisedHours;
}

function parseTimestamp(value: string, field: string): number {
  const timestamp = Number(value);
  if (!Number.isSafeInteger(timestamp)) {
    throw new VenueRequestError('bybit', `Invalid Bybit ${field}`);
  }
  return timestamp;
}

function validateFundingRate(value: string, symbol: string): void {
  try {
    const rate = new Decimal(value);
    if (!rate.isFinite()) throw new Error('not finite');
  } catch {
    throw new VenueRequestError('bybit', `Invalid Bybit funding for ${symbol}`);
  }
}

function nonEmpty(value: string, field: string, symbol: string): string {
  if (value.trim() === '') {
    throw new VenueRequestError('bybit', `Invalid Bybit ${field} for ${symbol}`);
  }
  return value;
}

function validateHistoryWindow(startTime: number, endTime: number): void {
  if (!Number.isSafeInteger(startTime) || !Number.isSafeInteger(endTime) || startTime >= endTime) {
    throw new VenueRequestError('bybit', 'Invalid Bybit funding history window');
  }
}
