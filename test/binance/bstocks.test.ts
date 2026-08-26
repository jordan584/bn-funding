import assert from 'node:assert/strict';
import test from 'node:test';

import { BinanceBStocksClient } from '../../src/binance/bstocks.js';
import { VenueRequestError } from '../../src/exchanges/http.js';
import { jsonResponse, queuedFetch, type SeenRequest } from '../helpers/fetch.js';

const baseUrl = new URL('https://www.binance.com');

function response(data: unknown, overrides: Record<string, unknown> = {}) {
  return { code: '000000', success: true, data, ...overrides };
}

function assets(count = 20) {
  return Array.from({ length: count }, (_, index) => ({
    symbol: `STOCK${index + 1}B`,
    ticker: `STOCK${index + 1}`,
    type: 3
  }));
}

test('loads the live bStocks type-3 universe using canonical ticker fields', async () => {
  const seen: SeenRequest[] = [];
  const client = new BinanceBStocksClient({
    baseUrl,
    fetch: queuedFetch([jsonResponse(response([
      { symbol: 'nvdab', ticker: 'nvda', type: 3 },
      ...assets(19)
    ]))], seen),
    sleep: async () => {}
  });

  const tickers = await client.getStockTickers();

  assert.deepEqual(tickers.slice(0, 2), ['NVDA', 'STOCK1']);
  assert.equal(tickers.length, 20);
  assert.equal(seen[0]?.url.pathname, '/bapi/defi/v1/public/wallet-direct/buw/wallet/market/token/rwa/stock/detail/list/ai');
  assert.equal(seen[0]?.url.searchParams.get('type'), '3');
});

test('fails closed for duplicate, undersized, or unsuccessful bStocks universes', async () => {
  for (const payload of [
    response([...assets(), { symbol: 'OTHERB', ticker: 'STOCK1', type: 3 }]),
    response(assets(19)),
    response(assets(), { success: false })
  ]) {
    const client = new BinanceBStocksClient({
      baseUrl,
      fetch: queuedFetch([jsonResponse(payload)], []),
      sleep: async () => {}
    });
    await assert.rejects(client.getStockTickers(), VenueRequestError);
  }
});
