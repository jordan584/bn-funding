import assert from 'node:assert/strict';
import test from 'node:test';

import { VenueRequestError } from '../../src/exchanges/http.js';
import { BybitClient } from '../../src/bybit/client.js';
import { venueMarket } from '../helpers/fixtures.js';
import { jsonResponse, queuedFetch, type SeenRequest } from '../helpers/fetch.js';

const baseUrl = new URL('https://api.bybit.com');
const AS_OF = Date.UTC(2026, 7, 5, 8, 5, 0);
const HOUR = 60 * 60 * 1_000;
const DAY = 24 * HOUR;

const envelope = (result: unknown, retCode = 0) => ({
  retCode,
  retMsg: retCode === 0 ? 'OK' : 'request failed',
  result,
  time: AS_OF
});

const instrument = (
  symbol: string,
  overrides: Partial<Record<
    'baseCoin' | 'contractType' | 'fundingInterval' | 'launchTime' | 'quoteCoin' | 'settleCoin' | 'status',
    string | number
  >> = {}
) => ({
  symbol,
  contractType: 'LinearPerpetual',
  status: 'Trading',
  baseCoin: symbol.replace(/USDT$/, ''),
  quoteCoin: 'USDT',
  settleCoin: 'USDT',
  launchTime: String(AS_OF - DAY),
  fundingInterval: 480,
  ...overrides
});

const ticker = (
  symbol: string,
  overrides: Partial<Record<'fundingIntervalHour' | 'fundingRate' | 'nextFundingTime', string>> = {}
) => ({
  symbol,
  fundingRate: '0.0002',
  nextFundingTime: String(AS_OF + 8 * HOUR),
  fundingIntervalHour: '8',
  ...overrides
});

const history = (
  fundingRateTimestamp: number,
  fundingRate = '0.0001',
  symbol = 'BTCUSDT'
) => ({ symbol, fundingRate, fundingRateTimestamp: String(fundingRateTimestamp) });

test('paginates instruments, keeps Trading USDT linear perpetuals, and joins all tickers', async () => {
  const seen: SeenRequest[] = [];
  const client = new BybitClient({
    baseUrl,
    fetch: queuedFetch([
      jsonResponse(envelope({ list: [instrument('BTCUSDT')], nextPageCursor: 'page-2' })),
      jsonResponse(envelope({ list: [instrument('ETHUSDC', { quoteCoin: 'USDC', settleCoin: 'USDC' })], nextPageCursor: '' })),
      jsonResponse(envelope({ category: 'linear', list: [ticker('BTCUSDT')] }))
    ], seen),
    now: () => AS_OF,
    sleep: async () => {}
  });

  const snapshot = await client.getCurrentSnapshot();

  assert.deepEqual(snapshot.markets, [{
    venue: 'bybit', marketId: 'BTCUSDT', rawBaseAsset: 'BTC', quoteAsset: 'USDT', settleAsset: 'USDT',
    nextFundingRate: '0.0002', intervalHours: 8, nextFundingTime: AS_OF + 8 * HOUR, listedAt: AS_OF - DAY
  }]);
  assert.deepEqual(snapshot.stats, { marketCount: 1, requestCount: 3, pageCount: 2 });
  assert.deepEqual(seen.slice(0, 2).map(({ url }) => url.searchParams.get('cursor')), [null, 'page-2']);
  assert.deepEqual(seen[0]?.url.searchParams.get('limit'), '1000');
  assert.deepEqual(seen[2]?.url.searchParams.get('category'), 'linear');
});

test('rejects a non-zero Bybit business code from an HTTP-success response', async () => {
  const client = new BybitClient({
    baseUrl,
    fetch: queuedFetch([jsonResponse(envelope({ list: [], nextPageCursor: '' }, 10001))], []),
    sleep: async () => {}
  });

  await assert.rejects(client.getCurrentSnapshot(), (error: unknown) => (
    error instanceof VenueRequestError && error.venue === 'bybit' && /business error 10001/.test(error.message)
  ));
});

test('rejects a repeated non-empty instruments cursor', async () => {
  const client = new BybitClient({
    baseUrl,
    fetch: queuedFetch([
      jsonResponse(envelope({ list: [instrument('BTCUSDT')], nextPageCursor: 'again' })),
      jsonResponse(envelope({ list: [], nextPageCursor: 'again' }))
    ], []),
    sleep: async () => {}
  });

  await assert.rejects(client.getCurrentSnapshot(), /Bybit instruments pagination stalled/);
});

test('rejects a current ticker whose advertised interval disagrees with its instrument', async () => {
  const client = new BybitClient({
    baseUrl,
    fetch: queuedFetch([
      jsonResponse(envelope({ list: [instrument('BTCUSDT')], nextPageCursor: '' })),
      jsonResponse(envelope({ category: 'linear', list: [ticker('BTCUSDT', { fundingIntervalHour: '4' })] }))
    ], []),
    sleep: async () => {}
  });

  await assert.rejects(client.getCurrentSnapshot(), /Bybit funding interval mismatch for BTCUSDT/);
});

test('uses the instrument interval when the current ticker omits its interval', async () => {
  const { fundingIntervalHour: _fundingIntervalHour, ...tickerWithoutInterval } = ticker('BTCUSDT');
  const client = new BybitClient({
    baseUrl,
    fetch: queuedFetch([
      jsonResponse(envelope({ list: [instrument('BTCUSDT', { fundingInterval: 60 })], nextPageCursor: '' })),
      jsonResponse(envelope({ category: 'linear', list: [tickerWithoutInterval] }))
    ], []),
    now: () => AS_OF,
    sleep: async () => {}
  });

  const snapshot = await client.getCurrentSnapshot();

  assert.equal(snapshot.markets[0]?.intervalHours, 1);
});

test('fails the complete snapshot when an eligible contract has no current ticker', async () => {
  const client = new BybitClient({
    baseUrl,
    fetch: queuedFetch([
      jsonResponse(envelope({ list: [instrument('BTCUSDT'), instrument('ETHUSDT')], nextPageCursor: '' })),
      jsonResponse(envelope({ category: 'linear', list: [ticker('BTCUSDT')] }))
    ], []),
    now: () => AS_OF,
    sleep: async () => {}
  });

  await assert.rejects(client.getCurrentSnapshot(), /Missing Bybit current funding for ETHUSDT/);
});

test('fails closed for duplicate, non-finite, and stale current funding tickers', async () => {
  const cases: Array<{
    name: string;
    tickers: ReturnType<typeof ticker>[];
    error: RegExp;
  }> = [
    {
      name: 'a duplicate eligible ticker',
      tickers: [ticker('BTCUSDT'), ticker('BTCUSDT', { fundingRate: '0.0003' })],
      error: /Duplicate Bybit current funding for BTCUSDT/
    },
    ...['NaN', 'Infinity', '-Infinity'].map((fundingRate) => ({
      name: `a ${fundingRate} funding rate`,
      tickers: [ticker('BTCUSDT', { fundingRate })],
      error: /Invalid Bybit funding for BTCUSDT/
    })),
    {
      name: 'an unsafe next funding time',
      tickers: [ticker('BTCUSDT', { nextFundingTime: String(Number.MAX_SAFE_INTEGER + 1) })],
      error: /Invalid Bybit nextFundingTime/
    },
    {
      name: 'a next funding time that is not later than observation',
      tickers: [ticker('BTCUSDT', { nextFundingTime: String(AS_OF) })],
      error: /Invalid Bybit nextFundingTime for BTCUSDT/
    }
  ];

  for (const { name, tickers, error } of cases) {
    const client = new BybitClient({
      baseUrl,
      fetch: queuedFetch([
        jsonResponse(envelope({ list: [instrument('BTCUSDT')], nextPageCursor: '' })),
        jsonResponse(envelope({ category: 'linear', list: tickers }))
      ], []),
      now: () => AS_OF,
      sleep: async () => {}
    });

    await assert.rejects(client.getCurrentSnapshot(), error, name);
  }
});

test('rejects a snapshot with no Trading USDT linear perpetuals', async () => {
  const client = new BybitClient({
    baseUrl,
    fetch: queuedFetch([jsonResponse(envelope({ list: [
      instrument('BTCUSDT', { status: 'Settling' }),
      instrument('ETHUSDC', { quoteCoin: 'USDC', settleCoin: 'USDC' })
    ], nextPageCursor: '' }))], []),
    sleep: async () => {}
  });

  await assert.rejects(client.getCurrentSnapshot(), /No eligible Bybit USDT linear perpetuals/);
});

test('filters, deduplicates, and sorts reverse chronological Bybit history ascending', async () => {
  const seen: SeenRequest[] = [];
  const client = new BybitClient({
    baseUrl,
    fetch: queuedFetch([jsonResponse(envelope({ category: 'linear', list: [
      history(200, '0.0002'),
      history(150, '0.00015'),
      history(150, '9'),
      history(100, '0.1'),
      history(201, '0.3'),
      history(175, '0.4', 'ETHUSDT')
    ] }))], seen),
    sleep: async () => {}
  });

  const result = await client.getFundingHistory({
    market: { ...venueMarket('bybit', 'BTC'), marketId: 'BTCUSDT' },
    startTime: 100,
    endTime: 200
  });

  assert.deepEqual(result, {
    records: [
      { venue: 'bybit', marketId: 'BTCUSDT', fundingRate: '0.00015', fundingTime: 150 },
      { venue: 'bybit', marketId: 'BTCUSDT', fundingRate: '0.0002', fundingTime: 200 }
    ],
    requestCount: 1,
    pageCount: 1,
    completeFrom: 100
  });
  assert.deepEqual(Object.fromEntries(seen[0]!.url.searchParams), {
    category: 'linear', symbol: 'BTCUSDT', startTime: '100', endTime: '200', limit: '200'
  });
});

test('uses the documented 200-record history limit for a seven-day hourly market', async () => {
  const seen: SeenRequest[] = [];
  const client = new BybitClient({
    baseUrl,
    fetch: queuedFetch([jsonResponse(envelope({ category: 'linear', list: [] }))], seen),
    sleep: async () => {}
  });

  await client.getFundingHistory({
    market: { ...venueMarket('bybit', 'BTC', '0.0001', 1), marketId: 'BTCUSDT' },
    startTime: AS_OF - 7 * DAY,
    endTime: AS_OF
  });

  assert.deepEqual(Object.fromEntries(seen[0]!.url.searchParams), {
    category: 'linear', symbol: 'BTCUSDT', startTime: String(AS_OF - 7 * DAY), endTime: String(AS_OF), limit: '200'
  });
});

test('rejects more than 200 distinct history records', async () => {
  const client = new BybitClient({
    baseUrl,
    fetch: queuedFetch([jsonResponse(envelope({ category: 'linear', list: Array.from(
      { length: 201 },
      (_, index) => history(index + 1)
    ) }))], []),
    sleep: async () => {}
  });

  await assert.rejects(client.getFundingHistory({
    market: { ...venueMarket('bybit', 'BTC'), marketId: 'BTCUSDT' },
    startTime: 0,
    endTime: 500
  }), /Bybit funding history response exceeded 200 distinct records/);
});
