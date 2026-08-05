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

test('keeps live USDT swaps and derives the actual current funding interval', async () => {
  const client = new OkxClient({
    baseUrl,
    fetch: queuedFetch([
      jsonResponse(envelope([
        { instId: 'BTC-USDT-SWAP', instType: 'SWAP', baseCcy: 'BTC', quoteCcy: 'USDT', settleCcy: 'USDT', state: 'live', listTime: String(AS_OF - DAY) },
        { instId: 'ETH-USDC-SWAP', instType: 'SWAP', baseCcy: 'ETH', quoteCcy: 'USDC', settleCcy: 'USDC', state: 'live', listTime: String(AS_OF - DAY) }
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
      jsonResponse(envelope([{
        instId: 'BTC-USDT-SWAP', instType: 'SWAP', baseCcy: 'BTC', quoteCcy: 'USDT', settleCcy: 'USDT', state: 'live', listTime: String(AS_OF - DAY)
      }])),
      jsonResponse(envelope([]))
    ], []),
    sleep: async () => {}
  });

  await assert.rejects(client.getCurrentSnapshot(), /Missing OKX current funding for BTC-USDT-SWAP/);
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
        { instId: 'BTC-USDT-SWAP', instType: 'SWAP', baseCcy: 'BTC', quoteCcy: 'USDT', settleCcy: 'USDT', state: 'live', listTime: String(AS_OF - DAY) },
        { instId: 'ETH-USDT-SWAP', instType: 'SWAP', baseCcy: 'ETH', quoteCcy: 'USDT', settleCcy: 'USDT', state: 'live', listTime: String(AS_OF - DAY) },
        { instId: 'SOL-USDT-SWAP', instType: 'SWAP', baseCcy: 'SOL', quoteCcy: 'USDT', settleCcy: 'USDT', state: 'live', listTime: String(AS_OF - DAY) }
      ])),
      currentResponse('BTC-USDT-SWAP', '0.1'),
      currentResponse('ETH-USDT-SWAP', '0.2'),
      currentResponse('SOL-USDT-SWAP', '0.3')
    ], seenRequests),
    sleep: async () => {}
  });

  const snapshotPromise = client.getCurrentSnapshot();
  await twoRequestsStarted;
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
