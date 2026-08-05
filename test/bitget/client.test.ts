import assert from 'node:assert/strict';
import test from 'node:test';

import { VenueRequestError } from '../../src/exchanges/http.js';
import { BitgetClient } from '../../src/bitget/client.js';
import { venueMarket } from '../helpers/fixtures.js';
import { jsonResponse, queuedFetch, type SeenRequest } from '../helpers/fetch.js';

const baseUrl = new URL('https://api.bitget.com');
const AS_OF = Date.UTC(2026, 7, 5, 8, 5, 0);
const HOUR = 60 * 60 * 1_000;
const DAY = 24 * HOUR;

const envelope = (data: unknown, code = '00000') => ({
  code,
  msg: code === '00000' ? 'success' : 'request failed',
  requestTime: AS_OF,
  data
});

const contract = (
  symbol: string,
  overrides: Partial<Record<'baseCoin' | 'launchTime' | 'quoteCoin' | 'symbolStatus', string>> = {}
) => ({
  symbol,
  baseCoin: symbol.replace(/USDT$/, ''),
  quoteCoin: 'USDT',
  symbolStatus: 'normal',
  launchTime: String(AS_OF - DAY),
  ...overrides
});

const current = (
  symbol: string,
  overrides: Partial<Record<'fundingRate' | 'fundingRateInterval' | 'nextUpdate', string>> = {}
) => ({
  symbol,
  fundingRate: '0.0004',
  fundingRateInterval: '2',
  nextUpdate: String(AS_OF + 2 * HOUR),
  minFundingRate: '-0.003',
  maxFundingRate: '0.003',
  cashDividend: '0',
  cashDividendNextUpdate: '0',
  ...overrides
});

const history = (fundingTime: number, fundingRate = '0.0001', symbol = 'BTCUSDT') => ({
  symbol,
  fundingRate,
  fundingTime: String(fundingTime)
});

test('joins normal USDT contracts to current Funding and its 1/2/4/8-hour interval', async () => {
  const client = new BitgetClient({
    baseUrl,
    fetch: queuedFetch([
      jsonResponse(envelope([
        contract('BTCUSDT'),
        contract('ETHUSDC', { baseCoin: 'ETH', quoteCoin: 'USDC' })
      ])),
      jsonResponse(envelope([current('BTCUSDT')]))
    ], []),
    now: () => AS_OF,
    sleep: async () => {}
  });

  const snapshot = await client.getCurrentSnapshot();

  assert.deepEqual(snapshot.markets, [{
    venue: 'bitget', marketId: 'BTCUSDT', rawBaseAsset: 'BTC', quoteAsset: 'USDT', settleAsset: 'USDT',
    nextFundingRate: '0.0004', intervalHours: 2, nextFundingTime: AS_OF + 2 * HOUR, listedAt: AS_OF - DAY
  }]);
  assert.deepEqual(snapshot.stats, { marketCount: 1, requestCount: 2, pageCount: 0 });
});

test('rejects a non-success Bitget business code from an HTTP-success response', async () => {
  const client = new BitgetClient({
    baseUrl,
    fetch: queuedFetch([jsonResponse(envelope([], '40015'))], []),
    sleep: async () => {}
  });

  await assert.rejects(client.getCurrentSnapshot(), (error: unknown) => (
    error instanceof VenueRequestError && error.venue === 'bitget' && /business error 40015/.test(error.message)
  ));
});

test('rejects a current funding interval outside Bitget\'s documented set', async () => {
  const client = new BitgetClient({
    baseUrl,
    fetch: queuedFetch([
      jsonResponse(envelope([contract('BTCUSDT')])),
      jsonResponse(envelope([current('BTCUSDT', { fundingRateInterval: '3' })]))
    ], []),
    sleep: async () => {}
  });

  await assert.rejects(client.getCurrentSnapshot(), /Bitget response validation failed/);
});

test('fails the complete snapshot when an eligible contract has no current funding', async () => {
  const client = new BitgetClient({
    baseUrl,
    fetch: queuedFetch([
      jsonResponse(envelope([contract('BTCUSDT'), contract('ETHUSDT')])),
      jsonResponse(envelope([current('BTCUSDT')]))
    ], []),
    sleep: async () => {}
  });

  await assert.rejects(client.getCurrentSnapshot(), /Missing Bitget current funding for ETHUSDT/);
});

test('requests numbered 100-row Bitget history pages and returns 168 hourly rows once in ascending order', async () => {
  const seen: SeenRequest[] = [];
  const firstPage = Array.from({ length: 100 }, (_, index) => history(AS_OF - (167 - index) * HOUR));
  const secondPage = [history(AS_OF - 68 * HOUR), ...Array.from(
    { length: 68 },
    (_, index) => history(AS_OF - (67 - index) * HOUR, index === 0 ? '0.0002' : '0.0001')
  )];
  const client = new BitgetClient({
    baseUrl,
    fetch: queuedFetch([
      jsonResponse(envelope(firstPage)),
      jsonResponse(envelope(secondPage))
    ], seen),
    sleep: async () => {}
  });

  const result = await client.getFundingHistory({
    market: { ...venueMarket('bitget', 'BTC', '0.0001', 1), marketId: 'BTCUSDT' },
    startTime: AS_OF - 7 * DAY,
    endTime: AS_OF
  });

  assert.equal(result.records.length, 168);
  assert.equal(new Set(result.records.map(({ fundingTime }) => fundingTime)).size, 168);
  assert.deepEqual(result.records.map(({ fundingTime }) => fundingTime), Array.from(
    { length: 168 },
    (_, index) => AS_OF - (167 - index) * HOUR
  ));
  assert.equal(result.records.at(-68)?.fundingRate, '0.0002');
  assert.deepEqual(seen.map(({ url }) => Object.fromEntries(url.searchParams)), [
    { symbol: 'BTCUSDT', productType: 'usdt-futures', pageSize: '100', pageNo: '1' },
    { symbol: 'BTCUSDT', productType: 'usdt-futures', pageSize: '100', pageNo: '2' }
  ]);
});

test('rejects a full Bitget history page that contains no new settlement keys', async () => {
  const firstPage = Array.from({ length: 100 }, (_, index) => history(AS_OF - (100 - index) * HOUR));
  const duplicatePage = Array.from({ length: 100 }, () => history(AS_OF - HOUR));
  const client = new BitgetClient({
    baseUrl,
    fetch: queuedFetch([
      jsonResponse(envelope(firstPage)),
      jsonResponse(envelope(duplicatePage))
    ], []),
    sleep: async () => {}
  });

  await assert.rejects(client.getFundingHistory({
    market: { ...venueMarket('bitget', 'BTC'), marketId: 'BTCUSDT' },
    startTime: AS_OF - DAY,
    endTime: AS_OF
  }), /Bitget funding history pagination stalled/);
});

test('rejects a repeated full Bitget history page instead of looping', async () => {
  const firstPage = Array.from({ length: 100 }, (_, index) => history(AS_OF - (100 - index) * HOUR));
  const client = new BitgetClient({
    baseUrl,
    fetch: queuedFetch([
      jsonResponse(envelope(firstPage)),
      jsonResponse(envelope(firstPage))
    ], []),
    sleep: async () => {}
  });

  await assert.rejects(client.getFundingHistory({
    market: { ...venueMarket('bitget', 'BTC'), marketId: 'BTCUSDT' },
    startTime: AS_OF - 7 * DAY,
    endTime: AS_OF
  }), /Bitget funding history pagination stalled/);
});
