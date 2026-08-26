import { z } from 'zod';

import type {
  FundingVenueAdapter,
  VenueFundingSnapshot,
  VenueHistoryRequest,
  VenueHistoryResult,
  VenueRequestTelemetrySink,
  VenueSnapshot
} from '../domain.js';
import { mapWithConcurrency } from '../exchanges/concurrency.js';
import {
  PublicJsonClient,
  type PublicJsonClientOptions,
  requestTelemetryContext,
  VenueRequestError
} from '../exchanges/http.js';
import {
  okxCurrentFundingEnvelopeSchema,
  okxHistoryEnvelopeSchema,
  okxInstrumentsEnvelopeSchema
} from './schemas.js';

const HOUR_MS = 60 * 60 * 1_000;
const DEFAULT_CURRENT_CONCURRENCY = 4;
const DEFAULT_HISTORY_PAGE_LIMIT = 100;
const MAX_HISTORY_PAGE_LIMIT = 400;

export interface OkxClientOptions {
  baseUrl: URL;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  maxRetries?: number;
  minRequestIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
  currentConcurrency?: number;
  historyPageLimit?: number;
  stocksOnly?: boolean;
}

export class OkxClient implements FundingVenueAdapter {
  readonly id = 'okx' as const;
  private readonly http: PublicJsonClient;
  private readonly now: () => number;
  private readonly currentConcurrency: number;
  private readonly historyPageLimit: number;
  private readonly stocksOnly: boolean;

  constructor(options: OkxClientOptions) {
    this.now = options.now ?? Date.now;
    this.currentConcurrency = options.currentConcurrency ?? DEFAULT_CURRENT_CONCURRENCY;
    this.historyPageLimit = normalizeHistoryPageLimit(options.historyPageLimit);
    this.stocksOnly = options.stocksOnly ?? false;

    const httpOptions: PublicJsonClientOptions = {
      venue: this.id,
      baseUrl: options.baseUrl,
      minRequestIntervalMs: options.minRequestIntervalMs ?? 110,
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
    const telemetry = requestTelemetryContext('current', onRequestTelemetry);
    const instruments = this.parseEnvelope(
      okxInstrumentsEnvelopeSchema,
      await this.http.getJson('/api/v5/public/instruments', { instType: 'SWAP' }, telemetry)
    );
    const eligibleInstruments = instruments.filter((instrument) => (
      instrument.instType === 'SWAP'
      && instrument.state === 'live'
      && instrument.settleCcy === 'USDT'
      && instrument.ctType === 'linear'
      && (!this.stocksOnly || instrument.instCategory === '3')
    ));
    if (eligibleInstruments.length === 0) {
      throw new VenueRequestError(
        this.id,
        this.stocksOnly
          ? 'No eligible OKX stock USDT linear swaps'
          : 'No eligible OKX USDT linear swaps'
      );
    }
    const seenInstrumentIds = new Set<string>();
    const assetsByInstrumentId = new Map<string, { rawBaseAsset: string; quoteAsset: string }>();
    for (const instrument of eligibleInstruments) {
      if (seenInstrumentIds.has(instrument.instId)) {
        throw new VenueRequestError(this.id, `Invalid OKX eligible instrument ${instrument.instId}`);
      }
      seenInstrumentIds.add(instrument.instId);
      assetsByInstrumentId.set(instrument.instId, deriveMarketAssets(instrument.instId, instrument.instFamily));
    }

    const markets = await mapWithConcurrency(
      eligibleInstruments,
      this.currentConcurrency,
      async (instrument): Promise<VenueFundingSnapshot> => {
        const funding = this.parseEnvelope(
          okxCurrentFundingEnvelopeSchema,
          await this.http.getJson('/api/v5/public/funding-rate', { instId: instrument.instId }, telemetry)
        );
        const matchingFunding = funding.filter(({ instId }) => instId === instrument.instId);
        if (matchingFunding.length !== 1) {
          throw new VenueRequestError(this.id, `Missing OKX current funding for ${instrument.instId}`);
        }
        const current = matchingFunding[0]!;
        if (current.fundingRate === '') {
          throw new VenueRequestError(this.id, `Invalid OKX current funding for ${instrument.instId}`);
        }
        const fundingTime = parseTimestamp(current.fundingTime, 'fundingTime');
        const nextFundingTime = parseTimestamp(current.nextFundingTime, 'nextFundingTime');
        const intervalHours = (nextFundingTime - fundingTime) / HOUR_MS;
        if (!Number.isInteger(intervalHours) || intervalHours <= 0) {
          throw new VenueRequestError(this.id, `Invalid OKX funding interval for ${instrument.instId}`);
        }
        const assets = assetsByInstrumentId.get(instrument.instId)!;

        return {
          venue: this.id,
          marketId: instrument.instId,
          rawBaseAsset: assets.rawBaseAsset,
          quoteAsset: assets.quoteAsset,
          settleAsset: instrument.settleCcy,
          nextFundingRate: current.fundingRate,
          intervalHours,
          nextFundingTime: fundingTime,
          listedAt: parseTimestamp(instrument.listTime, 'listTime')
        };
      }
    );

    return {
      venue: this.id,
      observedAt: this.now(),
      markets,
      stats: { marketCount: markets.length, requestCount: markets.length + 1, pageCount: 0 }
    };
  }

  async getFundingHistory(
    request: VenueHistoryRequest,
    onRequestTelemetry?: VenueRequestTelemetrySink
  ): Promise<VenueHistoryResult> {
    const telemetry = requestTelemetryContext('history', onRequestTelemetry);
    validateHistoryWindow(request.startTime, request.endTime);
    const records: VenueHistoryResult['records'] = [];
    const seen = new Set<string>();
    let after = request.endTime + 1;
    let pageCount = 0;

    while (true) {
      const page = this.parseEnvelope(
        okxHistoryEnvelopeSchema,
        await this.http.getJson('/api/v5/public/funding-rate-history', {
          instId: request.market.marketId,
          before: String(request.startTime),
          after: String(after),
          limit: String(this.historyPageLimit)
        }, telemetry)
      );
      pageCount += 1;
      if (page.length === 0) break;

      let oldestFundingTime = Number.POSITIVE_INFINITY;
      for (const settlement of page) {
        const fundingTime = parseTimestamp(settlement.fundingTime, 'fundingTime');
        oldestFundingTime = Math.min(oldestFundingTime, fundingTime);
        if (settlement.instId !== request.market.marketId) continue;
        if (fundingTime <= request.startTime || fundingTime > request.endTime) continue;
        const key = `${settlement.instId}:${fundingTime}`;
        if (seen.has(key)) continue;
        seen.add(key);
        records.push({
          venue: this.id,
          marketId: settlement.instId,
          fundingRate: settlement.realizedRate,
          fundingTime
        });
      }

      if (oldestFundingTime <= request.startTime || page.length < this.historyPageLimit) break;
      if (oldestFundingTime >= after) {
        throw new VenueRequestError(this.id, 'Funding history pagination stalled');
      }
      after = oldestFundingTime;
    }

    return {
      records,
      requestCount: pageCount,
      pageCount,
      completeFrom: request.startTime
    };
  }

  private parseEnvelope<T>(
    schema: z.ZodType<{ code: string; msg: string; data: T[] }>,
    payload: unknown
  ): T[] {
    const result = schema.safeParse(payload);
    if (!result.success) {
      throw new VenueRequestError(this.id, 'OKX response validation failed');
    }
    if (result.data.code !== '0') {
      throw new VenueRequestError(this.id, `OKX business error ${result.data.code}: ${result.data.msg}`);
    }
    return result.data.data;
  }
}

function deriveMarketAssets(
  instId: string,
  instFamily: string
): { rawBaseAsset: string; quoteAsset: string } {
  const instrumentMatch = /^([A-Z0-9]+)-(USDT)-SWAP$/.exec(instId);
  const familyMatch = /^([A-Z0-9]+)-(USDT)$/.exec(instFamily);
  if (
    instrumentMatch === null
    || familyMatch === null
    || instrumentMatch[1] !== familyMatch[1]
    || instrumentMatch[2] !== familyMatch[2]
  ) {
    throw new VenueRequestError('okx', `Invalid OKX eligible instrument ${instId}`);
  }
  return { rawBaseAsset: instrumentMatch[1]!, quoteAsset: instrumentMatch[2]! };
}

function parseTimestamp(value: string, field: string): number {
  const timestamp = Number(value);
  if (!Number.isSafeInteger(timestamp)) {
    throw new VenueRequestError('okx', `Invalid OKX ${field}`);
  }
  return timestamp;
}

function normalizeHistoryPageLimit(value: number | undefined): number {
  const requested = value ?? DEFAULT_HISTORY_PAGE_LIMIT;
  if (!Number.isInteger(requested) || requested < 1) {
    return DEFAULT_HISTORY_PAGE_LIMIT;
  }
  return Math.min(requested, MAX_HISTORY_PAGE_LIMIT);
}

function validateHistoryWindow(startTime: number, endTime: number): void {
  if (!Number.isSafeInteger(startTime) || !Number.isSafeInteger(endTime) || startTime >= endTime) {
    throw new VenueRequestError('okx', 'Invalid OKX funding history window');
  }
}
