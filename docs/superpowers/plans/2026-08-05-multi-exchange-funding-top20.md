# Multi-Exchange Funding Top20 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the existing Node.js funding monitor from Binance-only ranking to an equal-weight Top20 across Binance, OKX, Hyperliquid, Bybit, and Bitget, then show each venue's estimated next Funding and trailing seven-day average in Google Chat.

**Architecture:** Preserve the existing scheduler, PM2 process, state store, run lock, CLI, and Google Chat delivery transaction. Add a shared public-HTTP layer and one adapter per venue, normalize venue markets into a common domain, rank by equal-weight next-Funding APR, fetch seven-day history only for the selected Top20, and render two compact mobile-readable Top10 cards.

**Tech Stack:** Node.js 24 LTS, TypeScript 7, native `fetch`, Zod 4, decimal.js, node:test, node-cron, PM2, Google Chat `cardsV2`.

**Approved Design:** `docs/superpowers/specs/2026-08-05-multi-exchange-funding-top20-design.md`

## Global Constraints

- Use Node.js **24 LTS**; retain `engines.node = ">=24"`.
- Venues are exactly `binance`, `okx`, `hyperliquid`, `bybit`, and `bitget`, displayed as `Bn`, `OKX`, `Hyper`, `Bybit`, and `Bitget` in that order.
- Binance, OKX, Bybit, and Bitget include only live USDT-settled linear perpetuals; Hyperliquid includes only the first-party main Perp DEX.
- Do not add volume, open-interest, market-cap, or listing-age filters or weights.
- Normalize each venue's estimated next Funding to APR before averaging; never average raw rates with different intervals.
- Equal-weight only valid venues for an asset; require coverage of at least 2 venues; do not replace missing venues with zero.
- Rank signed composite next APR descending; break ties by coverage descending, then normalized asset ID ascending.
- Fetch and display trailing seven-day realized Funding only after selecting Top20; seven-day values do not affect ranking.
- Preserve Beijing scheduling at `00:05`, `08:05`, `16:05`, the 30-minute catch-up window, single PM2 fork, cross-process lock, duplicate prevention, and Google Chat 2xx-before-state-commit behavior.
- Use only public read-only exchange endpoints; add no exchange API keys, database, inbound server port, image service, GCS, or Cloud Run dependency.
- A full-current-snapshot failure from any venue fails the entire run; an asset not listed on a venue is a normal `--` value.
- The Google Chat JSON payload must be strictly below 32,000 UTF-8 bytes; never truncate assets or venues.
- Use `Decimal` for rate, APR, average, comparison, and rounding calculations.
- Every task follows red-green-refactor TDD and ends with a focused commit.

---

## File Structure

### Shared exchange infrastructure

- Create `src/exchanges/http.ts`: timeout, bounded error body, retry, backoff, `Retry-After`, GET/POST JSON, and request pacing.
- Create `src/exchanges/concurrency.ts`: deterministic bounded async mapping used for per-market requests.
- Create `src/exchanges/normalize.ts`: normalized asset IDs and explicit multiplier aliases.
- Modify `src/domain.ts`: add cross-venue adapter contracts, snapshot/history types, and composite rows alongside the legacy Binance types until the job migration task removes them.

### Venue adapters

- Create `src/binance/adapter.ts` and modify `src/binance/client.ts` / `src/binance/schemas.ts`: expose the common adapter without breaking the existing Binance job before Task 11.
- Create `src/okx/client.ts` and `src/okx/schemas.ts`.
- Create `src/hyperliquid/client.ts` and `src/hyperliquid/schemas.ts`.
- Create `src/bybit/client.ts` and `src/bybit/schemas.ts`.
- Create `src/bitget/client.ts` and `src/bitget/schemas.ts`.

### Ranking, history, display, and orchestration

- Create `src/funding/composite.ts`: build deterministic equal-weight composite candidates alongside the legacy aggregator.
- Create `src/funding/history.ts`: hydrate selected rows with per-venue seven-day metrics.
- Create `src/funding/multi-venue-format.ts`: multi-venue console output and `%/日` formatting.
- Create `src/chat/multi-venue-cards.ts`: compact five-venue rows across two Top10 cards.
- Modify `src/job.ts`: two-phase current-snapshot then selected-history workflow and venue observability.
- Modify `src/config.ts` and `src/app.ts`: five public base URLs and adapter assembly.
- Modify `README.md`: five-venue behavior, dry-run validation, and recovery guidance.

### Tests

- Create `test/exchanges/http.test.ts`, `test/exchanges/normalize.test.ts`, and one client test file per new venue.
- Extend `test/helpers/fixtures.ts` with venue-neutral builders, retaining legacy builders until Task 11 removes legacy consumers.
- Add new composite/card tests beside legacy tests, then remove the superseded Binance-only modules and tests in the job migration task.

---

### Task 1: Cross-Venue Domain and Asset Normalization

**Files:**
- Modify: `src/domain.ts`
- Create: `src/exchanges/normalize.ts`
- Create: `test/exchanges/normalize.test.ts`
- Modify: `test/helpers/fixtures.ts`

**Interfaces:**
- Produces: `VenueId`, `VENUE_IDS`, `VenueFundingSnapshot`, `VenueSnapshot`, `VenueHistoryRequest`, `VenueHistoryResult`, `FundingVenueAdapter`, `CompositeVenueFundingMetric`, `CompositeFundingRow`, and `CompositeFundingLeaderboard`.
- Produces: `normalizeAsset(venue: VenueId, rawBaseAsset: string): string`.
- Produces: venue-neutral fixture functions used by Tasks 3–12.

- [ ] **Step 1: Write failing normalization and domain-shape tests**

Create `test/exchanges/normalize.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { VENUE_IDS } from '../../src/domain.js';
import { normalizeAsset } from '../../src/exchanges/normalize.js';

test('uses the five approved venues in stable card order', () => {
  assert.deepEqual(VENUE_IDS, ['binance', 'okx', 'hyperliquid', 'bybit', 'bitget']);
});

test('normalizes case and approved multiplier aliases without guessing', () => {
  assert.equal(normalizeAsset('binance', 'btc'), 'BTC');
  assert.equal(normalizeAsset('binance', '1000PEPE'), 'PEPE');
  assert.equal(normalizeAsset('hyperliquid', 'kPEPE'), 'PEPE');
  assert.equal(normalizeAsset('bybit', '1MBABYDOGE'), 'BABYDOGE');
  assert.equal(normalizeAsset('okx', '1000UNKNOWN'), '1000UNKNOWN');
});

test('rejects blank or unsafe asset identifiers', () => {
  assert.throws(() => normalizeAsset('bitget', ''), /Invalid bitget base asset/);
  assert.throws(() => normalizeAsset('okx', 'BTC<'), /Invalid okx base asset/);
});
```

Append venue-neutral builders to `test/helpers/fixtures.ts`; retain the existing Binance fixture builders until Task 11 removes the legacy test path:

```ts
import type {
  FundingHistorySettlement,
  VenueFundingSnapshot,
  VenueId,
  VenueSnapshot
} from '../../src/domain.js';

export const AS_OF = Date.UTC(2026, 7, 5, 8, 5, 0);
export const HOUR = 60 * 60 * 1_000;
export const DAY = 24 * HOUR;

export function venueMarket(
  venue: VenueId,
  asset: string,
  rate = '0.0001',
  intervalHours = venue === 'hyperliquid' ? 1 : 8
): VenueFundingSnapshot {
  return {
    venue,
    marketId: `${asset}-${venue}`,
    rawBaseAsset: asset,
    quoteAsset: venue === 'hyperliquid' ? 'USD' : 'USDT',
    settleAsset: venue === 'hyperliquid' ? 'USDC' : 'USDT',
    nextFundingRate: rate,
    intervalHours,
    nextFundingTime: AS_OF + intervalHours * HOUR,
    listedAt: AS_OF - 30 * DAY
  };
}

export function venueSnapshot(venue: VenueId, markets: VenueFundingSnapshot[]): VenueSnapshot {
  return {
    venue,
    observedAt: AS_OF,
    markets,
    stats: { marketCount: markets.length, requestCount: 1, pageCount: 1 }
  };
}

export function settlement(
  venue: VenueId,
  marketId: string,
  fundingRate: string,
  fundingTime: number
): FundingHistorySettlement {
  return { venue, marketId, fundingRate, fundingTime };
}
```

- [ ] **Step 2: Run the focused tests and verify red**

Run: `node --import tsx --test test/exchanges/normalize.test.ts`

Expected: FAIL because `VENUE_IDS`, the new domain interfaces, and `normalizeAsset` do not exist.

- [ ] **Step 3: Replace the Binance-only domain with explicit cross-venue contracts**

Keep the existing run/schedule/logger and Binance transport/ranking types unchanged, and append these exact public cross-venue contracts to `src/domain.ts`:

```ts
export const VENUE_IDS = ['binance', 'okx', 'hyperliquid', 'bybit', 'bitget'] as const;
export type VenueId = typeof VENUE_IDS[number];

export interface VenueFundingSnapshot {
  venue: VenueId;
  marketId: string;
  rawBaseAsset: string;
  quoteAsset: string;
  settleAsset: string;
  nextFundingRate: string;
  intervalHours: number;
  nextFundingTime: number;
  listedAt?: number;
}

export interface VenueSnapshotStats {
  marketCount: number;
  requestCount: number;
  pageCount: number;
}

export interface VenueSnapshot {
  venue: VenueId;
  observedAt: number;
  markets: VenueFundingSnapshot[];
  stats: VenueSnapshotStats;
}

export interface FundingHistorySettlement {
  venue: VenueId;
  marketId: string;
  fundingRate: string;
  fundingTime: number;
}

export interface VenueHistoryRequest {
  market: VenueFundingSnapshot;
  startTime: number;
  endTime: number;
}

export interface VenueHistoryResult {
  records: FundingHistorySettlement[];
  requestCount: number;
  pageCount: number;
  completeFrom: number;
}

export interface FundingVenueAdapter {
  readonly id: VenueId;
  getCurrentSnapshot(): Promise<VenueSnapshot>;
  getFundingHistory(request: VenueHistoryRequest): Promise<VenueHistoryResult>;
}

export interface CompositeVenueFundingMetric {
  venue: VenueId;
  marketId: string;
  nextFundingRate: DecimalInstance;
  intervalHours: number;
  nextFundingTime: number;
  nextApr: DecimalInstance;
  listedAt?: number;
  sevenDayAverageDailyRate: DecimalInstance | null;
  sevenDayApr: DecimalInstance | null;
  partialSevenDayHistory: boolean;
}

export interface CompositeFundingRow {
  rank: number;
  asset: string;
  compositeNextApr: DecimalInstance;
  coverageCount: number;
  venues: Partial<Record<VenueId, CompositeVenueFundingMetric>>;
}

export interface CompositeFundingLeaderboard {
  asOf: number;
  candidateCount: number;
  venueStats: Record<VenueId, VenueSnapshotStats>;
  rows: CompositeFundingRow[];
}
```

Task 11 replaces `AppConfig` and removes the superseded Binance-only domain types after all consumers have migrated; do not change scheduler, state, or existing Binance consumer types in this task.

- [ ] **Step 4: Implement explicit normalization without heuristic prefix stripping**

Create `src/exchanges/normalize.ts`:

```ts
import type { VenueId } from '../domain.js';

const ALIASES: Record<VenueId, Readonly<Record<string, string>>> = {
  binance: {
    '1000BONK': 'BONK',
    '1000FLOKI': 'FLOKI',
    '1000LUNC': 'LUNC',
    '1000PEPE': 'PEPE',
    '1000SATS': 'SATS',
    '1000SHIB': 'SHIB',
    '1000XEC': 'XEC',
    '1MBABYDOGE': 'BABYDOGE'
  },
  okx: {},
  hyperliquid: { kBONK: 'BONK', kFLOKI: 'FLOKI', kLUNC: 'LUNC', kPEPE: 'PEPE', kSHIB: 'SHIB' },
  bybit: { '1000BONK': 'BONK', '1000FLOKI': 'FLOKI', '1000PEPE': 'PEPE', '1000SHIB': 'SHIB', '1MBABYDOGE': 'BABYDOGE' },
  bitget: { '1000BONK': 'BONK', '1000FLOKI': 'FLOKI', '1000PEPE': 'PEPE', '1000SHIB': 'SHIB' }
};

export function normalizeAsset(venue: VenueId, rawBaseAsset: string): string {
  const normalized = rawBaseAsset.trim().toUpperCase();
  if (!/^[A-Z0-9]+$/.test(normalized)) {
    throw new Error(`Invalid ${venue} base asset`);
  }
  const venueAliases = Object.fromEntries(
    Object.entries(ALIASES[venue]).map(([key, value]) => [key.toUpperCase(), value])
  );
  return venueAliases[normalized] ?? normalized;
}
```

- [ ] **Step 5: Run tests, typecheck, and commit**

Run: `node --import tsx --test test/exchanges/normalize.test.ts`

Run: `npm run typecheck`

Expected: PASS.

Commit:

```bash
git add src/domain.ts src/exchanges/normalize.ts test/exchanges/normalize.test.ts test/helpers/fixtures.ts
git commit -m "feat: define multi-venue funding domain"
```

---

### Task 2: Shared Public HTTP Client and Bounded Concurrency

**Files:**
- Create: `src/exchanges/http.ts`
- Create: `src/exchanges/concurrency.ts`
- Create: `test/exchanges/http.test.ts`
- Create: `test/exchanges/concurrency.test.ts`
- Modify: `test/helpers/fetch.ts`

**Interfaces:**
- Produces: `PublicJsonClient`, `VenueRequestError`, and `VenueTimeoutError`.
- Produces: `mapWithConcurrency<T, R>(items, concurrency, worker): Promise<R[]>`.
- Consumes: `VenueId` from Task 1.

- [ ] **Step 1: Write failing shared HTTP behavior tests**

Create `test/exchanges/http.test.ts` with these core cases:

```ts
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
```

Create `test/exchanges/concurrency.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { mapWithConcurrency } from '../../src/exchanges/concurrency.js';

test('preserves order while never exceeding the requested concurrency', async () => {
  let active = 0;
  let maximum = 0;
  const result = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (value) => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise<void>((resolve) => setImmediate(resolve));
    active -= 1;
    return value * 2;
  });
  assert.deepEqual(result, [2, 4, 6, 8, 10]);
  assert.equal(maximum, 2);
});
```

- [ ] **Step 2: Run focused tests and verify red**

Run: `node --import tsx --test test/exchanges/http.test.ts test/exchanges/concurrency.test.ts`

Expected: FAIL because the shared modules do not exist.

- [ ] **Step 3: Implement deterministic bounded mapping**

Create `src/exchanges/concurrency.ts`:

```ts
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error('concurrency must be a positive integer');
  }
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index]!, index);
    }
  });
  await Promise.all(runners);
  return results;
}
```

- [ ] **Step 4: Implement one hardened GET/POST JSON path with pacing**

Create `src/exchanges/http.ts` with these exports and rules:

```ts
import type { VenueId } from '../domain.js';

const MAX_RETRIES = 3;
const MAX_ERROR_BODY = 500;

export class VenueRequestError extends Error {
  constructor(readonly venue: VenueId, message: string) {
    super(message);
    this.name = 'VenueRequestError';
  }
}

export class VenueTimeoutError extends VenueRequestError {
  constructor(venue: VenueId, method: string, path: string) {
    super(venue, `${venue} request timed out: ${method} ${path}`);
    this.name = 'VenueTimeoutError';
  }
}

export interface PublicJsonClientOptions {
  venue: VenueId;
  baseUrl: URL;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  maxRetries?: number;
  minRequestIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
}

export class PublicJsonClient {
  private nextRequestAt = 0;
  private pacingTail: Promise<void> = Promise.resolve();

  async getJson(path: string, query: Record<string, string> = {}): Promise<unknown> {
    return this.requestJson('GET', path, query, undefined);
  }

  async postJson(path: string, body: unknown): Promise<unknown> {
    return this.requestJson('POST', path, {}, body);
  }
}
```

Implement `requestJson` so every attempt:

1. Waits on a serialized pacing gate and reserves `now() + minRequestIntervalMs`.
2. Uses `AbortSignal.timeout(timeoutMs)`.
3. Parses JSON inside the same timeout boundary.
4. Retries network failures, timeouts, 429, and 5xx up to the normalized maximum of 3 retries.
5. Honors numeric `Retry-After` seconds; otherwise waits `min(500 * 2^retryIndex + random() * 250, 10_000)`.
6. Throws `VenueTimeoutError` after the final timeout.
7. Throws `VenueRequestError` for malformed JSON, non-retryable 4xx, exhausted retryable responses, and final network failure.
8. Includes only venue, method, path, HTTP status, and at most 500 body characters in errors; never include a query string.

- [ ] **Step 5: Run focused and legacy HTTP tests, then commit**

Run: `node --import tsx --test test/exchanges/http.test.ts test/exchanges/concurrency.test.ts test/binance/client.test.ts`

Run: `npm run typecheck`

Expected: shared tests PASS; existing Binance tests remain PASS until Task 3 migrates them.

Commit:

```bash
git add src/exchanges/http.ts src/exchanges/concurrency.ts test/exchanges/http.test.ts test/exchanges/concurrency.test.ts test/helpers/fetch.ts
git commit -m "feat: add resilient venue HTTP infrastructure"
```

---

### Task 3: Binance Adapter Migration

**Files:**
- Create: `src/binance/adapter.ts`
- Modify: `src/binance/client.ts`
- Modify: `src/binance/schemas.ts`
- Modify: `test/binance/client.test.ts`
- Create: `test/binance/adapter.test.ts`

**Interfaces:**
- Consumes: `FundingVenueAdapter`, `VenueSnapshot`, `VenueHistoryRequest`, and `VenueHistoryResult` from Task 1.
- Produces: `BinanceVenueAdapter implements FundingVenueAdapter` with `id = 'binance'` while `BinanceClient` keeps its existing public methods for the legacy job until Task 11.

- [ ] **Step 1: Add common-adapter contract tests without deleting legacy client tests**

Retain schema, pagination, retry, timeout, and bounded-body coverage already present in `test/binance/client.test.ts`. Create `test/binance/adapter.test.ts` and add:

```ts
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
  const adapter = new BinanceVenueAdapter({
    baseUrl,
    historyPageLimit: 2,
    fetch: queuedFetch([
      jsonResponse([fundingRecord('BTCUSDT', 101), fundingRecord('BTCUSDT', 200)]),
      jsonResponse([fundingRecord('BTCUSDT', 200)])
    ], [])
  });
  const result = await adapter.getFundingHistory({
    market: { ...venueMarket('binance', 'BTC'), marketId: 'BTCUSDT' },
    startTime: 100,
    endTime: 300
  });
  assert.deepEqual(result.records.map(({ fundingTime }) => fundingTime), [101, 200]);
  assert.equal(result.pageCount, 2);
});
```

- [ ] **Step 2: Run Binance tests and verify red**

Run: `node --import tsx --test test/binance/client.test.ts test/binance/adapter.test.ts`

Expected: FAIL because `BinanceVenueAdapter` does not exist.

- [ ] **Step 3: Add a non-breaking per-market history method to the existing client**

Keep the existing Zod schemas and hardened retry/timeout behavior. Extract the current inclusive history loop into a private helper that accepts an optional symbol, retain the current all-symbol method, and add:

```ts
async getFundingHistoryForMarket(
  symbol: string,
  startTime: number,
  endTime: number
): Promise<{ records: FundingHistoryRecord[]; pageCount: number }> {
  return this.getFundingHistoryPages(startTime, endTime, symbol);
}
```

Add a regression test that the legacy all-symbol method omits `symbol` and the new method includes `symbol=BTCUSDT` on every page.

- [ ] **Step 4: Implement the common adapter as a wrapper around the proven client**

Create `src/binance/adapter.ts`. Its constructor accepts `BinanceClientOptions` and constructs a private client. `getCurrentSnapshot()` requests server time, exchange info, premium index, and funding info; filters `TRADING + PERPETUAL + USDT`; defaults missing interval overrides to 8; and fails if any eligible market lacks a valid premium row.

`getFundingHistory(request)` calls `getFundingHistoryForMarket`, keeps only `rateType = Regular`, and returns common settlements with `completeFrom = request.startTime`.

The wrapper begins:

```ts
export class BinanceVenueAdapter implements FundingVenueAdapter {
  readonly id = 'binance' as const;
  private readonly client: BinanceClient;

  constructor(options: BinanceClientOptions) {
    this.client = new BinanceClient(options);
  }
}
```

Use this construction for every returned settlement:

```ts
{
  venue: this.id,
  marketId: record.symbol,
  fundingRate: record.fundingRate,
  fundingTime: record.fundingTime
}
```

- [ ] **Step 5: Run Binance and shared infrastructure tests, then commit**

Run: `node --import tsx --test test/binance/client.test.ts test/binance/adapter.test.ts test/exchanges/*.test.ts`

Run: `npm run typecheck`

Expected: PASS.

Commit:

```bash
git add src/binance/adapter.ts src/binance/client.ts src/binance/schemas.ts test/binance/client.test.ts test/binance/adapter.test.ts
git commit -m "refactor: expose Binance through venue adapter"
```

---

### Task 4: OKX Funding Adapter

**Files:**
- Create: `src/okx/schemas.ts`
- Create: `src/okx/client.ts`
- Create: `test/okx/client.test.ts`

**Interfaces:**
- Consumes: common adapter contracts and shared HTTP/concurrency infrastructure.
- Produces: `OkxClient implements FundingVenueAdapter` with `id = 'okx'`.

- [ ] **Step 1: Write failing OKX market, interval, pagination, and error tests**

Create `test/okx/client.test.ts` with a two-market instruments response and assert:

```ts
test('keeps live USDT swaps and derives the actual current funding interval', async () => {
  const client = new OkxClient({
    baseUrl: new URL('https://www.okx.com'),
    fetch: queuedFetch([
      jsonResponse({ code: '0', msg: '', data: [
        { instId: 'BTC-USDT-SWAP', instType: 'SWAP', baseCcy: 'BTC', quoteCcy: 'USDT', settleCcy: 'USDT', state: 'live', listTime: String(AS_OF - DAY) },
        { instId: 'ETH-USDC-SWAP', instType: 'SWAP', baseCcy: 'ETH', quoteCcy: 'USDC', settleCcy: 'USDC', state: 'live', listTime: String(AS_OF - DAY) }
      ] }),
      jsonResponse({ code: '0', msg: '', data: [{
        instId: 'BTC-USDT-SWAP', fundingRate: '0.0003', fundingTime: String(AS_OF + 2 * HOUR), nextFundingTime: String(AS_OF + 6 * HOUR)
      }] })
    ], []),
    now: () => AS_OF,
    sleep: async () => {}
  });
  const snapshot = await client.getCurrentSnapshot();
  assert.equal(snapshot.markets.length, 1);
  assert.equal(snapshot.markets[0]!.intervalHours, 4);
  assert.equal(snapshot.markets[0]!.nextFundingTime, AS_OF + 2 * HOUR);
});
```

Also test:

- non-`0` OKX `code` throws `VenueRequestError` even on HTTP 200;
- empty Funding data for a live swap fails the whole snapshot;
- history uses `realizedRate`, filters `(startTime, endTime]`, deduplicates timestamps, follows `before/after` pagination without stalling, and returns `completeFrom = startTime`;
- the per-market current requests never exceed the configured concurrency and retain instrument order.

- [ ] **Step 2: Run OKX tests and verify red**

Run: `node --import tsx --test test/okx/client.test.ts`

Expected: FAIL because the OKX modules do not exist.

- [ ] **Step 3: Define strict OKX response schemas**

Create `src/okx/schemas.ts` with Zod schemas for:

```ts
const okxEnvelope = <T extends z.ZodTypeAny>(data: T) => z.object({
  code: z.string(),
  msg: z.string(),
  data: z.array(data)
});

export const okxInstrumentSchema = z.object({
  instId: z.string(), instType: z.string(), baseCcy: z.string(), quoteCcy: z.string(),
  settleCcy: z.string(), state: z.string(), listTime: z.string()
});

export const okxCurrentFundingSchema = z.object({
  instId: z.string(), fundingRate: z.string(), fundingTime: z.string(), nextFundingTime: z.string()
});

export const okxHistorySchema = z.object({
  instId: z.string(), realizedRate: z.string(), fundingTime: z.string()
});
```

Export complete envelope schemas and validate `code === '0'` in `OkxClient.parseEnvelope` so business errors cannot pass as empty data.

- [ ] **Step 4: Implement paced current joins and realized history**

Create `OkxClient` with `PublicJsonClient({ venue: 'okx', minRequestIntervalMs: 110 })` and injected `currentConcurrency` defaulting to 4. `getCurrentSnapshot()` must:

1. Read `/api/v5/public/instruments?instType=SWAP`.
2. Filter `instType = SWAP`, `state = live`, `quoteCcy = USDT`, and `settleCcy = USDT`.
3. Use `mapWithConcurrency` to call `/api/v5/public/funding-rate` for every eligible `instId`.
4. Treat `fundingRate` as the estimate for the settlement at `fundingTime`.
5. Derive `intervalHours = (nextFundingTime - fundingTime) / HOUR_MS`, require a positive integer, and store `nextFundingTime = fundingTime`.
6. Fail if any eligible instrument has missing or duplicate current data.

`getFundingHistory()` must call `/api/v5/public/funding-rate-history`, use `realizedRate`, deduplicate by `instId + fundingTime`, and stop when the oldest returned timestamp reaches the requested start or a page is shorter than the limit.

- [ ] **Step 5: Run OKX, shared, and type tests, then commit**

Run: `node --import tsx --test test/okx/client.test.ts test/exchanges/*.test.ts`

Run: `npm run typecheck`

Expected: PASS.

Commit:

```bash
git add src/okx/client.ts src/okx/schemas.ts test/okx/client.test.ts
git commit -m "feat: add OKX funding adapter"
```

---

### Task 5: Hyperliquid Funding Adapter

**Files:**
- Create: `src/hyperliquid/schemas.ts`
- Create: `src/hyperliquid/client.ts`
- Create: `test/hyperliquid/client.test.ts`

**Interfaces:**
- Consumes: common adapter contracts and shared POST JSON infrastructure.
- Produces: `HyperliquidClient implements FundingVenueAdapter` with `id = 'hyperliquid'`.

- [ ] **Step 1: Write failing tuple-join, hourly-Funding, and history tests**

Create `test/hyperliquid/client.test.ts`:

```ts
test('joins main-dex metadata and contexts by index and emits hourly funding', async () => {
  const client = new HyperliquidClient({
    baseUrl: new URL('https://api.hyperliquid.xyz'),
    fetch: queuedFetch([jsonResponse([
      { universe: [{ name: 'BTC', szDecimals: 5, maxLeverage: 40 }, { name: 'DELISTED', szDecimals: 2, maxLeverage: 3, isDelisted: true }] },
      [{ funding: '0.00001', openInterest: '1', markPx: '100000' }, { funding: '0', openInterest: '0', markPx: null }]
    ])], []),
    now: () => AS_OF
  });
  const snapshot = await client.getCurrentSnapshot();
  assert.deepEqual(snapshot.markets, [{
    venue: 'hyperliquid', marketId: 'BTC', rawBaseAsset: 'BTC', quoteAsset: 'USD', settleAsset: 'USDC',
    nextFundingRate: '0.00001', intervalHours: 1, nextFundingTime: AS_OF + HOUR
  }]);
});

test('rejects metadata/context length mismatch instead of shifting assets', async () => {
  const client = new HyperliquidClient({
    baseUrl: new URL('https://api.hyperliquid.xyz'),
    fetch: queuedFetch([jsonResponse([{ universe: [{ name: 'BTC', szDecimals: 5, maxLeverage: 40 }] }, []])], [])
  });
  await assert.rejects(client.getCurrentSnapshot(), /Hyperliquid metadata and context lengths differ/);
});

test('reads historical hourly settlements from fundingHistory', async () => {
  const seen: SeenRequest[] = [];
  const client = new HyperliquidClient({
    baseUrl: new URL('https://api.hyperliquid.xyz'),
    fetch: queuedFetch([jsonResponse([
      { coin: 'BTC', fundingRate: '0.00001', premium: '0.00002', time: AS_OF - HOUR },
      { coin: 'BTC', fundingRate: '0.00002', premium: '0.00003', time: AS_OF }
    ])], seen)
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
```

Also assert that blank/non-finite Funding, duplicate asset names, an empty active universe, and a response with more than 500 history rows are rejected or paginated without loss.

- [ ] **Step 2: Run Hyperliquid tests and verify red**

Run: `node --import tsx --test test/hyperliquid/client.test.ts`

Expected: FAIL because the Hyperliquid modules do not exist.

- [ ] **Step 3: Define the exact tuple and history schemas**

Create `src/hyperliquid/schemas.ts`:

```ts
export const hyperMetaSchema = z.object({
  universe: z.array(z.object({
    name: z.string(),
    szDecimals: z.number().int().nonnegative(),
    maxLeverage: z.number().positive(),
    isDelisted: z.boolean().optional().default(false)
  }))
});

export const hyperContextSchema = z.object({
  funding: z.string(),
  openInterest: z.string(),
  markPx: z.string().nullable().optional()
});

export const hyperMetaAndContextsSchema = z.tuple([
  hyperMetaSchema,
  z.array(hyperContextSchema)
]);

export const hyperFundingHistorySchema = z.array(z.object({
  coin: z.string(), fundingRate: z.string(), premium: z.string(), time: z.number().finite()
}));
```

- [ ] **Step 4: Implement the main Perp DEX adapter**

`getCurrentSnapshot()` posts `{ type: 'metaAndAssetCtxs' }`, checks equal tuple lengths, skips only `isDelisted = true`, requires finite decimal Funding, and calculates the next top-of-hour boundary:

```ts
const nextFundingTime = Math.floor(observedAt / HOUR_MS) * HOUR_MS + HOUR_MS;
```

Do not send a `dex` field; omission selects the first-party main Perp DEX. Return `quoteAsset = 'USD'`, `settleAsset = 'USDC'`, and `intervalHours = 1`.

`getFundingHistory()` posts `fundingHistory` with the requested coin and window. Hyperliquid returns at most 500 records, so paginate by setting the next `startTime` to the last returned `time`; deduplicate the inclusive boundary and fail if a full page adds no record or does not advance time.

- [ ] **Step 5: Run Hyperliquid and shared tests, then commit**

Run: `node --import tsx --test test/hyperliquid/client.test.ts test/exchanges/*.test.ts`

Run: `npm run typecheck`

Expected: PASS.

Commit:

```bash
git add src/hyperliquid/client.ts src/hyperliquid/schemas.ts test/hyperliquid/client.test.ts
git commit -m "feat: add Hyperliquid funding adapter"
```

---

### Task 6: Bybit Funding Adapter

**Files:**
- Create: `src/bybit/schemas.ts`
- Create: `src/bybit/client.ts`
- Create: `test/bybit/client.test.ts`

**Interfaces:**
- Consumes: common adapter contracts, GET JSON, and bounded concurrency.
- Produces: `BybitClient implements FundingVenueAdapter` with `id = 'bybit'`.

- [ ] **Step 1: Write failing cursor, market-filter, period, and history tests**

Create `test/bybit/client.test.ts` and cover a two-page instruments response:

```ts
test('paginates instruments, keeps Trading USDT linear perpetuals, and joins all tickers', async () => {
  const seen: SeenRequest[] = [];
  const client = new BybitClient({
    baseUrl: new URL('https://api.bybit.com'),
    fetch: queuedFetch([
      jsonResponse({ retCode: 0, retMsg: 'OK', result: { list: [{
        symbol: 'BTCUSDT', contractType: 'LinearPerpetual', status: 'Trading', baseCoin: 'BTC', quoteCoin: 'USDT', settleCoin: 'USDT',
        launchTime: String(AS_OF - DAY), fundingInterval: 480
      }], nextPageCursor: 'page-2' }, time: AS_OF }),
      jsonResponse({ retCode: 0, retMsg: 'OK', result: { list: [{
        symbol: 'ETHUSDC', contractType: 'LinearPerpetual', status: 'Trading', baseCoin: 'ETH', quoteCoin: 'USDC', settleCoin: 'USDC',
        launchTime: String(AS_OF - DAY), fundingInterval: 480
      }], nextPageCursor: '' }, time: AS_OF }),
      jsonResponse({ retCode: 0, retMsg: 'OK', result: { category: 'linear', list: [{
        symbol: 'BTCUSDT', fundingRate: '0.0002', nextFundingTime: String(AS_OF + 8 * HOUR), fundingIntervalHour: '8'
      }] }, time: AS_OF })
    ], seen),
    now: () => AS_OF
  });
  const snapshot = await client.getCurrentSnapshot();
  assert.equal(snapshot.markets.length, 1);
  assert.equal(snapshot.markets[0]!.marketId, 'BTCUSDT');
  assert.deepEqual(seen.slice(0, 2).map(({ url }) => url.searchParams.get('cursor')), [null, 'page-2']);
});
```

Also test:

- `retCode !== 0` throws even with HTTP 200;
- a non-empty repeated cursor fails with `Bybit instruments pagination stalled`;
- current ticker interval must equal instruments `fundingInterval / 60` when both are present;
- missing ticker for any eligible contract fails the snapshot;
- `/v5/market/funding/history` returns reverse chronological records that are filtered, sorted ascending, and deduplicated;
- 1-hour seven-day history fits the documented 200-record limit and sends `startTime`, `endTime`, and `limit=200`.

- [ ] **Step 2: Run Bybit tests and verify red**

Run: `node --import tsx --test test/bybit/client.test.ts`

Expected: FAIL because the Bybit modules do not exist.

- [ ] **Step 3: Define strict Bybit envelopes and pagination fields**

Create `src/bybit/schemas.ts` with a reusable envelope:

```ts
const bybitEnvelope = <T extends z.ZodTypeAny>(result: T) => z.object({
  retCode: z.number().int(), retMsg: z.string(), result, time: z.number().finite()
});
```

Define instrument fields exactly as exercised above, ticker Funding fields as strings, and history fields `symbol`, `fundingRate`, and `fundingRateTimestamp`. Preserve `nextPageCursor` as a string and reject missing result objects.

- [ ] **Step 4: Implement instruments pagination, full ticker join, and selected history**

Create `BybitClient` with `PublicJsonClient({ venue: 'bybit', minRequestIntervalMs: 55 })`. `getCurrentSnapshot()` must page `/v5/market/instruments-info?category=linear&limit=1000`, filter the approved market set, then make one `/v5/market/tickers?category=linear` request and join by symbol. Prefer ticker `fundingIntervalHour`; require it to match instrument minutes if both are supplied.

`getFundingHistory()` calls `/v5/market/funding/history` with the selected symbol and full seven-day window. Sort ascending and return `completeFrom = startTime`; reject more than 200 distinct records because that contradicts a supported 1-hour minimum interval over seven days.

- [ ] **Step 5: Run Bybit and shared tests, then commit**

Run: `node --import tsx --test test/bybit/client.test.ts test/exchanges/*.test.ts`

Run: `npm run typecheck`

Expected: PASS.

Commit:

```bash
git add src/bybit/client.ts src/bybit/schemas.ts test/bybit/client.test.ts
git commit -m "feat: add Bybit funding adapter"
```

---

### Task 7: Bitget Funding Adapter

**Files:**
- Create: `src/bitget/schemas.ts`
- Create: `src/bitget/client.ts`
- Create: `test/bitget/client.test.ts`

**Interfaces:**
- Consumes: common adapter contracts, GET JSON, and bounded concurrency.
- Produces: `BitgetClient implements FundingVenueAdapter` with `id = 'bitget'`.

- [ ] **Step 1: Write failing Bitget envelope, market, interval, and history-page tests**

Create `test/bitget/client.test.ts`:

```ts
test('joins normal USDT contracts to current Funding and its 1/2/4/8-hour interval', async () => {
  const client = new BitgetClient({
    baseUrl: new URL('https://api.bitget.com'),
    fetch: queuedFetch([
      jsonResponse({ code: '00000', msg: 'success', requestTime: AS_OF, data: [
        { symbol: 'BTCUSDT', baseCoin: 'BTC', quoteCoin: 'USDT', symbolStatus: 'normal', launchTime: String(AS_OF - DAY) },
        { symbol: 'ETHUSDC', baseCoin: 'ETH', quoteCoin: 'USDC', symbolStatus: 'normal', launchTime: String(AS_OF - DAY) }
      ] }),
      jsonResponse({ code: '00000', msg: 'success', requestTime: AS_OF, data: [{
        symbol: 'BTCUSDT', fundingRate: '0.0004', fundingRateInterval: '2', nextUpdate: String(AS_OF + 2 * HOUR),
        minFundingRate: '-0.003', maxFundingRate: '0.003', cashDividend: '0', cashDividendNextUpdate: '0'
      }] })
    ], []),
    now: () => AS_OF
  });
  const snapshot = await client.getCurrentSnapshot();
  assert.equal(snapshot.markets.length, 1);
  assert.equal(snapshot.markets[0]!.intervalHours, 2);
});
```

Also test:

- `code !== '00000'` throws on HTTP 200;
- `fundingRateInterval` outside `1|2|4|8` fails validation;
- any eligible contract missing from the current-Funding response fails the snapshot;
- history requests `symbol`, `productType=usdt-futures`, `pageSize=100`, and increasing `pageNo`;
- 168 hourly rows over two pages are returned once, in ascending time order;
- a full duplicate page or repeated page content fails instead of looping.

- [ ] **Step 2: Run Bitget tests and verify red**

Run: `node --import tsx --test test/bitget/client.test.ts`

Expected: FAIL because the Bitget modules do not exist.

- [ ] **Step 3: Define V2/V3 envelope schemas with string-number validation**

Create `src/bitget/schemas.ts` with shared `code`, `msg`, and `requestTime`, plus contract, current Funding, and history data schemas. Keep numeric API values as strings until the adapter validates them; define `fundingRateInterval` as `z.enum(['1', '2', '4', '8'])`.

- [ ] **Step 4: Implement full current join and numbered history pagination**

Create `BitgetClient` with `PublicJsonClient({ venue: 'bitget', minRequestIntervalMs: 55 })`:

- Read contracts from `/api/v2/mix/market/contracts?productType=usdt-futures`.
- Read all USDT current rates from `/api/v3/market/current-fund-rate?category=USDT-FUTURES`.
- Filter `symbolStatus = normal`, `quoteCoin = USDT`, and reject missing/duplicate joins.
- Store `nextUpdate` as `nextFundingTime` and the enumerated hours as `intervalHours`.
- Read selected history from `/api/v2/mix/market/history-fund-rate`, advancing `pageNo` until a short page, deduplicating by symbol/time, and failing if a full page adds no key.

- [ ] **Step 5: Run Bitget and shared tests, then commit**

Run: `node --import tsx --test test/bitget/client.test.ts test/exchanges/*.test.ts`

Run: `npm run typecheck`

Expected: PASS.

Commit:

```bash
git add src/bitget/client.ts src/bitget/schemas.ts test/bitget/client.test.ts
git commit -m "feat: add Bitget funding adapter"
```

---

### Task 8: Equal-Weight Composite Ranking

**Files:**
- Create: `src/funding/composite.ts`
- Create: `test/funding/composite.test.ts`

**Interfaces:**
- Consumes: all Task 1 snapshot and leaderboard types plus `normalizeAsset`.
- Produces: `buildCompositeFundingLeaderboard(input: { asOf: number; snapshots: VenueSnapshot[] }): CompositeFundingLeaderboard`.
- Produces rows whose seven-day fields are `null`; Task 9 fills them without changing rank.

- [ ] **Step 1: Write failing APR, coverage, duplicate, sorting, and completeness tests**

Create `test/funding/composite.test.ts` with venue-neutral cases. The primary test must prove raw-rate averaging would be wrong:

```ts
test('normalizes interval APR before equal-weighting two to five valid venues', () => {
  const snapshots = [
    venueSnapshot('binance', [venueMarket('binance', 'BTC', '0.0008', 8)]),
    venueSnapshot('okx', [venueMarket('okx', 'BTC', '0.0001', 1)]),
    venueSnapshot('hyperliquid', [venueMarket('hyperliquid', 'BTC', '0.0001', 1)]),
    venueSnapshot('bybit', []),
    venueSnapshot('bitget', [])
  ];
  const extraAssets = Array.from({ length: 19 }, (_, index) => `ASSET${index + 1}`);
  for (const asset of extraAssets) {
    snapshots[0]!.markets.push(venueMarket('binance', asset, '0.00001', 8));
    snapshots[1]!.markets.push(venueMarket('okx', asset, '0.00001', 8));
  }
  const leaderboard = buildCompositeFundingLeaderboard({ asOf: AS_OF, snapshots });
  const btc = leaderboard.rows[0]!;
  assert.equal(btc.asset, 'BTC');
  assert.equal(btc.coverageCount, 3);
  assert.equal(btc.venues.binance!.nextApr.toString(), '0.876');
  assert.equal(btc.venues.okx!.nextApr.toString(), '0.876');
  assert.equal(btc.compositeNextApr.toString(), '0.876');
});
```

Add separate tests that assert:

- `1000PEPE` and `kPEPE` merge under `PEPE` while unknown numeric prefixes do not;
- one-venue assets are excluded and missing venues do not contribute zero;
- a duplicate normalized asset on one venue throws rather than double-weights;
- exactly five unique venue snapshots are required and each `snapshot.venue` matches its markets;
- invalid decimal rates, non-positive intervals, and next-settlement times not after `observedAt` throw;
- fewer than 20 candidates throws;
- ordering is composite APR descending, coverage descending, asset ascending;
- signed negatives are retained at the tail when fewer than 20 positive candidates exist;
- every returned row has rank 1–20 and exactly `coverageCount` venue values.

- [ ] **Step 2: Run aggregate tests and verify red**

Run: `node --import tsx --test test/funding/composite.test.ts`

Expected: FAIL because the current function only understands Binance 24-hour totals.

- [ ] **Step 3: Implement snapshot completeness and per-venue normalization**

Start `src/funding/composite.ts` with:

```ts
const DAYS_PER_YEAR = new Decimal(365);

function nextApr(rate: Decimal, intervalHours: number): Decimal {
  if (!Number.isFinite(intervalHours) || intervalHours <= 0) {
    throw new Error('Funding interval must be positive');
  }
  return rate.times(24).div(intervalHours).times(DAYS_PER_YEAR);
}

function requireCompleteSnapshots(snapshots: VenueSnapshot[]): Record<VenueId, VenueSnapshot> {
  const byVenue = new Map(snapshots.map((snapshot) => [snapshot.venue, snapshot]));
  if (byVenue.size !== VENUE_IDS.length || VENUE_IDS.some((venue) => !byVenue.has(venue))) {
    throw new Error('Funding leaderboard requires one snapshot from every venue');
  }
  return Object.fromEntries(VENUE_IDS.map((venue) => [venue, byVenue.get(venue)!])) as Record<VenueId, VenueSnapshot>;
}
```

Parse every rate through `new Decimal(value)` inside a venue/market-aware error boundary; require finite values, market venue consistency, and a future `nextFundingTime` relative to the snapshot observation time.

- [ ] **Step 4: Group, equal-weight, stably sort, and validate Top20**

For every snapshot market, normalize the asset, reject a second market from the same venue under the same normalized ID, compute `nextApr`, and initialize seven-day values to `null`/`false`. Drop groups with coverage below 2. Calculate:

```ts
const compositeNextApr = Object.values(venues)
  .reduce((sum, metric) => sum.plus(metric!.nextApr), new Decimal(0))
  .div(coverageCount);
```

Sort by `compositeNextApr` descending, then `coverageCount` descending, then asset ascending. Require at least 20 candidates, slice 20, assign ranks, and revalidate non-increasing ordering including tie rules before returning all five `venueStats`.

- [ ] **Step 5: Run aggregate tests and commit**

Run: `node --import tsx --test test/funding/composite.test.ts test/exchanges/normalize.test.ts`

Run: `npm run typecheck`

Expected: PASS.

Commit:

```bash
git add src/funding/composite.ts test/funding/composite.test.ts
git commit -m "feat: rank equal-weight multi-venue funding"
```

---

### Task 9: Selected Top20 Seven-Day History Hydration

**Files:**
- Create: `src/funding/history.ts`
- Create: `test/funding/history.test.ts`

**Interfaces:**
- Consumes: ranked `CompositeFundingLeaderboard` from Task 8 and `Record<VenueId, FundingVenueAdapter>`.
- Produces: `hydrateSevenDayFunding(input): Promise<HistoryHydrationResult>`.
- Produces: `HistoryHydrationResult = { leaderboard, venueStats }`, where each venue stat contains `requestCount`, `pageCount`, and `recordCount`.

- [ ] **Step 1: Write failing full-window, partial-window, missing, and call-scope tests**

Create `test/funding/history.test.ts`. Build a 20-row leaderboard from Task 8, then use fake adapters that record history requests:

```ts
test('requests history only for venues present on the selected Top20', async () => {
  const leaderboard = rankedLeaderboardWithTwoVenuesPerRow();
  const calls: Array<{ venue: VenueId; marketId: string }> = [];
  const adapters = fakeAdapters(async (request) => {
    calls.push({ venue: request.market.venue, marketId: request.market.marketId });
    return {
      records: [
        settlement(request.market.venue, request.market.marketId, '0.0001', AS_OF - 6 * DAY),
        settlement(request.market.venue, request.market.marketId, '0.0002', AS_OF)
      ],
      requestCount: 1,
      pageCount: 1,
      completeFrom: AS_OF - 7 * DAY
    };
  });
  const result = await hydrateSevenDayFunding({ asOf: AS_OF, leaderboard, adapters, concurrency: 5 });
  assert.equal(calls.length, 40);
  assert.equal(calls.some(({ venue }) => venue === 'hyperliquid'), false);
  assert.equal(result.leaderboard.rows[0]!.venues.binance!.sevenDayAverageDailyRate!.toString(), new Decimal('0.0003').div(7).toString());
  assert.equal(result.leaderboard.rows[0]!.venues.binance!.sevenDayApr!.toString(), new Decimal('0.0003').div(7).times(365).toString());
});
```

Add separate tests that assert:

- window boundaries are `(asOf - 7d, asOf]`;
- duplicate records at inclusive page boundaries count once;
- records for a different venue or market fail validation;
- `completeFrom > startTime` for an old market fails rather than silently shortening history;
- a market listed 3.5 days ago divides the sum by 3.5, marks `partialSevenDayHistory = true`, and appends `*` in display tasks;
- a new market with less than one full interval and no settlement returns `sevenDayAverageDailyRate = null`, `sevenDayApr = null`, and `partialSevenDayHistory = true`;
- an old market with at least one expected interval and no settlement throws `Missing settled Funding history`;
- rank, composite APR, coverage count, and next-Funding metrics remain unchanged;
- adapter rejection propagates and no partial leaderboard is returned.

- [ ] **Step 2: Run history tests and verify red**

Run: `node --import tsx --test test/funding/history.test.ts`

Expected: FAIL because the history hydrator does not exist.

- [ ] **Step 3: Implement deterministic window aggregation**

Create `src/funding/history.ts` with:

```ts
const DAY_MS = 24 * 60 * 60 * 1_000;
const WINDOW_MS = 7 * DAY_MS;

export interface HistoryHydrationVenueStats {
  requestCount: number;
  pageCount: number;
  recordCount: number;
}

export interface HistoryHydrationResult {
  leaderboard: CompositeFundingLeaderboard;
  venueStats: Record<VenueId, HistoryHydrationVenueStats>;
}

export async function hydrateSevenDayFunding(input: {
  asOf: number;
  leaderboard: CompositeFundingLeaderboard;
  adapters: Record<VenueId, FundingVenueAdapter>;
  concurrency?: number;
}): Promise<HistoryHydrationResult>;
```

Create one work item for every venue metric actually present in the 20 rows, then invoke the matching adapter with the exact seven-day window:

```ts
const workItems = input.leaderboard.rows.flatMap((row, rowIndex) =>
  VENUE_IDS.flatMap((venue) => {
    const metric = row.venues[venue];
    return metric === undefined ? [] : [{ rowIndex, venue, metric }];
  })
);
const historyResults = await mapWithConcurrency(
  workItems,
  input.concurrency ?? 10,
  async ({ rowIndex, venue, metric }) => ({
    rowIndex,
    venue,
    metric,
    history: await input.adapters[venue].getFundingHistory({
      market: {
        venue,
        marketId: metric.marketId,
        rawBaseAsset: input.leaderboard.rows[rowIndex]!.asset,
        quoteAsset: venue === 'hyperliquid' ? 'USD' : 'USDT',
        settleAsset: venue === 'hyperliquid' ? 'USDC' : 'USDT',
        nextFundingRate: metric.nextFundingRate.toString(),
        intervalHours: metric.intervalHours,
        nextFundingTime: metric.nextFundingTime,
        ...(metric.listedAt === undefined ? {} : { listedAt: metric.listedAt })
      },
      startTime: input.asOf - WINDOW_MS + 1,
      endTime: input.asOf
    })
  })
);
```

- [ ] **Step 4: Validate coverage and attach immutable history metrics**

For each result:

1. Require all records to match the requested venue and market.
2. Filter `(asOf - 7d, asOf]`, sort ascending, and deduplicate by venue/market/time.
3. Define `windowStartExclusive = asOf - 7d` and `requestedStart = windowStartExclusive + 1`. Determine the duration anchor `coverageStart` as `max(windowStartExclusive, listedAt)` when `listedAt` exists; otherwise infer `max(windowStartExclusive, earliestFundingTime - intervalMs)`.
4. If `completeFrom > requestedStart`, throw an incomplete-history error.
5. If coverage is shorter than one full interval and there are no records, attach null seven-day values and mark partial.
6. If coverage includes a full interval and there are no records, throw `Missing settled Funding history for <venue>:<marketId>`.
7. Calculate `coverageDays = (asOf - coverageStart) / DAY_MS`, `averageDaily = sum / coverageDays`, and `sevenDayApr = averageDaily * 365`.
8. Clone the row and metric; never mutate the input leaderboard.

Aggregate request/page/record totals into a preinitialized five-venue stats record so venues with no selected markets report zeros.

- [ ] **Step 5: Run funding tests and commit**

Run: `node --import tsx --test test/funding/*.test.ts`

Run: `npm run typecheck`

Expected: PASS.

Commit:

```bash
git add src/funding/history.ts test/funding/history.test.ts
git commit -m "feat: hydrate Top20 seven-day funding history"
```

---

### Task 10: Multi-Venue Text and Google Chat Cards

**Files:**
- Create: `src/funding/multi-venue-format.ts`
- Create: `src/chat/multi-venue-cards.ts`
- Create: `test/funding/multi-venue-format.test.ts`
- Create: `test/chat/multi-venue-cards.test.ts`

**Interfaces:**
- Consumes: hydrated `CompositeFundingLeaderboard` with null values only for genuinely too-new markets.
- Produces: `renderLeaderboardText(leaderboard)` and `buildFundingChatMessage(leaderboard)`.

- [ ] **Step 1: Write failing five-venue display and payload-boundary tests**

Build fixtures with one full-coverage row, one 2/5 row, positive/negative/zero values, and a partial-history marker. Assert the first asset block contains:

```text
#1 BTC｜综合预估 APR +12.35%｜覆盖 5/5
Bn 下次 +0.0100%/8h (+10.95%)｜7日均 +0.0240%/日 (+8.76%)
OKX 下次 +0.0120%/8h (+13.14%)｜7日均 +0.0260%/日 (+9.49%)
Hyper 下次 +0.0015%/1h (+13.14%)｜7日均 +0.0230%/日 (+8.40%)
Bybit 下次 +0.0090%/8h (+9.86%)｜7日均 +0.0220%/日 (+8.03%)
Bitget 下次 +0.0135%/8h (+14.78%)｜7日均 +0.0250%/日 (+9.13%)
```

In `test/chat/multi-venue-cards.test.ts`, assert:

- fallback text says `五交易所 Funding Top20`;
- exactly two cards use IDs `funding-top20-1-10` and `funding-top20-11-20`;
- ranks 1–20 occur exactly once;
- every asset block contains the five display labels in `VENUE_IDS` order;
- absent venue metrics render `下次 --｜7日均 --`;
- positive values include a visible `+` and red `#D93025`, negative values use green `#188038`, and numeric zero has no sign/color;
- current estimates say `下次` and the footnote says `下一次为当前预估`;
- HTML-sensitive asset IDs are escaped;
- 31,999 UTF-8 bytes are accepted and exactly 32,000 are rejected;
- a payload overflow throws without dropping a venue or row.

- [ ] **Step 2: Run format/card tests and verify red**

Run: `node --import tsx --test test/funding/multi-venue-format.test.ts test/chat/multi-venue-cards.test.ts`

Expected: FAIL because the renderers expect Binance-only row fields.

- [ ] **Step 3: Implement signed compact format helpers**

Keep `formatFundingPercent` and `formatAprPercent`, and add:

```ts
export const VENUE_LABELS: Record<VenueId, string> = {
  binance: 'Bn', okx: 'OKX', hyperliquid: 'Hyper', bybit: 'Bybit', bitget: 'Bitget'
};

export function signedFundingPercent(value: Decimal): string {
  const formatted = formatFundingPercent(value);
  return value.gt(0) ? `+${formatted}` : formatted;
}

export function signedAprPercent(value: Decimal): string {
  const formatted = formatAprPercent(value);
  return value.gt(0) ? `+${formatted}` : formatted;
}
```

Render each venue line from its metric; use `%/日` for seven-day average; append `*` only when `partialSevenDayHistory`; use `--` for both null history values and absent venues. Render console output in the same venue order as cards.

- [ ] **Step 4: Build compact one-widget-per-asset cards**

Replace the old two-column Binance row with one `textParagraph` per asset plus dividers. The paragraph starts with bold rank/asset, composite APR, and `覆盖 n/5`, then five `<br>` venue lines. Reuse HTML escaping for every dynamic string and color the numeric values, not labels.

Each card begins with `按有效平台的下一次 Funding APR 等权平均排序。` and ends with:

```text
Funding 为正表示多头支付空头。<br>下一次为当前预估；括号内为 APR。<br>* 表示该平台历史不足 7 日。
```

Construct the message, calculate `Buffer.byteLength(JSON.stringify(message), 'utf8')`, and throw at `>= 32_000`.

- [ ] **Step 5: Run display tests and commit**

Run: `node --import tsx --test test/funding/multi-venue-format.test.ts test/chat/multi-venue-cards.test.ts`

Run: `npm run typecheck`

Expected: PASS.

Commit:

```bash
git add src/funding/multi-venue-format.ts src/chat/multi-venue-cards.ts test/funding/multi-venue-format.test.ts test/chat/multi-venue-cards.test.ts
git commit -m "feat: render five-venue Funding Top20 cards"
```

---

### Task 11: Five-Venue Configuration, App Assembly, and Job Transaction

**Files:**
- Modify: `src/domain.ts`
- Modify: `src/config.ts`
- Modify: `src/app.ts`
- Modify: `src/job.ts`
- Modify: `test/config.test.ts`
- Modify: `test/job.test.ts`
- Delete: `src/funding/aggregate.ts`
- Delete: `src/funding/format.ts`
- Delete: `src/chat/cards.ts`
- Delete: `test/funding/aggregate.test.ts`
- Delete: `test/funding/format.test.ts`
- Delete: `test/chat/cards.test.ts`

**Interfaces:**
- Consumes: all five adapters, `buildCompositeFundingLeaderboard`, `hydrateSevenDayFunding`, card builder, state store, and Chat client.
- Produces: `FundingJobDeps.venues: Record<VenueId, FundingVenueAdapter>`.
- Produces: `AppConfig.exchangeBaseUrls` and `AppConfig.exchangeTimeoutMs`.

- [ ] **Step 1: Write failing config and app assembly tests**

Update `test/config.test.ts` to expect:

```ts
assert.deepEqual(Object.fromEntries(
  Object.entries(config.exchangeBaseUrls).map(([venue, url]) => [venue, url.origin])
), {
  binance: 'https://fapi.binance.com',
  okx: 'https://www.okx.com',
  hyperliquid: 'https://api.hyperliquid.xyz',
  bybit: 'https://api.bybit.com',
  bitget: 'https://api.bitget.com'
});
assert.equal(config.exchangeTimeoutMs, 10_000);
```

Update the app assembly test to assert:

```ts
assert.equal(app.venues.binance.constructor.name, 'BinanceVenueAdapter');
assert.equal(app.venues.okx.constructor.name, 'OkxClient');
assert.equal(app.venues.hyperliquid.constructor.name, 'HyperliquidClient');
assert.equal(app.venues.bybit.constructor.name, 'BybitClient');
assert.equal(app.venues.bitget.constructor.name, 'BitgetClient');
```

- [ ] **Step 2: Rewrite job tests around the two-phase data flow and verify red**

Replace the fake Binance dependency with five fake adapters. Assert exact stage ordering:

```ts
assert.equal(calls[0], 'state.read');
assert.deepEqual(
  calls.filter((call) => call.endsWith('.current')).sort(),
  ['binance.current', 'bitget.current', 'bybit.current', 'hyperliquid.current', 'okx.current']
);
assert.equal(calls.filter((call) => call.includes('.history:')).length, 100);
assert.deepEqual(calls.slice(-2), ['chat.send', 'state.write']);
```

Because current snapshots run concurrently, record per-phase sets rather than relying on completion order inside the current phase. Add tests that prove:

- duplicate slot exits before any venue request;
- dry-run skips state and Chat but fetches current snapshots and only selected history;
- any one venue current-snapshot rejection fails at `current-fetch` and does not send;
- fewer than 20 cross-venue candidates fails at `rank`;
- selected history rejection fails at `history-fetch`;
- payload overflow fails at `card-build`;
- Google Chat failure/timeout does not write state;
- successful send writes state after Chat and reports rowCount 20;
- the complete duplicate-check-through-send transaction remains protected by the existing cross-process run lock;
- logs contain per-venue market/current/history counts and stage durations but no response bodies or Webhook secrets.

- [ ] **Step 3: Add five immutable public base URLs to config and app**

Change `AppConfig` to:

```ts
export interface AppConfig {
  exchangeBaseUrls: Record<VenueId, URL>;
  googleChatWebhookUrl?: URL;
  stateFile: string;
  timezone: 'Asia/Shanghai';
  schedule: '5 0,8,16 * * *';
  catchUpWindowMs: number;
  exchangeTimeoutMs: number;
  chatTimeoutMs: number;
}
```

`loadConfig` must construct the five origins shown in Step 1; do not accept environment overrides in production configuration. `createApp` constructs `BinanceVenueAdapter`, `OkxClient`, `HyperliquidClient`, `BybitClient`, and `BitgetClient` with their matching URL and shared timeout, while preserving Chat, state, logger, and `Date.now` wiring.

- [ ] **Step 4: Implement current-rank-history-card-send orchestration**

Change `FundingJobDeps`:

```ts
export interface FundingJobDeps {
  venues: Record<VenueId, FundingVenueAdapter>;
  chat?: GoogleChatClient;
  state: FileRunStateStore;
  now: () => number;
  logger: Logger;
}
```

Inside the existing state transaction:

1. Keep duplicate checking unchanged.
2. Fetch `VENUE_IDS.map(id => deps.venues[id].getCurrentSnapshot())` concurrently.
3. Set `asOf = deps.now()` after all snapshots resolve.
4. Call `buildCompositeFundingLeaderboard({ asOf, snapshots })`.
5. Call `hydrateSevenDayFunding({ asOf, leaderboard, adapters: deps.venues })`.
6. Build the card with `buildFundingChatMessage` from `src/chat/multi-venue-cards.ts` and dry-run text with `renderLeaderboardText` from `src/funding/multi-venue-format.ts`.
7. Send Chat and commit state in the existing order.

Replace `data-fetch` with explicit stages `current-fetch`, `rank`, `history-fetch`, `card-build`, `webhook`, and `state-commit`. Categorize `VenueTimeoutError` as `${error.venue}-timeout` and other `VenueRequestError` as `${error.venue}-request`; retain existing Chat/state categories.

After all production and test imports use the multi-venue modules, delete the six legacy Binance-only aggregator/formatter/card files listed in this task and remove only the now-unused legacy `FundingRow` and `FundingLeaderboard` interfaces from `src/domain.ts`. Retain Binance API transport types still consumed by `BinanceClient`.

Operational completion logs must include:

```ts
{
  candidateCount,
  rowCount: 20,
  coverageCounts: { two, three, four, five },
  currentFetchDurationMs,
  rankDurationMs,
  historyFetchDurationMs,
  cardBuildDurationMs,
  webhookDurationMs,
  payloadBytes,
  venues: {
    binance: { marketCount, currentRequestCount, currentPageCount, historyRequestCount, historyPageCount, historyRecordCount },
    okx: { marketCount, currentRequestCount, currentPageCount, historyRequestCount, historyPageCount, historyRecordCount },
    hyperliquid: { marketCount, currentRequestCount, currentPageCount, historyRequestCount, historyPageCount, historyRecordCount },
    bybit: { marketCount, currentRequestCount, currentPageCount, historyRequestCount, historyPageCount, historyRecordCount },
    bitget: { marketCount, currentRequestCount, currentPageCount, historyRequestCount, historyPageCount, historyRecordCount }
  }
}
```

- [ ] **Step 5: Run config/job/app tests and commit**

Run: `node --import tsx --test test/config.test.ts test/job.test.ts`

Run: `npm run typecheck`

Expected: PASS.

Commit:

```bash
git add src/domain.ts src/config.ts src/app.ts src/job.ts src/funding/aggregate.ts src/funding/format.ts src/chat/cards.ts test/config.test.ts test/job.test.ts test/funding/aggregate.test.ts test/funding/format.test.ts test/chat/cards.test.ts
git commit -m "feat: orchestrate five-venue funding job"
```

---

### Task 12: End-to-End HTTP Flow, Runbook, and Final Verification

**Files:**
- Replace: `test/e2e/job-http.test.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: the production clients, job, Chat client, state store, and CLI.
- Produces: one local-server E2E proof and an operator-ready five-venue runbook.

- [ ] **Step 1: Write a failing local HTTP E2E covering all five adapters**

Replace `test/e2e/job-http.test.ts` with a local `node:http` server that serves:

- Binance time, exchange info, premium index, funding info, and per-symbol history routes.
- OKX instruments, per-instrument current Funding, and per-instrument history routes.
- Hyperliquid `metaAndAssetCtxs` and `fundingHistory` POST bodies.
- Bybit instruments, tickers, and per-symbol history routes.
- Bitget contracts, current Funding, and numbered per-symbol history routes.
- `/webhook`, recording the posted `GoogleChatMessage`.

Generate 20 shared assets with monotonically decreasing composite APR. The test must assert:

```ts
assert.deepEqual(result, { status: 'sent', slot: slot.key, rowCount: 20 });
assert.equal(webhookPayloads.length, 1);
assert.equal(webhookPayloads[0]!.cardsV2.length, 2);
assert.deepEqual(extractAssets(webhookPayloads[0]!), expectedAssets);
assert.equal(extractVenueLineCount(webhookPayloads[0]!), 100);
assert.equal(stateExistedWhenWebhookReceived, false);
assert.equal(JSON.parse(await readFile(stateFile, 'utf8')).lastSuccessfulSlot, slot.key);
```

Run the same slot again without force and assert no new venue or Webhook request occurs. Use `t.after` to close the server and remove only the exact temporary directory.

- [ ] **Step 2: Run E2E and verify red before updating its fixtures/routes**

Run: `node --import tsx --test test/e2e/job-http.test.ts`

Expected: FAIL until every five-venue route and expected message shape is provided.

- [ ] **Step 3: Complete the E2E fixtures and update the deployment runbook**

Update `README.md` so its opening and first-message validation state:

- ranking is equal-weight estimated next-Funding APR across the five approved venues;
- assets require coverage of at least 2 venues;
- each asset shows all five venue positions, estimated next Funding/period/APR, and realized seven-day daily average/APR;
- `--` means not listed, and `*` means history shorter than seven days;
- no venue API key is needed;
- dry-run should log five venue market counts and produce exactly 20 assets × 5 venue positions;
- a full-current-snapshot failure from any venue suppresses the run;
- operators should check the named venue's public API connectivity and wait for recovery rather than forcing a partial-weight message.

Keep all existing Node 24, secret entry, PM2, schedule, catch-up, state corruption, Chat timeout, and manual resend instructions.

- [ ] **Step 4: Run complete verification with Node 24**

Run:

```bash
npm run clean
npm run typecheck
npm test
npm run build
npm audit --omit=dev --registry=https://registry.npmjs.org
git diff --check
git status --short --branch
```

Expected:

- typecheck exits 0;
- all unit, integration, lock, scheduler, and E2E tests pass;
- `dist/index.js` exists after the clean build;
- production audit reports 0 vulnerabilities;
- `git diff --check` emits no output;
- only the intended Task 12 files are uncommitted.

- [ ] **Step 5: Run a real public-data dry-run without Webhook or state mutation**

Run after build: `npm run dry-run`

Expected:

- all five public venues succeed;
- exactly 20 ranked assets print;
- every asset contains five venue positions;
- at least two venue values are present for every asset;
- no Google Chat POST occurs and no state file is read or written;
- no API key, Webhook query, or full upstream response appears in logs.

If an official public API has changed its response schema, capture the exact sanitized mismatch, update only that venue schema/client fixture under TDD, rerun its focused tests, and repeat the complete verification.

- [ ] **Step 6: Commit E2E and operations documentation**

```bash
git add test/e2e/job-http.test.ts README.md
git commit -m "docs: add multi-venue funding operations runbook"
```

- [ ] **Step 7: Final branch verification and review handoff**

Run:

```bash
npm run typecheck
npm test
npm run build
git status --short --branch
git log --oneline --decorate -15
```

Expected: all verification commands pass and the worktree is clean. Then invoke `superpowers:requesting-code-review`, address only validated findings under TDD, rerun `superpowers:verification-before-completion`, and use `superpowers:finishing-a-development-branch` to offer merge, PR, or keep-branch options.
