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
  bitgetContractsEnvelopeSchema,
  bitgetCurrentFundingEnvelopeSchema,
  bitgetFundingHistoryEnvelopeSchema
} from './schemas.js';

const HISTORY_PAGE_SIZE = 100;

export interface BitgetClientOptions {
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

export class BitgetClient implements FundingVenueAdapter {
  readonly id = 'bitget' as const;
  private readonly http: PublicJsonClient;
  private readonly now: () => number;
  private readonly stocksOnly: boolean;

  constructor(options: BitgetClientOptions) {
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
      throw new VenueRequestError(this.id, 'Invalid Bitget observation time');
    }

    const contracts = this.parseEnvelope(
      bitgetContractsEnvelopeSchema,
      await this.http.getJson(
        '/api/v2/mix/market/contracts',
        { productType: 'usdt-futures' },
        requestTelemetryContext('current', onRequestTelemetry)
      )
    );
    const eligibleContracts = contracts.filter((contract) => (
      contract.symbolStatus === 'normal'
      && contract.quoteCoin === 'USDT'
      && contract.symbolType === 'perpetual'
      && (!this.stocksOnly || contract.isRwa === 'YES')
    ));
    if (eligibleContracts.length === 0) {
      throw new VenueRequestError(
        this.id,
        this.stocksOnly
          ? 'No eligible Bitget stock USDT perpetuals'
          : 'No eligible Bitget USDT futures contracts'
      );
    }

    const contractBySymbol = new Map<string, typeof eligibleContracts[number]>();
    for (const contract of eligibleContracts) {
      if (contract.symbol.trim() === '' || contractBySymbol.has(contract.symbol)) {
        throw new VenueRequestError(this.id, `Invalid Bitget eligible contract ${contract.symbol}`);
      }
      if (contract.baseCoin.trim() === '') {
        throw new VenueRequestError(this.id, `Invalid Bitget baseCoin for ${contract.symbol}`);
      }
      contractBySymbol.set(contract.symbol, contract);
    }

    const currentFunding = this.parseEnvelope(
      bitgetCurrentFundingEnvelopeSchema,
      await this.http.getJson(
        '/api/v3/market/current-fund-rate',
        { category: 'USDT-FUTURES' },
        requestTelemetryContext('current', onRequestTelemetry)
      )
    );
    const fundingBySymbol = new Map<string, typeof currentFunding[number]>();
    for (const funding of currentFunding) {
      if (!contractBySymbol.has(funding.symbol)) continue;
      if (fundingBySymbol.has(funding.symbol)) {
        throw new VenueRequestError(this.id, `Duplicate Bitget current funding for ${funding.symbol}`);
      }
      fundingBySymbol.set(funding.symbol, funding);
    }

    const markets: VenueFundingSnapshot[] = [];
    for (const contract of eligibleContracts) {
      const funding = fundingBySymbol.get(contract.symbol);
      if (funding === undefined) {
        throw new VenueRequestError(this.id, `Missing Bitget current funding for ${contract.symbol}`);
      }
      validateFundingRate(funding.fundingRate, contract.symbol);
      const nextFundingTime = parseTimestamp(funding.nextUpdate, 'nextUpdate');
      if (nextFundingTime <= observedAt) {
        throw new VenueRequestError(this.id, `Invalid Bitget nextUpdate for ${contract.symbol}`);
      }
      const listedAt = parseOptionalTimestamp(contract.launchTime, contract.symbol, observedAt);
      markets.push({
        venue: this.id,
        marketId: contract.symbol,
        rawBaseAsset: contract.baseCoin,
        quoteAsset: contract.quoteCoin,
        settleAsset: 'USDT',
        nextFundingRate: funding.fundingRate,
        intervalHours: Number(funding.fundingRateInterval),
        nextFundingTime,
        ...(listedAt === undefined ? {} : { listedAt })
      });
    }

    return {
      venue: this.id,
      observedAt,
      markets,
      stats: { marketCount: markets.length, requestCount: 2, pageCount: 0 }
    };
  }

  async getFundingHistory(
    request: VenueHistoryRequest,
    onRequestTelemetry?: VenueRequestTelemetrySink
  ): Promise<VenueHistoryResult> {
    validateHistoryWindow(request.startTime, request.endTime);
    const records: VenueHistoryResult['records'] = [];
    const seen = new Set<string>();
    let pageNo = 1;
    let pageCount = 0;
    let previousOldestFundingTime = Number.POSITIVE_INFINITY;

    while (true) {
      const page = this.parseEnvelope(
        bitgetFundingHistoryEnvelopeSchema,
        await this.http.getJson('/api/v2/mix/market/history-fund-rate', {
          symbol: request.market.marketId,
          productType: 'usdt-futures',
          pageSize: String(HISTORY_PAGE_SIZE),
          pageNo: String(pageNo)
        }, requestTelemetryContext('history', onRequestTelemetry))
      );
      pageCount += 1;
      let oldestFundingTime = Number.POSITIVE_INFINITY;
      for (const settlement of page) {
        if (settlement.symbol !== request.market.marketId) {
          throw new VenueRequestError(this.id, `Unexpected Bitget funding history symbol ${settlement.symbol}`);
        }
        const fundingTime = parseTimestamp(settlement.fundingTime, 'fundingTime');
        validateFundingRate(settlement.fundingRate, settlement.symbol);
        oldestFundingTime = Math.min(oldestFundingTime, fundingTime);
        if (fundingTime <= request.startTime || fundingTime > request.endTime) continue;
        const key = `${settlement.symbol}:${fundingTime}`;
        if (seen.has(key)) continue;
        seen.add(key);
        records.push({
          venue: this.id,
          marketId: settlement.symbol,
          fundingRate: settlement.fundingRate,
          fundingTime
        });
      }

      if (oldestFundingTime <= request.startTime) break;
      if (page.length < HISTORY_PAGE_SIZE) break;
      if (oldestFundingTime >= previousOldestFundingTime) {
        throw new VenueRequestError(this.id, 'Bitget funding history pagination stalled');
      }
      previousOldestFundingTime = oldestFundingTime;
      pageNo += 1;
    }
    records.sort((left, right) => left.fundingTime - right.fundingTime);

    return {
      records,
      requestCount: pageCount,
      pageCount,
      completeFrom: request.startTime
    };
  }

  private parseEnvelope<T>(
    schema: z.ZodType<{ code: string; msg: string; requestTime: string | number; data: T[] }>,
    payload: unknown
  ): T[] {
    const result = schema.safeParse(payload);
    if (!result.success) {
      throw new VenueRequestError(this.id, 'Bitget response validation failed');
    }
    if (result.data.code !== '00000') {
      throw new VenueRequestError(
        this.id,
        `Bitget business error ${result.data.code}: ${result.data.msg}`
      );
    }
    return result.data.data;
  }
}

function parseTimestamp(value: string, field: string): number {
  const timestamp = Number(value);
  if (!Number.isSafeInteger(timestamp)) {
    throw new VenueRequestError('bitget', `Invalid Bitget ${field}`);
  }
  return timestamp;
}

function parseOptionalTimestamp(
  value: string,
  symbol: string,
  observedAt: number
): number | undefined {
  if (value.trim() === '') return undefined;
  const timestamp = Number(value);
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0 || timestamp > observedAt) {
    throw new VenueRequestError('bitget', `Invalid Bitget launchTime for ${symbol}`);
  }
  return timestamp;
}

function validateFundingRate(value: string, symbol: string): void {
  try {
    if (value.trim() === '') throw new Error('blank');
    const rate = new Decimal(value);
    if (!rate.isFinite()) throw new Error('not finite');
  } catch {
    throw new VenueRequestError('bitget', `Invalid Bitget funding for ${symbol}`);
  }
}

function validateHistoryWindow(startTime: number, endTime: number): void {
  if (!Number.isSafeInteger(startTime) || !Number.isSafeInteger(endTime) || startTime >= endTime) {
    throw new VenueRequestError('bitget', 'Invalid Bitget funding history window');
  }
}
