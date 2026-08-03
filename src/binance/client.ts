import type {
  ExchangeSymbol,
  FundingHistoryRecord,
  FundingIntervalInfo,
  PremiumIndexRecord
} from '../domain.js';
import {
  exchangeInfoResponseSchema,
  fundingHistoryResponseSchema,
  fundingInfoResponseSchema,
  premiumIndexResponseSchema,
  serverTimeResponseSchema
} from './schemas.js';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_HISTORY_PAGE_LIMIT = 1000;
const MAX_ERROR_BODY_LENGTH = 500;

export interface BinanceClientOptions {
  baseUrl: URL;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  maxRetries?: number;
  historyPageLimit?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export class BinanceRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BinanceRequestError';
  }
}

export class BinanceClient {
  private readonly baseUrl: URL;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly historyPageLimit: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  constructor(options: BinanceClientOptions) {
    this.baseUrl = options.baseUrl;
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.historyPageLimit = options.historyPageLimit ?? DEFAULT_HISTORY_PAGE_LIMIT;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = options.random ?? Math.random;
  }

  async getServerTime(): Promise<number> {
    const payload = await this.getJson('/fapi/v1/time');
    return this.parse(serverTimeResponseSchema, payload).serverTime;
  }

  async getExchangeSymbols(): Promise<ExchangeSymbol[]> {
    const payload = await this.getJson('/fapi/v1/exchangeInfo');
    return this.parse(exchangeInfoResponseSchema, payload).symbols;
  }

  async getFundingHistory(
    startTime: number,
    endTime: number
  ): Promise<{ records: FundingHistoryRecord[]; pageCount: number }> {
    const records: FundingHistoryRecord[] = [];
    const seen = new Set<string>();
    let cursor = startTime;
    let pageCount = 0;

    while (true) {
      const payload = await this.getJson('/fapi/v1/fundingRate', {
        startTime: String(cursor),
        endTime: String(endTime),
        limit: String(this.historyPageLimit)
      });
      const page = this.parse(fundingHistoryResponseSchema, payload);
      pageCount += 1;

      if (page.length === 0 || page.length < this.historyPageLimit) {
        for (const record of page) {
          const key = `${record.symbol}:${record.fundingTime}:${record.rateType}`;
          if (!seen.has(key)) {
            seen.add(key);
            records.push(record);
          }
        }
        return { records, pageCount };
      }

      let addedNewRecord = false;
      let maxFundingTime = cursor;
      for (const record of page) {
        const key = `${record.symbol}:${record.fundingTime}:${record.rateType}`;
        if (!seen.has(key)) {
          seen.add(key);
          records.push(record);
          addedNewRecord = true;
        }
        maxFundingTime = Math.max(maxFundingTime, record.fundingTime);
      }

      if (!addedNewRecord && maxFundingTime <= cursor) {
        throw new BinanceRequestError('Funding history pagination stalled');
      }
      cursor = maxFundingTime;
    }
  }

  async getPremiumIndexes(): Promise<PremiumIndexRecord[]> {
    const payload = await this.getJson('/fapi/v1/premiumIndex');
    return this.parse(premiumIndexResponseSchema, payload);
  }

  async getFundingIntervals(): Promise<FundingIntervalInfo[]> {
    const payload = await this.getJson('/fapi/v1/fundingInfo');
    return this.parse(fundingInfoResponseSchema, payload);
  }

  private parse<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, payload: unknown): T {
    const result = schema.safeParse(payload);
    if (!result.success) {
      throw new BinanceRequestError('Binance response validation failed');
    }
    return result.data;
  }

  private async getJson(path: string, query: Record<string, string> = {}): Promise<unknown> {
    const url = new URL(path, this.baseUrl);
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }

    for (let retryIndex = 0; ; retryIndex += 1) {
      const signal = AbortSignal.timeout(this.timeoutMs);
      try {
        const response = await this.fetcher(url, { method: 'GET', signal });
        if (response.ok) {
          try {
            return await response.json();
          } catch {
            throw new BinanceRequestError('Binance response was not valid JSON');
          }
        }

        const retryable = response.status === 429 || response.status >= 500;
        if (!retryable || retryIndex >= this.maxRetries) {
          throw new BinanceRequestError(await this.responseErrorMessage(path, response));
        }
        await this.sleep(this.retryDelayMs(response, retryIndex));
      } catch (error) {
        if (error instanceof BinanceRequestError) {
          throw error;
        }
        if (signal.aborted) {
          throw new BinanceRequestError(`Binance request timed out: GET ${path}`);
        }
        if (retryIndex >= this.maxRetries) {
          throw new BinanceRequestError(`Binance network request failed: GET ${path}`);
        }
        await this.sleep(this.retryDelayMs(undefined, retryIndex));
      }
    }
  }

  private retryDelayMs(response: Response | undefined, retryIndex: number): number {
    const retryAfter = response?.headers.get('retry-after');
    if (retryAfter !== null && retryAfter !== undefined && retryAfter.trim() !== '') {
      const retryAfterSeconds = Number(retryAfter);
      if (Number.isFinite(retryAfterSeconds)) {
        return retryAfterSeconds * 1000;
      }
    }
    return Math.min(500 * 2 ** retryIndex + this.random() * 250, 10_000);
  }

  private async responseErrorMessage(path: string, response: Response): Promise<string> {
    let body = '';
    try {
      body = (await response.text()).slice(0, MAX_ERROR_BODY_LENGTH);
    } catch {
      // The status is still enough to classify the request failure.
    }
    const bodySuffix = body === '' ? '' : `: ${body}`;
    return `Binance request failed: GET ${path} returned ${response.status}${bodySuffix}`;
  }
}
