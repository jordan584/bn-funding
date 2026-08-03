import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BinanceClient,
  BinanceRequestError,
  BinanceTimeoutError
} from '../../src/binance/client.js';
import { jsonResponse, queuedFetch, type SeenRequest } from '../helpers/fetch.js';

const baseUrl = new URL('https://fapi.binance.com');

const fundingRecord = (
  symbol: string,
  fundingTime: number,
  rateType: 'Regular' | 'Special' = 'Regular'
) => ({ symbol, fundingRate: '0.00010000', fundingTime, rateType });

test('gets server time from the public Binance time endpoint', async () => {
  const seenRequests: SeenRequest[] = [];
  const client = new BinanceClient({
    baseUrl,
    fetch: queuedFetch([jsonResponse({ serverTime: 1_785_715_500_000 })], seenRequests)
  });

  assert.equal(await client.getServerTime(), 1_785_715_500_000);
  assert.equal(seenRequests[0]?.url.pathname, '/fapi/v1/time');
  assert.equal(seenRequests[0]?.url.search, '');
  assert.equal(seenRequests[0]?.init?.method, 'GET');
});

test('rejects an invalid numeric server-time payload', async () => {
  const client = new BinanceClient({
    baseUrl,
    fetch: queuedFetch([jsonResponse({ serverTime: 'not-a-number' })], [])
  });

  await assert.rejects(client.getServerTime(), BinanceRequestError);
});

test('gets exchange symbols and rejects an invalid status payload', async () => {
  const seenRequests: SeenRequest[] = [];
  const validPayload = {
    symbols: [
      {
        symbol: 'BTCUSDT',
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
        contractType: 'PERPETUAL',
        status: 'TRADING',
        onboardDate: 1_700_000_000_000
      }
    ]
  };
  const client = new BinanceClient({
    baseUrl,
    fetch: queuedFetch([jsonResponse(validPayload)], seenRequests)
  });

  assert.deepEqual(await client.getExchangeSymbols(), validPayload.symbols);
  assert.equal(seenRequests[0]?.url.pathname, '/fapi/v1/exchangeInfo');
  assert.equal(seenRequests[0]?.url.search, '');

  const invalidClient = new BinanceClient({
    baseUrl,
    fetch: queuedFetch([
      jsonResponse({
        symbols: [{ ...validPayload.symbols[0], status: 200 }]
      })
    ], [])
  });
  await assert.rejects(invalidClient.getExchangeSymbols(), BinanceRequestError);
});

test('gets funding history with omitted rateType defaulted to Regular and explicit Special preserved', async () => {
  const seenRequests: SeenRequest[] = [];
  const client = new BinanceClient({
    baseUrl,
    historyPageLimit: 1000,
    fetch: queuedFetch([
      jsonResponse([
        { symbol: 'BTCUSDT', fundingRate: '0.00010000', fundingTime: 101 },
        fundingRecord('ETHUSDT', 102, 'Special')
      ])
    ], seenRequests)
  });

  const result = await client.getFundingHistory(101, 200);
  assert.deepEqual(result.records, [
    fundingRecord('BTCUSDT', 101),
    fundingRecord('ETHUSDT', 102, 'Special')
  ]);
  assert.equal(result.pageCount, 1);
  assert.equal(seenRequests[0]?.url.pathname, '/fapi/v1/fundingRate');
  assert.deepEqual(Object.fromEntries(seenRequests[0]?.url.searchParams.entries() ?? []), {
    startTime: '101', endTime: '200', limit: '1000'
  });
  assert.equal(seenRequests[0]?.url.searchParams.has('symbol'), false);
});

test('gets premium indexes and funding intervals from their public endpoints', async () => {
  const seenRequests: SeenRequest[] = [];
  const client = new BinanceClient({
    baseUrl,
    fetch: queuedFetch([
      jsonResponse([{ symbol: 'BTCUSDT', lastFundingRate: '0.00010000', nextFundingTime: 200 }]),
      jsonResponse([{ symbol: 'BTCUSDT', fundingIntervalHours: 4 }])
    ], seenRequests)
  });

  assert.deepEqual(await client.getPremiumIndexes(), [
    { symbol: 'BTCUSDT', lastFundingRate: '0.00010000', nextFundingTime: 200 }
  ]);
  assert.deepEqual(await client.getFundingIntervals(), [
    { symbol: 'BTCUSDT', fundingIntervalHours: 4 }
  ]);
  assert.deepEqual(seenRequests.map(({ url }) => [url.pathname, url.search]), [
    ['/fapi/v1/premiumIndex', ''],
    ['/fapi/v1/fundingInfo', '']
  ]);
});

test('honors a numeric Retry-After value for a 429 response', async () => {
  const seenRequests: SeenRequest[] = [];
  const sleeps: number[] = [];
  const client = new BinanceClient({
    baseUrl,
    fetch: queuedFetch([
      jsonResponse({ code: -1003 }, { status: 429, headers: { 'retry-after': '2' } }),
      jsonResponse({ serverTime: 1 })
    ], seenRequests),
    sleep: async (ms) => { sleeps.push(ms); },
    random: () => 0.9
  });

  assert.equal(await client.getServerTime(), 1);
  assert.equal(seenRequests.length, 2);
  assert.deepEqual(sleeps, [2_000]);
});

test('retries a 500 response with exponential backoff and succeeds', async () => {
  const sleeps: number[] = [];
  const client = new BinanceClient({
    baseUrl,
    fetch: queuedFetch([
      jsonResponse({ error: 'temporary' }, { status: 500 }),
      jsonResponse({ serverTime: 2 })
    ], []),
    sleep: async (ms) => { sleeps.push(ms); },
    random: () => 0.5
  });

  assert.equal(await client.getServerTime(), 2);
  assert.deepEqual(sleeps, [625]);
});

test('fails immediately for a 400 response', async () => {
  const seenRequests: SeenRequest[] = [];
  const client = new BinanceClient({
    baseUrl,
    fetch: queuedFetch([jsonResponse({ code: -1100 }, { status: 400 })], seenRequests),
    sleep: async () => { throw new Error('must not sleep'); }
  });

  await assert.rejects(client.getServerTime(), BinanceRequestError);
  assert.equal(seenRequests.length, 1);
});

test('stops after three retryable failures with four total attempts', async () => {
  const seenRequests: SeenRequest[] = [];
  const sleeps: number[] = [];
  const client = new BinanceClient({
    baseUrl,
    fetch: queuedFetch([
      new Error('network one'), new Error('network two'), new Error('network three'), new Error('network four')
    ], seenRequests),
    sleep: async (ms) => { sleeps.push(ms); },
    random: () => 0
  });

  await assert.rejects(client.getServerTime(), BinanceRequestError);
  assert.equal(seenRequests.length, 4);
  assert.deepEqual(sleeps, [500, 1_000, 2_000]);
});

test('caps an oversized maxRetries override at three retries', async () => {
  const seenRequests: SeenRequest[] = [];
  const sleeps: number[] = [];
  const client = new BinanceClient({
    baseUrl,
    maxRetries: 4,
    fetch: queuedFetch([
      new Error('network one'), new Error('network two'), new Error('network three'),
      new Error('network four'), new Error('network five')
    ], seenRequests),
    sleep: async (ms) => { sleeps.push(ms); },
    random: () => 0
  });

  await assert.rejects(client.getServerTime(), BinanceRequestError);
  assert.equal(seenRequests.length, 4);
  assert.deepEqual(sleeps, [500, 1_000, 2_000]);
});

test('retries three Binance timeouts before throwing a typed timeout error', async () => {
  const seenRequests: SeenRequest[] = [];
  const sleeps: number[] = [];
  const client = new BinanceClient({
    baseUrl,
    timeoutMs: 1,
    fetch: async (input, init) => new Promise<Response>((_resolve, reject) => {
      seenRequests.push({
        url: new URL(typeof input === 'string' || input instanceof URL ? input : input.url),
        ...(init === undefined ? {} : { init })
      });
      const keepEventLoopAlive = setTimeout(() => {}, 1_000);
      init?.signal?.addEventListener('abort', () => {
        clearTimeout(keepEventLoopAlive);
        reject(init.signal?.reason);
      }, { once: true });
    }),
    sleep: async (ms) => { sleeps.push(ms); },
    random: () => 0
  });

  await assert.rejects(client.getServerTime(), (error: unknown) => {
    assert.ok(error instanceof BinanceTimeoutError);
    assert.match(error.message, /timed out/);
    return true;
  });
  assert.equal(seenRequests.length, 4);
  assert.deepEqual(sleeps, [500, 1_000, 2_000]);
});

test('bounds a Binance HTTP error response body at 500 characters', async () => {
  const body = 'x'.repeat(600);
  const bodyClient = new BinanceClient({
    baseUrl,
    fetch: queuedFetch([new Response(body, { status: 400 })], [])
  });
  await assert.rejects(bodyClient.getServerTime(), (error: unknown) => {
    assert.ok(error instanceof BinanceRequestError);
    assert.match(error.message, new RegExp(`x{500}`));
    assert.doesNotMatch(error.message, new RegExp(`x{501}`));
    return true;
  });
});

test('paginates funding history inclusively, deduplicates the boundary, and only requests page three after a full page two', async () => {
  const seenRequests: SeenRequest[] = [];
  const client = new BinanceClient({
    baseUrl,
    historyPageLimit: 3,
    fetch: queuedFetch([
      jsonResponse([
        fundingRecord('AAAUSDT', 150),
        fundingRecord('BBBUSDT', 200),
        fundingRecord('CCCUSDT', 200)
      ]),
      jsonResponse([
        fundingRecord('BBBUSDT', 200),
        fundingRecord('CCCUSDT', 200),
        fundingRecord('DDDUSDT', 300)
      ]),
      jsonResponse([])
    ], seenRequests)
  });

  const result = await client.getFundingHistory(101, 400);
  assert.deepEqual(result.records.map((record) => `${record.symbol}:${record.fundingTime}`), [
    'AAAUSDT:150', 'BBBUSDT:200', 'CCCUSDT:200', 'DDDUSDT:300'
  ]);
  assert.equal(result.pageCount, 3);
  assert.deepEqual(seenRequests.map(({ url }) => url.searchParams.get('startTime')), ['101', '200', '300']);
  assert.deepEqual(seenRequests.map(({ url }) => url.searchParams.get('limit')), ['3', '3', '3']);
});

test('rejects a full funding-history page that cannot add a key or advance the cursor', async () => {
  const client = new BinanceClient({
    baseUrl,
    historyPageLimit: 2,
    fetch: queuedFetch([
      jsonResponse([fundingRecord('AAAUSDT', 101), fundingRecord('BBBUSDT', 101)]),
      jsonResponse([fundingRecord('AAAUSDT', 101), fundingRecord('BBBUSDT', 101)])
    ], [])
  });

  await assert.rejects(client.getFundingHistory(101, 400), /Funding history pagination stalled/);
});
