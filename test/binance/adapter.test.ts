import assert from 'node:assert/strict';
import test from 'node:test';

import { BinanceVenueAdapter } from '../../src/binance/adapter.js';
import { BinanceRequestError } from '../../src/binance/client.js';
import { buildCompositeFundingLeaderboard } from '../../src/funding/composite.js';
import { venueMarket, venueSnapshot } from '../helpers/fixtures.js';
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

test('defaults an eligible Binance market without an interval override to eight hours', async () => {
  const adapter = new BinanceVenueAdapter({
    baseUrl,
    fetch: queuedFetch([
      jsonResponse({ serverTime: AS_OF }),
      jsonResponse({ symbols: [{
        symbol: 'ETHUSDT', baseAsset: 'ETH', quoteAsset: 'USDT', contractType: 'PERPETUAL', status: 'TRADING', onboardDate: AS_OF - DAY
      }] }),
      jsonResponse([{ symbol: 'ETHUSDT', lastFundingRate: '0.0001', nextFundingTime: AS_OF + 8 * HOUR }]),
      jsonResponse([])
    ], [])
  });

  const snapshot = await adapter.getCurrentSnapshot();

  assert.equal(snapshot.markets[0]?.intervalHours, 8);
});

test('stock mode keeps TradFi perpetuals and excludes same-ticker crypto perpetuals', async () => {
  const adapter = new BinanceVenueAdapter({
    baseUrl,
    stocksOnly: true,
    fetch: queuedFetch([
      jsonResponse({ serverTime: AS_OF }),
      jsonResponse({ symbols: [
        { symbol: 'NVDAUSDT', baseAsset: 'NVDA', quoteAsset: 'USDT', contractType: 'TRADIFI_PERPETUAL', status: 'TRADING', onboardDate: AS_OF - DAY },
        { symbol: 'QNTUSDT', baseAsset: 'QNT', quoteAsset: 'USDT', contractType: 'PERPETUAL', status: 'TRADING', onboardDate: AS_OF - DAY }
      ] }),
      jsonResponse([{ symbol: 'NVDAUSDT', lastFundingRate: '0.0001', nextFundingTime: AS_OF + 8 * HOUR }]),
      jsonResponse([])
    ], [])
  });

  const snapshot = await adapter.getCurrentSnapshot();

  assert.deepEqual(snapshot.markets.map(({ marketId }) => marketId), ['NVDAUSDT']);
});

test('carries Unicode letter assets from the Binance adapter through deterministic composite ranking', async () => {
  const unicodeAssets = ['币安人生', '币安日记', 'Ａ', '𐐀'];
  const sharedAssets = [
    ...Array.from({ length: 16 }, (_, index) => `ASSET${String(index + 1).padStart(2, '0')}`),
    ...unicodeAssets
  ];
  const symbols = sharedAssets.map((baseAsset) => ({
    symbol: `${baseAsset}USDT`,
    baseAsset,
    quoteAsset: 'USDT',
    contractType: 'PERPETUAL',
    status: 'TRADING',
    onboardDate: AS_OF - DAY
  }));
  const adapter = new BinanceVenueAdapter({
    baseUrl,
    fetch: queuedFetch([
      jsonResponse({ serverTime: AS_OF }),
      jsonResponse({ symbols }),
      jsonResponse(symbols.map(({ symbol }) => ({
        symbol,
        lastFundingRate: '0.0001',
        nextFundingTime: AS_OF + 8 * HOUR
      }))),
      jsonResponse([])
    ], [])
  });

  const binance = await adapter.getCurrentSnapshot();
  const leaderboard = buildCompositeFundingLeaderboard({
    asOf: AS_OF,
    snapshots: [
      binance,
      venueSnapshot('okx', sharedAssets.map((asset) => venueMarket('okx', asset))),
      venueSnapshot('hyperliquid', [venueMarket('hyperliquid', 'ONLYHYPER')]),
      venueSnapshot('bybit', [venueMarket('bybit', 'ONLYBYBIT')]),
      venueSnapshot('bitget', [venueMarket('bitget', 'ONLYBITGET')])
    ]
  });

  assert.equal(binance.markets.find(({ marketId }) => marketId === '币安人生USDT')?.rawBaseAsset, '币安人生');
  assert.deepEqual(
    leaderboard.rows.filter(({ asset }) => unicodeAssets.includes(asset)).map(({ asset }) => asset),
    unicodeAssets
  );
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

test('fails closed with a typed request error when Binance has no eligible market', async () => {
  const adapter = new BinanceVenueAdapter({
    baseUrl,
    fetch: queuedFetch([
      jsonResponse({ serverTime: AS_OF }),
      jsonResponse({ symbols: [] }),
      jsonResponse([]),
      jsonResponse([])
    ], [])
  });

  await assert.rejects(adapter.getCurrentSnapshot(), (error: unknown) => (
    error instanceof BinanceRequestError
    && /No eligible Binance USDT perpetuals/.test(error.message)
  ));
});

for (const [kind, premiumRows, intervalRows] of [
  [
    'premium',
    [
      { symbol: 'BTCUSDT', lastFundingRate: '0.0001', nextFundingTime: AS_OF + 8 * HOUR },
      { symbol: 'BTCUSDT', lastFundingRate: '0.0002', nextFundingTime: AS_OF + 8 * HOUR }
    ],
    []
  ],
  [
    'interval',
    [{ symbol: 'BTCUSDT', lastFundingRate: '0.0001', nextFundingTime: AS_OF + 8 * HOUR }],
    [
      { symbol: 'BTCUSDT', fundingIntervalHours: 8 },
      { symbol: 'BTCUSDT', fundingIntervalHours: 4 }
    ]
  ]
] as const) {
  test(`rejects duplicate eligible Binance ${kind} rows instead of accepting the last row`, async () => {
    const adapter = new BinanceVenueAdapter({
      baseUrl,
      fetch: queuedFetch([
        jsonResponse({ serverTime: AS_OF }),
        jsonResponse({ symbols: [{
          symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', contractType: 'PERPETUAL',
          status: 'TRADING', onboardDate: AS_OF - DAY
        }] }),
        jsonResponse(premiumRows),
        jsonResponse(intervalRows)
      ], [])
    });

    await assert.rejects(adapter.getCurrentSnapshot(), (error: unknown) => (
      error instanceof BinanceRequestError
      && new RegExp(`Duplicate Binance ${kind} for BTCUSDT`).test(error.message)
    ));
  });
}

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
