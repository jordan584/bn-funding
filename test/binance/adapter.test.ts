import assert from 'node:assert/strict';
import test from 'node:test';

import { BinanceVenueAdapter } from '../../src/binance/adapter.js';
import { venueMarket } from '../helpers/fixtures.js';
import { jsonResponse, queuedFetch, type SeenRequest } from '../helpers/fetch.js';

const baseUrl = new URL('https://fapi.binance.com');
const AS_OF = Date.UTC(2026, 7, 5, 8, 5, 0);
const HOUR = 60 * 60 * 1_000;
const DAY = 24 * HOUR;

const fundingRecord = (
  symbol: string,
  fundingTime: number,
  rateType: 'Regular' | 'Special' = 'Regular'
) => ({ symbol, fundingRate: '0.00010000', fundingTime, rateType });

test('returns one complete live USDT perpetual snapshot with adjusted intervals', async () => {
  const seenRequests: SeenRequest[] = [];
  const adapter = new BinanceVenueAdapter({
    baseUrl,
    fetch: queuedFetch([
      jsonResponse({ serverTime: AS_OF }),
      jsonResponse({ symbols: [
        { symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', contractType: 'PERPETUAL', status: 'TRADING', onboardDate: AS_OF - DAY },
        { symbol: 'ETHUSDC', baseAsset: 'ETH', quoteAsset: 'USDC', contractType: 'PERPETUAL', status: 'TRADING', onboardDate: AS_OF - DAY }
      ] }),
      jsonResponse([{ symbol: 'BTCUSDT', lastFundingRate: '0.0002', nextFundingTime: AS_OF + 4 * HOUR }]),
      jsonResponse([{ symbol: 'BTCUSDT', fundingIntervalHours: 4 }])
    ], seenRequests)
  });

  const snapshot = await adapter.getCurrentSnapshot();
  assert.equal(snapshot.venue, 'binance');
  assert.equal(snapshot.observedAt, AS_OF);
  assert.deepEqual(snapshot.markets, [{
    venue: 'binance', marketId: 'BTCUSDT', rawBaseAsset: 'BTC', quoteAsset: 'USDT', settleAsset: 'USDT',
    nextFundingRate: '0.0002', intervalHours: 4, nextFundingTime: AS_OF + 4 * HOUR, listedAt: AS_OF - DAY
  }]);
  assert.equal(snapshot.stats.requestCount, 4);
});

test('fails the whole Binance snapshot when an eligible contract lacks current funding', async () => {
  const adapter = new BinanceVenueAdapter({
    baseUrl,
    fetch: queuedFetch([
      jsonResponse({ serverTime: AS_OF }),
      jsonResponse({ symbols: [{ symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', contractType: 'PERPETUAL', status: 'TRADING', onboardDate: 1 }] }),
      jsonResponse([]),
      jsonResponse([])
    ], [])
  });

  await assert.rejects(adapter.getCurrentSnapshot(), /Missing Binance current Funding for BTCUSDT/);
});

test('fetches and deduplicates history only for the selected Binance market', async () => {
  const seenRequests: SeenRequest[] = [];
  const adapter = new BinanceVenueAdapter({
    baseUrl,
    historyPageLimit: 2,
    fetch: queuedFetch([
      jsonResponse([fundingRecord('BTCUSDT', 101), fundingRecord('BTCUSDT', 200)]),
      jsonResponse([fundingRecord('BTCUSDT', 200)])
    ], seenRequests)
  });
  const result = await adapter.getFundingHistory({
    market: { ...venueMarket('binance', 'BTC'), marketId: 'BTCUSDT' },
    startTime: 100,
    endTime: 300
  });

  assert.deepEqual(result.records.map(({ fundingTime }) => fundingTime), [101, 200]);
  assert.equal(result.pageCount, 2);
  assert.deepEqual(seenRequests.map(({ url }) => url.searchParams.get('symbol')), ['BTCUSDT', 'BTCUSDT']);
});

test('excludes Special Binance settlements from common funding history', async () => {
  const adapter = new BinanceVenueAdapter({
    baseUrl,
    fetch: queuedFetch([
      jsonResponse([
        fundingRecord('BTCUSDT', 101),
        fundingRecord('BTCUSDT', 102, 'Special')
      ])
    ], [])
  });

  const result = await adapter.getFundingHistory({
    market: { ...venueMarket('binance', 'BTC'), marketId: 'BTCUSDT' },
    startTime: 100,
    endTime: 300
  });

  assert.deepEqual(result, {
    records: [{ venue: 'binance', marketId: 'BTCUSDT', fundingRate: '0.00010000', fundingTime: 101 }],
    requestCount: 1,
    pageCount: 1,
    completeFrom: 100
  });
});
