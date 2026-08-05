import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  FundingVenueAdapter,
  VenueFundingSnapshot,
  VenueHistoryRequest,
  VenueHistoryResult,
  VenueId,
  VenueSnapshot
} from '../../src/domain.js';
import { buildCompositeFundingLeaderboard } from '../../src/funding/composite.js';
import { hydrateSevenDayFunding } from '../../src/funding/history.js';

const AS_OF = 1_700_000_000_000;
const HOUR = 60 * 60 * 1_000;
const DAY = 24 * HOUR;
const VENUES: VenueId[] = ['binance', 'okx', 'hyperliquid', 'bybit', 'bitget'];

function market(
  venue: VenueId,
  asset: string,
  overrides: Partial<VenueFundingSnapshot> = {}
): VenueFundingSnapshot {
  return {
    venue,
    marketId: `${venue}-${asset}-PERP`,
    rawBaseAsset: asset,
    quoteAsset: venue === 'hyperliquid' ? 'USD' : 'USDT',
    settleAsset: venue === 'hyperliquid' ? 'USDC' : 'USDT',
    nextFundingRate: '0.0001',
    intervalHours: 8,
    nextFundingTime: AS_OF + HOUR,
    listedAt: AS_OF - 30 * DAY,
    ...overrides
  };
}

function snapshot(venue: VenueId, markets: VenueFundingSnapshot[]): VenueSnapshot {
  return {
    venue,
    observedAt: AS_OF,
    markets,
    stats: { marketCount: markets.length, requestCount: 1, pageCount: 1 }
  };
}

function rankedLeaderboardWithTwoVenuesPerRow(
  marketOverrides: Partial<VenueFundingSnapshot> = {}
) {
  const assets = Array.from({ length: 20 }, (_, index) => `ASSET${index + 1}`);
  return buildCompositeFundingLeaderboard({
    asOf: AS_OF,
    snapshots: VENUES.map((venue) => snapshot(
      venue,
      venue === 'binance' || venue === 'okx'
        ? assets.map((asset) => market(venue, asset, marketOverrides))
        : []
    ))
  });
}

function settlement(venue: VenueId, marketId: string, fundingRate: string, fundingTime: number) {
  return { venue, marketId, fundingRate, fundingTime };
}

function fakeAdapters(
  responder: (request: VenueHistoryRequest) => Promise<VenueHistoryResult>
): Record<VenueId, FundingVenueAdapter> {
  const adapters = {} as Record<VenueId, FundingVenueAdapter>;
  for (const venue of VENUES) {
    adapters[venue] = {
      id: venue,
      getCurrentSnapshot: async () => {
        throw new Error('not used by history hydration');
      },
      getFundingHistory: responder
    };
  }
  return adapters;
}

function matchingHistory(
  request: VenueHistoryRequest,
  records = [
    settlement(request.market.venue, request.market.marketId, '0.0001', AS_OF - 6 * DAY),
    settlement(request.market.venue, request.market.marketId, '0.0002', AS_OF)
  ]
): VenueHistoryResult {
  return {
    records,
    requestCount: 1,
    pageCount: 1,
    completeFrom: request.startTime
  };
}

test('requests history only for venue markets present on the selected Top20', async () => {
  const leaderboard = rankedLeaderboardWithTwoVenuesPerRow();
  const calls: Array<{ venue: VenueId; marketId: string; startTime: number; endTime: number }> = [];
  const adapters = fakeAdapters(async (request) => {
    calls.push({
      venue: request.market.venue,
      marketId: request.market.marketId,
      startTime: request.startTime,
      endTime: request.endTime
    });
    return matchingHistory(request);
  });

  const result = await hydrateSevenDayFunding({ asOf: AS_OF, leaderboard, adapters, concurrency: 5 });

  assert.equal(calls.length, 40);
  assert.equal(calls.some(({ venue }) => venue === 'hyperliquid'), false);
  assert.equal(calls.every(({ startTime, endTime }) => startTime === AS_OF - 7 * DAY + 1 && endTime === AS_OF), true);
  assert.equal(result.leaderboard.rows[0]!.venues.binance!.sevenDayAverageDailyRate!.toString(), '0.000042857142857142857143');
  assert.equal(result.leaderboard.rows[0]!.venues.binance!.sevenDayApr!.toString(), '0.015642857142857142857');
  assert.deepEqual(result.venueStats.binance, { requestCount: 20, pageCount: 20, recordCount: 40 });
  assert.deepEqual(result.venueStats.hyperliquid, { requestCount: 0, pageCount: 0, recordCount: 0 });
  assert.equal(leaderboard.rows[0]!.venues.binance!.sevenDayAverageDailyRate, null);
});

test('filters the exclusive lower boundary and deduplicates inclusive page-boundary settlements', async () => {
  const leaderboard = rankedLeaderboardWithTwoVenuesPerRow();
  const adapters = fakeAdapters(async (request) => matchingHistory(request, [
    settlement(request.market.venue, request.market.marketId, '9', AS_OF - 7 * DAY),
    settlement(request.market.venue, request.market.marketId, '0.0001', AS_OF - 6 * DAY),
    settlement(request.market.venue, request.market.marketId, '0.0001', AS_OF - 6 * DAY),
    settlement(request.market.venue, request.market.marketId, '0.0003', AS_OF)
  ]));

  const result = await hydrateSevenDayFunding({ asOf: AS_OF, leaderboard, adapters });

  assert.equal(result.leaderboard.rows[0]!.venues.binance!.sevenDayAverageDailyRate!.toString(), '0.000057142857142857142857');
  assert.equal(result.venueStats.binance.recordCount, 80);
});

test('rejects history records that belong to another venue or market', async () => {
  const leaderboard = rankedLeaderboardWithTwoVenuesPerRow();
  for (const records of [
    (request: VenueHistoryRequest) => [settlement('okx', request.market.marketId, '0.0001', AS_OF)],
    (request: VenueHistoryRequest) => [settlement(request.market.venue, 'unexpected-market', '0.0001', AS_OF)]
  ]) {
    await assert.rejects(
      hydrateSevenDayFunding({
        asOf: AS_OF,
        leaderboard,
        adapters: fakeAdapters(async (request) => matchingHistory(request, records(request)))
      }),
      /does not match requested (venue|market)/
    );
  }
});

test('rejects an incomplete seven-day response for an established market', async () => {
  const leaderboard = rankedLeaderboardWithTwoVenuesPerRow();

  await assert.rejects(
    hydrateSevenDayFunding({
      asOf: AS_OF,
      leaderboard,
      adapters: fakeAdapters(async (request) => ({
        ...matchingHistory(request),
        completeFrom: request.startTime + 1
      }))
    }),
    /Incomplete Funding history/
  );
});

test('uses listed duration for a partially listed market and preserves next-funding ranking metrics', async () => {
  const listedAt = AS_OF - 3.5 * DAY;
  const leaderboard = rankedLeaderboardWithTwoVenuesPerRow({ listedAt });
  const original = leaderboard.rows[0]!;
  const adapters = fakeAdapters(async (request) => matchingHistory(request, [
    settlement(request.market.venue, request.market.marketId, '0.00035', AS_OF)
  ]));

  const result = await hydrateSevenDayFunding({ asOf: AS_OF, leaderboard, adapters });
  const hydrated = result.leaderboard.rows[0]!;

  assert.equal(hydrated.venues.binance!.sevenDayAverageDailyRate!.toString(), '0.0001');
  assert.equal(hydrated.venues.binance!.sevenDayApr!.toString(), '0.0365');
  assert.equal(hydrated.venues.binance!.partialSevenDayHistory, true);
  assert.equal(hydrated.rank, original.rank);
  assert.equal(hydrated.compositeNextApr.toString(), original.compositeNextApr.toString());
  assert.equal(hydrated.coverageCount, original.coverageCount);
  assert.equal(hydrated.venues.binance!.nextFundingTime, original.venues.binance!.nextFundingTime);
  assert.equal(leaderboard.rows[0]!.venues.binance!.partialSevenDayHistory, false);
});

test('returns null history metrics for a new market without one complete funding interval', async () => {
  const leaderboard = rankedLeaderboardWithTwoVenuesPerRow({ listedAt: AS_OF - 2 * HOUR });
  const adapters = fakeAdapters(async (request) => matchingHistory(request, []));

  const result = await hydrateSevenDayFunding({ asOf: AS_OF, leaderboard, adapters });
  const metric = result.leaderboard.rows[0]!.venues.binance!;

  assert.equal(metric.sevenDayAverageDailyRate, null);
  assert.equal(metric.sevenDayApr, null);
  assert.equal(metric.partialSevenDayHistory, true);
});

test('rejects an established market with no settled Funding history', async () => {
  const leaderboard = rankedLeaderboardWithTwoVenuesPerRow();
  const adapters = fakeAdapters(async (request) => matchingHistory(request, []));

  await assert.rejects(
    hydrateSevenDayFunding({ asOf: AS_OF, leaderboard, adapters }),
    /Missing settled Funding history for binance:binance-ASSET1-PERP/
  );
});

test('propagates venue history failures without producing a partial leaderboard', async () => {
  const leaderboard = rankedLeaderboardWithTwoVenuesPerRow();
  const adapters = fakeAdapters(async (request) => {
    if (request.market.marketId === 'binance-ASSET1-PERP') {
      throw new Error('venue unavailable');
    }
    return matchingHistory(request);
  });

  await assert.rejects(
    hydrateSevenDayFunding({ asOf: AS_OF, leaderboard, adapters, concurrency: 1 }),
    /venue unavailable/
  );
});
