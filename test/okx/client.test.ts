import assert from 'node:assert/strict';
import test from 'node:test';

import { VenueRequestError } from '../../src/exchanges/http.js';
import { OkxClient } from '../../src/okx/client.js';
import { venueMarket } from '../helpers/fixtures.js';
import { jsonResponse, queuedFetch, type SeenRequest } from '../helpers/fetch.js';

const baseUrl = new URL('https://www.okx.com');
const AS_OF = Date.UTC(2026, 7, 5, 8, 5, 0);
const HOUR = 60 * 60 * 1_000;
const DAY = 24 * HOUR;

const envelope = (data: unknown, code = '0') => ({ code, msg: code === '0' ? '' : 'request failed', data });
const history = (fundingTime: number, realizedRate = '0.0001', instId = 'BTC-USDT-SWAP') => ({
  instId,
  realizedRate,
  fundingTime: String(fundingTime)
});
const swap = (
  instId: string,
  overrides: Partial<Record<'baseCcy' | 'ctType' | 'instCategory' | 'instFamily' | 'instType' | 'listTime' | 'quoteCcy' | 'settleCcy' | 'state', string>> = {}
) => {
  const match = /^([A-Z0-9]+)-([A-Z0-9]+)-SWAP$/.exec(instId);
  if (match === null) throw new Error(`Invalid test instrument ${instId}`);
  return {
    instId,
    instType: 'SWAP',
    baseCcy: '',
    quoteCcy: '',
    settleCcy: 'USDT',
    ctType: 'linear',
    state: 'live',
    listTime: String(AS_OF - DAY),
    instFamily: `${match[1]}-${match[2]}`,
    ...overrides
  };
};

test('keeps protocol-shaped live linear USDT swaps and derives the actual current funding interval', async () => {
  const client = new OkxClient({
    baseUrl,
    fetch: queuedFetch([
      jsonResponse(envelope([
        swap('BTC-USDT-SWAP'),
        swap('ETH-USDC-SWAP', { settleCcy: 'USDC' }),
        swap('DOGE-USDT-SWAP', { ctType: 'inverse' })
      ])),
      jsonResponse(envelope([{
        instId: 'BTC-USDT-SWAP', fundingRate: '0.0003', fundingTime: String(AS_OF + 2 * HOUR), nextFundingTime: String(AS_OF + 6 * HOUR)
      }]))
    ], []),
    now: () => AS_OF,
    sleep: async () => {}
  });

  const snapshot = await client.getCurrentSnapshot();

  assert.equal(snapshot.venue, 'okx');
  assert.equal(snapshot.observedAt, AS_OF);
  assert.deepEqual(snapshot.markets, [{
    venue: 'okx', marketId: 'BTC-USDT-SWAP', rawBaseAsset: 'BTC', quoteAsset: 'USDT', settleAsset: 'USDT',
    nextFundingRate: '0.0003', intervalHours: 4, nextFundingTime: AS_OF + 2 * HOUR, listedAt: AS_OF - DAY
  }]);
  assert.deepEqual(snapshot.stats, { marketCount: 1, requestCount: 2, pageCount: 0 });
});

test('stock mode keeps only OKX instCategory 3 swaps', async () => {
  const client = new OkxClient({
    baseUrl,
    stocksOnly: true,
    fetch: queuedFetch([
      jsonResponse(envelope([
        swap('NVDA-USDT-SWAP', { instCategory: '3' }),
        swap('BTC-USDT-SWAP', { instCategory: '1' })
      ])),
      jsonResponse(envelope([{
        instId: 'NVDA-USDT-SWAP', fundingRate: '0.0003', fundingTime: String(AS_OF + 2 * HOUR), nextFundingTime: String(AS_OF + 6 * HOUR)
      }]))
    ], []),
    now: () => AS_OF,
    sleep: async () => {}
  });

  const snapshot = await client.getCurrentSnapshot();

  assert.deepEqual(snapshot.markets.map(({ marketId }) => marketId), ['NVDA-USDT-SWAP']);
});

test('rejects a non-zero OKX business code from an HTTP-success response', async () => {
  const client = new OkxClient({
    baseUrl,
    fetch: queuedFetch([jsonResponse(envelope([], '51000'))], []),
    sleep: async () => {}
  });

  await assert.rejects(client.getCurrentSnapshot(), (error: unknown) => (
    error instanceof VenueRequestError && error.venue === 'okx' && /business error 51000/.test(error.message)
  ));
});

test('fails the complete snapshot when a live eligible swap has no current funding', async () => {
  const client = new OkxClient({
    baseUrl,
    fetch: queuedFetch([
      jsonResponse(envelope([swap('BTC-USDT-SWAP')])),
      jsonResponse(envelope([]))
    ], []),
    sleep: async () => {}
  });

  await assert.rejects(client.getCurrentSnapshot(), /Missing OKX current funding for BTC-USDT-SWAP/);
});

test('fails the complete snapshot when no live USDT linear swaps are eligible', async () => {
  const client = new OkxClient({
    baseUrl,
    fetch: queuedFetch([jsonResponse(envelope([
      swap('BTC-USDC-SWAP', { settleCcy: 'USDC' }),
      swap('DOGE-USDT-SWAP', { ctType: 'inverse' })
    ]))], []),
    sleep: async () => {}
  });

  await assert.rejects(client.getCurrentSnapshot(), /No eligible OKX USDT linear swaps/);
});

test('fails the complete snapshot when current funding repeats an eligible instrument', async () => {
  const client = new OkxClient({
    baseUrl,
    fetch: queuedFetch([
      jsonResponse(envelope([swap('BTC-USDT-SWAP')])),
      jsonResponse(envelope([
        { instId: 'BTC-USDT-SWAP', fundingRate: '0.0003', fundingTime: String(AS_OF + 2 * HOUR), nextFundingTime: String(AS_OF + 6 * HOUR) },
        { instId: 'BTC-USDT-SWAP', fundingRate: '0.0004', fundingTime: String(AS_OF + 2 * HOUR), nextFundingTime: String(AS_OF + 6 * HOUR) }
      ]))
    ], []),
    sleep: async () => {}
  });

  await assert.rejects(client.getCurrentSnapshot(), /Missing OKX current funding for BTC-USDT-SWAP/);
});

test('fails the complete snapshot for zero and fractional funding intervals', async () => {
  for (const nextFundingTime of [AS_OF, AS_OF + 90 * 60 * 1_000]) {
    const client = new OkxClient({
      baseUrl,
      fetch: queuedFetch([
        jsonResponse(envelope([swap('BTC-USDT-SWAP')])),
        jsonResponse(envelope([{
          instId: 'BTC-USDT-SWAP', fundingRate: '0.0003', fundingTime: String(AS_OF), nextFundingTime: String(nextFundingTime)
        }]))
      ], []),
      sleep: async () => {}
    });

    await assert.rejects(client.getCurrentSnapshot(), /Invalid OKX funding interval for BTC-USDT-SWAP/);
  }
});

test('uses realized funding history within the exclusive-start window and advances the older cursor', async () => {
  const seenRequests: SeenRequest[] = [];
  const client = new OkxClient({
    baseUrl,
    historyPageLimit: 2,
    fetch: queuedFetch([
      jsonResponse(envelope([history(200, '0.0002'), history(150, '0.00015')])),
      jsonResponse(envelope([history(150, '9'), history(101, '0.000101')])),
      jsonResponse(envelope([history(100, '0.1')]))
    ], seenRequests),
    sleep: async () => {}
  });

  const result = await client.getFundingHistory({
    market: { ...venueMarket('okx', 'BTC'), marketId: 'BTC-USDT-SWAP' },
    startTime: 100,
    endTime: 200
  });

  assert.deepEqual(result, {
    records: [
      { venue: 'okx', marketId: 'BTC-USDT-SWAP', fundingRate: '0.0002', fundingTime: 200 },
      { venue: 'okx', marketId: 'BTC-USDT-SWAP', fundingRate: '0.00015', fundingTime: 150 },
      { venue: 'okx', marketId: 'BTC-USDT-SWAP', fundingRate: '0.000101', fundingTime: 101 }
    ],
    requestCount: 3,
    pageCount: 3,
    completeFrom: 100
  });
  assert.deepEqual(seenRequests.map(({ url }) => ({
    before: url.searchParams.get('before'), after: url.searchParams.get('after'), limit: url.searchParams.get('limit')
  })), [
    { before: '100', after: '201', limit: '2' },
    { before: '100', after: '150', limit: '2' },
    { before: '100', after: '101', limit: '2' }
  ]);
});

test('rejects a full history page that cannot advance its older cursor', async () => {
  const client = new OkxClient({
    baseUrl,
    historyPageLimit: 2,
    fetch: queuedFetch([
      jsonResponse(envelope([history(200), history(150)])),
      jsonResponse(envelope([history(200), history(150)]))
    ], []),
    sleep: async () => {}
  });

  await assert.rejects(client.getFundingHistory({
    market: { ...venueMarket('okx', 'BTC'), marketId: 'BTC-USDT-SWAP' },
    startTime: 100,
    endTime: 200
  }), /Funding history pagination stalled/);
});

test('bounds current funding requests by concurrency and preserves instrument order', async () => {
  const seenRequests: SeenRequest[] = [];
  let activeCurrentRequests = 0;
  let maxCurrentRequests = 0;
  let signalTwoRequestsStarted: () => void;
  const twoRequestsStarted = new Promise<void>((resolve) => { signalTwoRequestsStarted = resolve; });
  let releaseCurrentRequests: () => void;
  const currentRequestsReleased = new Promise<void>((resolve) => { releaseCurrentRequests = resolve; });
  const currentResponse = (instId: string, fundingRate: string) => async () => {
    activeCurrentRequests += 1;
    maxCurrentRequests = Math.max(maxCurrentRequests, activeCurrentRequests);
    if (activeCurrentRequests === 2) signalTwoRequestsStarted!();
    await currentRequestsReleased;
    activeCurrentRequests -= 1;
    return jsonResponse(envelope([{ instId, fundingRate, fundingTime: String(AS_OF), nextFundingTime: String(AS_OF + HOUR) }]));
  };
  const client = new OkxClient({
    baseUrl,
    currentConcurrency: 2,
    fetch: queuedFetch([
      jsonResponse(envelope([
        swap('BTC-USDT-SWAP'),
        swap('ETH-USDT-SWAP'),
        swap('SOL-USDT-SWAP')
      ])),
      currentResponse('BTC-USDT-SWAP', '0.1'),
      currentResponse('ETH-USDT-SWAP', '0.2'),
      currentResponse('SOL-USDT-SWAP', '0.3')
    ], seenRequests),
    sleep: async () => {}
  });

  const snapshotPromise = client.getCurrentSnapshot();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      twoRequestsStarted,
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('current funding joins did not reach configured concurrency')), 100);
      })
    ]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
  assert.equal(maxCurrentRequests, 2);
  releaseCurrentRequests!();
  const snapshot = await snapshotPromise;

  assert.ok(maxCurrentRequests <= 2);
  assert.deepEqual(snapshot.markets.map(({ marketId }) => marketId), [
    'BTC-USDT-SWAP', 'ETH-USDT-SWAP', 'SOL-USDT-SWAP'
  ]);
  assert.deepEqual(seenRequests.slice(1).map(({ url }) => url.searchParams.get('instId')), [
    'BTC-USDT-SWAP', 'ETH-USDT-SWAP', 'SOL-USDT-SWAP'
  ]);
});
