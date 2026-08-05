import { Decimal } from 'decimal.js';
import { z } from 'zod';

import type {
  FundingVenueAdapter,
  VenueHistoryRequest,
  VenueHistoryResult,
  VenueSnapshot
} from '../domain.js';
import {
  PublicJsonClient,
  type PublicJsonClientOptions,
  VenueRequestError
} from '../exchanges/http.js';
import {
  hyperFundingHistorySchema,
  hyperMetaAndContextsSchema
} from './schemas.js';

const HOUR_MS = 60 * 60 * 1_000;
const HISTORY_PAGE_SIZE = 500;

export interface HyperliquidClientOptions {
  baseUrl: URL;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  maxRetries?: number;
  minRequestIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
}

export class HyperliquidClient implements FundingVenueAdapter {
  readonly id = 'hyperliquid' as const;
  private readonly http: PublicJsonClient;
  private readonly now: () => number;

  constructor(options: HyperliquidClientOptions) {
    this.now = options.now ?? Date.now;
    const httpOptions: PublicJsonClientOptions = {
      venue: this.id,
      baseUrl: options.baseUrl,
      minRequestIntervalMs: options.minRequestIntervalMs ?? 0,
      now: this.now
    };
    if (options.fetch !== undefined) httpOptions.fetch = options.fetch;
    if (options.timeoutMs !== undefined) httpOptions.timeoutMs = options.timeoutMs;
    if (options.maxRetries !== undefined) httpOptions.maxRetries = options.maxRetries;
    if (options.sleep !== undefined) httpOptions.sleep = options.sleep;
    if (options.random !== undefined) httpOptions.random = options.random;
    this.http = new PublicJsonClient(httpOptions);
  }

  async getCurrentSnapshot(): Promise<VenueSnapshot> {
    const observedAt = this.now();
    if (!Number.isSafeInteger(observedAt)) {
      throw new VenueRequestError(this.id, 'Invalid Hyperliquid observation time');
    }
    const [metadata, contexts] = this.parse(
      hyperMetaAndContextsSchema,
      await this.http.postJson('/info', { type: 'metaAndAssetCtxs' }),
      'Hyperliquid response validation failed'
    );
    if (metadata.universe.length !== contexts.length) {
      throw new VenueRequestError(this.id, 'Hyperliquid metadata and context lengths differ');
    }

    const seenAssets = new Set<string>();
    const markets: VenueSnapshot['markets'] = [];
    for (let index = 0; index < metadata.universe.length; index += 1) {
      const asset = metadata.universe[index]!;
      const context = contexts[index]!;
      if (asset.name.trim() === '') {
        throw new VenueRequestError(this.id, 'Invalid Hyperliquid asset name');
      }
      if (seenAssets.has(asset.name)) {
        throw new VenueRequestError(this.id, `Duplicate Hyperliquid asset ${asset.name}`);
      }
      seenAssets.add(asset.name);
      if (asset.isDelisted) continue;
      validateFundingRate(context.funding, asset.name);
      markets.push({
        venue: this.id,
        marketId: asset.name,
        rawBaseAsset: asset.name,
        quoteAsset: 'USD',
        settleAsset: 'USDC',
        nextFundingRate: context.funding,
        intervalHours: 1,
        nextFundingTime: Math.floor(observedAt / HOUR_MS) * HOUR_MS + HOUR_MS
      });
    }
    if (markets.length === 0) {
      throw new VenueRequestError(this.id, 'No active Hyperliquid markets');
    }

    return {
      venue: this.id,
      observedAt,
      markets,
      stats: { marketCount: markets.length, requestCount: 1, pageCount: 0 }
    };
  }

  async getFundingHistory(request: VenueHistoryRequest): Promise<VenueHistoryResult> {
    validateHistoryWindow(request.startTime, request.endTime);
    const records: VenueHistoryResult['records'] = [];
    const seen = new Set<number>();
    let startTime = request.startTime;
    let pageCount = 0;

    while (true) {
      const page = this.parse(
        hyperFundingHistorySchema,
        await this.http.postJson('/info', {
          type: 'fundingHistory',
          coin: request.market.marketId,
          startTime,
          endTime: request.endTime
        }),
        'Hyperliquid funding history validation failed'
      );
      pageCount += 1;
      if (page.length > HISTORY_PAGE_SIZE) {
        throw new VenueRequestError(this.id, 'Hyperliquid funding history response exceeded 500 records');
      }
      if (page.length === 0) break;

      let addedRecord = false;
      let latestTime = startTime;
      for (const settlement of page) {
        if (settlement.coin !== request.market.marketId) {
          throw new VenueRequestError(this.id, `Unexpected Hyperliquid funding history asset ${settlement.coin}`);
        }
        if (!Number.isSafeInteger(settlement.time)) {
          throw new VenueRequestError(this.id, 'Invalid Hyperliquid funding history time');
        }
        if (settlement.time < request.startTime || settlement.time > request.endTime) {
          throw new VenueRequestError(this.id, 'Hyperliquid funding history record outside requested window');
        }
        validateFundingRate(settlement.fundingRate, settlement.coin);
        latestTime = Math.max(latestTime, settlement.time);
        if (seen.has(settlement.time)) continue;
        seen.add(settlement.time);
        addedRecord = true;
        records.push({
          venue: this.id,
          marketId: settlement.coin,
          fundingRate: settlement.fundingRate,
          fundingTime: settlement.time
        });
      }

      if (page.length < HISTORY_PAGE_SIZE) break;
      if (!addedRecord || latestTime <= startTime) {
        throw new VenueRequestError(this.id, 'Funding history pagination stalled');
      }
      startTime = latestTime;
    }

    return {
      records,
      requestCount: pageCount,
      pageCount,
      completeFrom: request.startTime
    };
  }

  private parse<T>(schema: z.ZodType<T>, payload: unknown, message: string): T {
    const result = schema.safeParse(payload);
    if (!result.success) {
      throw new VenueRequestError(this.id, message);
    }
    return result.data;
  }
}

function validateFundingRate(value: string, marketId: string): void {
  try {
    const rate = new Decimal(value);
    if (!rate.isFinite()) throw new Error('not finite');
  } catch {
    throw new VenueRequestError('hyperliquid', `Invalid Hyperliquid funding for ${marketId}`);
  }
}

function validateHistoryWindow(startTime: number, endTime: number): void {
  if (!Number.isSafeInteger(startTime) || !Number.isSafeInteger(endTime) || startTime >= endTime) {
    throw new VenueRequestError('hyperliquid', 'Invalid Hyperliquid funding history window');
  }
}
