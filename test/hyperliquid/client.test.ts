import assert from 'node:assert/strict';
import test from 'node:test';

import { HyperliquidClient } from '../../src/hyperliquid/client.js';
import { venueMarket } from '../helpers/fixtures.js';
import { jsonResponse, queuedFetch, type SeenRequest } from '../helpers/fetch.js';

const baseUrl = new URL('https://api.hyperliquid.xyz');
const AS_OF = Date.UTC(2026, 7, 5, 8, 5, 0);
const HOUR = 60 * 60 * 1_000;
const DAY = 24 * HOUR;

const activeAsset = (name = 'BTC') => ({ name, szDecimals: 5, maxLeverage: 40 });
const context = (funding = '0.00001') => ({ funding, openInterest: '1', markPx: '100000' });
const history = (time: number, fundingRate = '0.00001') => ({
  coin: 'BTC', fundingRate, premium: '0.00002', time
});

test('joins main-dex metadata and contexts by index and emits hourly funding', async () => {
  const seen: SeenRequest[] = [];
  const client = new HyperliquidClient({
    baseUrl,
    fetch: queuedFetch([jsonResponse([
      { universe: [activeAsset(), { ...activeAsset('DELISTED'), isDelisted: true }] },
      [context(), { funding: '0', openInterest: '0', markPx: null }]
    ])], seen),
    now: () => AS_OF,
    sleep: async () => {}
  });

  const snapshot = await client.getCurrentSnapshot();

  assert.deepEqual(snapshot.markets, [{
    venue: 'hyperliquid', marketId: 'BTC', rawBaseAsset: 'BTC', quoteAsset: 'USD', settleAsset: 'USDC',
    nextFundingRate: '0.00001', intervalHours: 1, nextFundingTime: Date.UTC(2026, 7, 5, 9, 0, 0)
  }]);
  assert.deepEqual(snapshot.stats, { marketCount: 1, requestCount: 1, pageCount: 0 });
  assert.deepEqual(JSON.parse(String(seen[0]!.init?.body)), { type: 'metaAndAssetCtxs' });
});

test('reads the XYZ HIP-3 stock DEX and keeps the prefixed market id for history', async () => {
  const seen: SeenRequest[] = [];
  const client = new HyperliquidClient({
    baseUrl,
    dex: 'xyz',
    fetch: queuedFetch([jsonResponse([
      { universe: [activeAsset('xyz:NVDA')] },
      [context()]
    ])], seen),
    now: () => AS_OF,
    sleep: async () => {}
  });

  const snapshot = await client.getCurrentSnapshot();

  assert.equal(snapshot.markets[0]?.marketId, 'xyz:NVDA');
  assert.equal(snapshot.markets[0]?.rawBaseAsset, 'NVDA');
  assert.deepEqual(JSON.parse(String(seen[0]!.init?.body)), {
    type: 'metaAndAssetCtxs', dex: 'xyz'
  });
});

test('rejects metadata/context length mismatch instead of shifting assets', async () => {
  const client = new HyperliquidClient({
    baseUrl,
    fetch: queuedFetch([jsonResponse([{ universe: [activeAsset()] }, []])], []),
    sleep: async () => {}
  });

  await assert.rejects(client.getCurrentSnapshot(), /Hyperliquid metadata and context lengths differ/);
});

test('rejects duplicate main-dex asset names before emitting a shifted snapshot', async () => {
  const client = new HyperliquidClient({
    baseUrl,
    fetch: queuedFetch([jsonResponse([
      { universe: [activeAsset('BTC'), activeAsset('BTC')] },
      [context(), context('0.00002')]
    ])], []),
    sleep: async () => {}
  });

  await assert.rejects(client.getCurrentSnapshot(), /Duplicate Hyperliquid asset BTC/);
});

test('rejects a blank active main-dex asset name', async () => {
  const client = new HyperliquidClient({
    baseUrl,
    fetch: queuedFetch([jsonResponse([{ universe: [activeAsset('')] }, [context()]])], []),
    sleep: async () => {}
  });

  await assert.rejects(client.getCurrentSnapshot(), /Invalid Hyperliquid asset name/);
});

test('rejects an empty active main-dex universe', async () => {
  const client = new HyperliquidClient({
    baseUrl,
    fetch: queuedFetch([jsonResponse([
      { universe: [{ ...activeAsset(), isDelisted: true }] },
      [context()]
    ])], []),
    sleep: async () => {}
  });

  await assert.rejects(client.getCurrentSnapshot(), /No active Hyperliquid markets/);
});

test('rejects blank and non-finite current funding values', async () => {
  for (const funding of ['', 'NaN', 'Infinity']) {
    const client = new HyperliquidClient({
      baseUrl,
      fetch: queuedFetch([jsonResponse([{ universe: [activeAsset()] }, [context(funding)]])], []),
      sleep: async () => {}
    });

    await assert.rejects(client.getCurrentSnapshot(), /Invalid Hyperliquid funding for BTC/);
  }
});

test('reads historical hourly settlements from fundingHistory', async () => {
  const seen: SeenRequest[] = [];
  const client = new HyperliquidClient({
    baseUrl,
    fetch: queuedFetch([jsonResponse([
      history(AS_OF - HOUR),
      history(AS_OF, '0.00002')
    ])], seen),
    sleep: async () => {}
  });

  const result = await client.getFundingHistory({
    market: { ...venueMarket('hyperliquid', 'BTC'), marketId: 'BTC' },
    startTime: AS_OF - DAY,
    endTime: AS_OF
  });

  assert.deepEqual(result.records.map(({ fundingRate }) => fundingRate), ['0.00001', '0.00002']);
  assert.deepEqual(JSON.parse(String(seen[0]!.init?.body)), {
    type: 'fundingHistory', coin: 'BTC', startTime: AS_OF - DAY, endTime: AS_OF
  });
});

test('rejects malformed fundingHistory settlements without emitting partial history', async () => {
  const invalidPages = [
    { name: 'a different coin', page: [{ ...history(100), coin: 'ETH' }], error: /Unexpected Hyperliquid funding history asset ETH/ },
    { name: 'a time outside the requested window', page: [history(201)], error: /outside requested window/ },
    { name: 'an unsafe time', page: [history(Number.MAX_SAFE_INTEGER + 1)], error: /Invalid Hyperliquid funding history time/ },
    { name: 'blank funding', page: [history(100, '')], error: /Invalid Hyperliquid funding for BTC/ },
    { name: 'NaN funding', page: [history(100, 'NaN')], error: /Invalid Hyperliquid funding for BTC/ },
    { name: 'infinite funding', page: [history(100, 'Infinity')], error: /Invalid Hyperliquid funding for BTC/ }
  ];

  for (const { name, page, error } of invalidPages) {
    const client = new HyperliquidClient({
      baseUrl,
      fetch: queuedFetch([jsonResponse(page)], []),
      sleep: async () => {}
    });

    await assert.rejects(client.getFundingHistory({
      market: { ...venueMarket('hyperliquid', 'BTC'), marketId: 'BTC' },
      startTime: 100,
      endTime: 200
    }), error, name);
  }
});

test('rejects a fundingHistory response that exceeds Hyperliquid\'s 500-row page limit', async () => {
  const oversizedPage = Array.from({ length: 501 }, (_, index) => history(index + 1));
  const client = new HyperliquidClient({
    baseUrl,
    fetch: queuedFetch([jsonResponse(oversizedPage)], []),
    sleep: async () => {}
  });

  await assert.rejects(client.getFundingHistory({
    market: { ...venueMarket('hyperliquid', 'BTC'), marketId: 'BTC' },
    startTime: 0,
    endTime: 1_000
  }), /Hyperliquid funding history response exceeded 500 records/);
});

test('paginates 500-row fundingHistory pages without losing the inclusive boundary', async () => {
  const seen: SeenRequest[] = [];
  const firstPage = Array.from({ length: 500 }, (_, index) => history(index + 1));
  const client = new HyperliquidClient({
    baseUrl,
    fetch: queuedFetch([
      jsonResponse(firstPage),
      jsonResponse([history(500), history(501, '0.00002')])
    ], seen),
    sleep: async () => {}
  });

  const result = await client.getFundingHistory({
    market: { ...venueMarket('hyperliquid', 'BTC'), marketId: 'BTC' },
    startTime: 0,
    endTime: 1_000
  });

  assert.equal(result.records.length, 501);
  assert.deepEqual(new Set(result.records.map(({ fundingTime }) => fundingTime)).size, 501);
  assert.equal(result.records.at(-1)?.fundingRate, '0.00002');
  assert.deepEqual(seen.map(({ init }) => JSON.parse(String(init?.body))), [
    { type: 'fundingHistory', coin: 'BTC', startTime: 0, endTime: 1_000 },
    { type: 'fundingHistory', coin: 'BTC', startTime: 500, endTime: 1_000 }
  ]);
});

test('rejects a full funding history page that does not advance', async () => {
  const repeatedPage = Array.from({ length: 500 }, () => history(100));
  const client = new HyperliquidClient({
    baseUrl,
    fetch: queuedFetch([jsonResponse(repeatedPage)], []),
    sleep: async () => {}
  });

  await assert.rejects(client.getFundingHistory({
    market: { ...venueMarket('hyperliquid', 'BTC'), marketId: 'BTC' },
    startTime: 100,
    endTime: 1_000
  }), /Funding history pagination stalled/);
});
