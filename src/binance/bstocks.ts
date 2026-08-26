import { z } from 'zod';

import type { StockUniverseProvider } from '../domain.js';
import {
  PublicJsonClient,
  type PublicJsonClientOptions,
  VenueRequestError
} from '../exchanges/http.js';

const BSTOCKS_PATH = '/bapi/defi/v1/public/wallet-direct/buw/wallet/market/token/rwa/stock/detail/list/ai';

const bStockSchema = z.object({
  symbol: z.string(),
  ticker: z.string(),
  type: z.literal(3)
});

const bStocksResponseSchema = z.object({
  code: z.string(),
  success: z.boolean(),
  data: z.array(bStockSchema)
});

export interface BinanceBStocksClientOptions {
  baseUrl: URL;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export class BinanceBStocksClient implements StockUniverseProvider {
  private readonly http: PublicJsonClient;

  constructor(options: BinanceBStocksClientOptions) {
    const httpOptions: PublicJsonClientOptions = {
      venue: 'binance',
      baseUrl: options.baseUrl,
      minRequestIntervalMs: 0
    };
    if (options.fetch !== undefined) httpOptions.fetch = options.fetch;
    if (options.timeoutMs !== undefined) httpOptions.timeoutMs = options.timeoutMs;
    if (options.maxRetries !== undefined) httpOptions.maxRetries = options.maxRetries;
    if (options.sleep !== undefined) httpOptions.sleep = options.sleep;
    if (options.random !== undefined) httpOptions.random = options.random;
    this.http = new PublicJsonClient(httpOptions);
  }

  async getStockTickers(): Promise<string[]> {
    const payload = await this.http.getJson(BSTOCKS_PATH, { type: '3' });
    const parsed = bStocksResponseSchema.safeParse(payload);
    if (!parsed.success || !parsed.data.success || parsed.data.code !== '000000') {
      throw new VenueRequestError('binance', 'Binance bStocks response validation failed');
    }

    const tickers: string[] = [];
    const seen = new Set<string>();
    for (const item of parsed.data.data) {
      const ticker = item.ticker.trim().toUpperCase();
      const symbol = item.symbol.trim().toUpperCase();
      if (!/^[A-Z0-9]+$/u.test(ticker) || !/^[A-Z0-9]+$/u.test(symbol)) {
        throw new VenueRequestError('binance', 'Binance bStocks contains an invalid asset identifier');
      }
      if (seen.has(ticker)) {
        throw new VenueRequestError('binance', `Binance bStocks contains duplicate ticker ${ticker}`);
      }
      seen.add(ticker);
      tickers.push(ticker);
    }
    if (tickers.length < 20) {
      throw new VenueRequestError('binance', 'Binance bStocks contains fewer than 20 assets');
    }
    return tickers;
  }
}
