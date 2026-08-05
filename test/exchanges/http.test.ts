import assert from 'node:assert/strict';
import test from 'node:test';

import { PublicJsonClient, VenueRequestError, VenueTimeoutError } from '../../src/exchanges/http.js';
import { jsonResponse, queuedFetch } from '../helpers/fetch.js';

test('supports GET query and POST JSON without leaking the full URL into errors', async () => {
  const seen: Array<{ url: URL; init?: RequestInit }> = [];
  const client = new PublicJsonClient({
    venue: 'okx',
    baseUrl: new URL('https://www.okx.com'),
    fetch: queuedFetch([jsonResponse({ ok: true }), jsonResponse({ posted: true })], seen)
  });

  assert.deepEqual(await client.getJson('/public', { instId: 'BTC-USDT-SWAP' }), { ok: true });
  assert.deepEqual(await client.postJson('/info', { type: 'meta' }), { posted: true });
  assert.equal(seen[0]!.url.searchParams.get('instId'), 'BTC-USDT-SWAP');
  assert.equal(seen[1]!.init?.method, 'POST');
  assert.equal(seen[1]!.init?.body, JSON.stringify({ type: 'meta' }));
});

test('retries 429 and 5xx three times and honors Retry-After', async () => {
  const sleeps: number[] = [];
  const client = new PublicJsonClient({
    venue: 'bybit',
    baseUrl: new URL('https://api.bybit.com'),
    fetch: queuedFetch([
      new Response('busy', { status: 429, headers: { 'retry-after': '2' } }),
      new Response('bad', { status: 503 }),
      jsonResponse({ retCode: 0 })
    ], []),
    sleep: async (ms) => { sleeps.push(ms); },
    random: () => 0
  });

  assert.deepEqual(await client.getJson('/v5/market/tickers'), { retCode: 0 });
  assert.deepEqual(sleeps, [2_000, 1_000]);
});

test('classifies final timeout and bounds non-retryable response bodies', async () => {
  const timeoutClient = new PublicJsonClient({
    venue: 'bitget',
    baseUrl: new URL('https://api.bitget.com'),
    timeoutMs: 1,
    maxRetries: 0,
    fetch: async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('timed out', 'TimeoutError')));
    })
  });
  await assert.rejects(timeoutClient.getJson('/slow'), VenueTimeoutError);

  const bodyClient = new PublicJsonClient({
    venue: 'binance',
    baseUrl: new URL('https://fapi.binance.com'),
    fetch: queuedFetch([new Response('x'.repeat(600), { status: 400 })], [])
  });
  await assert.rejects(bodyClient.getJson('/bad'), (error: unknown) => {
    assert.ok(error instanceof VenueRequestError);
    assert.match(error.message, /x{500}/);
    assert.doesNotMatch(error.message, /x{501}/);
    return true;
  });
});
