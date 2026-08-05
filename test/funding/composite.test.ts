import assert from 'node:assert/strict';
import test from 'node:test';

import type { VenueFundingSnapshot, VenueId, VenueSnapshot } from '../../src/domain.js';
import { buildCompositeFundingLeaderboard } from '../../src/funding/composite.js';

const AS_OF = 1_700_000_000_000;
const HOUR = 60 * 60 * 1_000;
const VENUES: VenueId[] = ['binance', 'okx', 'hyperliquid', 'bybit', 'bitget'];

function venueMarket(
  venue: VenueId,
  rawBaseAsset: string,
  nextFundingRate = '0.00001',
  intervalHours = 8,
  overrides: Partial<VenueFundingSnapshot> = {}
): VenueFundingSnapshot {
  return {
    venue,
    marketId: `${venue}-${rawBaseAsset}-PERP`,
    rawBaseAsset,
    quoteAsset: 'USDT',
    settleAsset: 'USDT',
    nextFundingRate,
    intervalHours,
    nextFundingTime: AS_OF + HOUR,
    ...overrides
  };
}

function venueSnapshot(venue: VenueId, markets: VenueFundingSnapshot[]): VenueSnapshot {
  return {
    venue,
    observedAt: AS_OF,
    markets,
    stats: { marketCount: markets.length, requestCount: 1, pageCount: 1 }
  };
}

function completeSnapshots(marketsByVenue: Partial<Record<VenueId, VenueFundingSnapshot[]>> = {}): VenueSnapshot[] {
  return VENUES.map((venue) => venueSnapshot(venue, marketsByVenue[venue] ?? []));
}

function addTwoVenueCandidates(snapshots: VenueSnapshot[], count: number, prefix = 'ASSET'): void {
  for (let index = 0; index < count; index += 1) {
    const asset = `${prefix}${index + 1}`;
    snapshots[0]!.markets.push(venueMarket('binance', asset));
    snapshots[1]!.markets.push(venueMarket('okx', asset));
  }
}

test('normalizes interval APR before equal-weighting two to five valid venues', () => {
  const snapshots = [
    venueSnapshot('binance', [venueMarket('binance', 'BTC', '0.0008', 8)]),
    venueSnapshot('okx', [venueMarket('okx', 'BTC', '0.0001', 1)]),
    venueSnapshot('hyperliquid', [venueMarket('hyperliquid', 'BTC', '0.0001', 1)]),
    venueSnapshot('bybit', []),
    venueSnapshot('bitget', [])
  ];
  addTwoVenueCandidates(snapshots, 19);

  const leaderboard = buildCompositeFundingLeaderboard({ asOf: AS_OF, snapshots });
  const btc = leaderboard.rows[0]!;

  assert.equal(btc.asset, 'BTC');
  assert.equal(btc.coverageCount, 3);
  assert.equal(btc.venues.binance!.nextApr.toString(), '0.876');
  assert.equal(btc.venues.okx!.nextApr.toString(), '0.876');
  assert.equal(btc.compositeNextApr.toString(), '0.876');
});

test('merges approved multiplier aliases without guessing numeric prefixes', () => {
  const snapshots = completeSnapshots({
    binance: [venueMarket('binance', '1000PEPE', '0.0001'), venueMarket('binance', '1000UNKNOWN', '0.0001')],
    hyperliquid: [venueMarket('hyperliquid', 'kPEPE', '0.0001')],
    okx: [venueMarket('okx', '1000UNKNOWN', '0.0001')]
  });
  addTwoVenueCandidates(snapshots, 19);

  const leaderboard = buildCompositeFundingLeaderboard({ asOf: AS_OF, snapshots });
  const pepe = leaderboard.rows.find((row) => row.asset === 'PEPE');
  const unknown = leaderboard.rows.find((row) => row.asset === '1000UNKNOWN');

  assert.equal(pepe?.coverageCount, 2);
  assert.equal(unknown?.coverageCount, 2);
});

test('excludes one-venue assets and does not use missing venues as zero APR', () => {
  const snapshots = completeSnapshots({
    binance: [venueMarket('binance', 'TWOVENUE', '0.0008', 8), venueMarket('binance', 'ONEVENUE', '0.9', 8)],
    okx: [venueMarket('okx', 'TWOVENUE', '0.0001', 1)]
  });
  addTwoVenueCandidates(snapshots, 19);

  const leaderboard = buildCompositeFundingLeaderboard({ asOf: AS_OF, snapshots });
  const twoVenue = leaderboard.rows.find((row) => row.asset === 'TWOVENUE');

  assert.equal(leaderboard.rows.some((row) => row.asset === 'ONEVENUE'), false);
  assert.equal(twoVenue?.coverageCount, 2);
  assert.equal(twoVenue?.compositeNextApr.toString(), '0.876');
});

test('rejects duplicate normalized assets from the same venue', () => {
  const snapshots = completeSnapshots({
    binance: [venueMarket('binance', 'PEPE'), venueMarket('binance', '1000PEPE')]
  });

  assert.throws(
    () => buildCompositeFundingLeaderboard({ asOf: AS_OF, snapshots }),
    /Duplicate normalized asset PEPE for binance/
  );
});

test('requires one snapshot for each of the five venues and matching market venues', () => {
  assert.throws(
    () => buildCompositeFundingLeaderboard({
      asOf: AS_OF,
      snapshots: completeSnapshots().slice(0, 4)
    }),
    /requires one snapshot from every venue/
  );
  assert.throws(
    () => buildCompositeFundingLeaderboard({
      asOf: AS_OF,
      snapshots: [...completeSnapshots().slice(0, 4), venueSnapshot('binance', [])]
    }),
    /requires one snapshot from every venue/
  );
  assert.throws(
    () => buildCompositeFundingLeaderboard({
      asOf: AS_OF,
      snapshots: completeSnapshots({ binance: [venueMarket('okx', 'BTC')] })
    }),
    /Market venue okx does not match snapshot venue binance/
  );
});

test('rejects invalid rates, intervals, and stale next settlements', () => {
  for (const invalidMarket of [
    venueMarket('binance', 'BTC', 'not-a-decimal'),
    venueMarket('binance', 'BTC', '0.0001', 0),
    venueMarket('binance', 'BTC', '0.0001', 8, { nextFundingTime: AS_OF })
  ]) {
    assert.throws(
      () => buildCompositeFundingLeaderboard({
        asOf: AS_OF,
        snapshots: completeSnapshots({ binance: [invalidMarket] })
      }),
      /binance.*BTC/i
    );
  }
});

test('requires at least twenty assets covered by two venues', () => {
  const snapshots = completeSnapshots();
  addTwoVenueCandidates(snapshots, 19);

  assert.throws(
    () => buildCompositeFundingLeaderboard({ asOf: AS_OF, snapshots }),
    /fewer than 20 valid assets/
  );
});

test('orders by signed composite APR, coverage, then asset and retains negatives', () => {
  const snapshots = completeSnapshots({
    binance: [
      venueMarket('binance', 'BETA', '0.0001'),
      venueMarket('binance', 'ALPHA', '0.0001'),
      venueMarket('binance', 'GAMMA', '0.0001'),
      ...Array.from({ length: 15 }, (_, index) => venueMarket('binance', `FILL${index + 1}`, '0.00001')),
      venueMarket('binance', 'NEGATIVEA', '-0.0001'),
      venueMarket('binance', 'NEGATIVEB', '-0.0002')
    ],
    okx: [
      venueMarket('okx', 'BETA', '0.0001'),
      venueMarket('okx', 'ALPHA', '0.0001'),
      venueMarket('okx', 'GAMMA', '0.0001'),
      ...Array.from({ length: 15 }, (_, index) => venueMarket('okx', `FILL${index + 1}`, '0.00001')),
      venueMarket('okx', 'NEGATIVEA', '-0.0001'),
      venueMarket('okx', 'NEGATIVEB', '-0.0002')
    ],
    hyperliquid: [venueMarket('hyperliquid', 'BETA', '0.0001')]
  });

  const leaderboard = buildCompositeFundingLeaderboard({ asOf: AS_OF, snapshots });

  assert.deepEqual(leaderboard.rows.slice(0, 3).map((row) => row.asset), ['BETA', 'ALPHA', 'GAMMA']);
  assert.deepEqual(leaderboard.rows.slice(-2).map((row) => row.asset), ['NEGATIVEA', 'NEGATIVEB']);
});

test('assigns ranks and returns exactly the covered venue metrics with empty seven-day fields', () => {
  const snapshots = completeSnapshots({
    binance: [venueMarket('binance', 'THREE')],
    okx: [venueMarket('okx', 'THREE')],
    hyperliquid: [venueMarket('hyperliquid', 'THREE')]
  });
  addTwoVenueCandidates(snapshots, 19);

  const leaderboard = buildCompositeFundingLeaderboard({ asOf: AS_OF, snapshots });

  assert.deepEqual(leaderboard.rows.map((row) => row.rank), Array.from({ length: 20 }, (_, index) => index + 1));
  for (const row of leaderboard.rows) {
    const metrics = Object.values(row.venues);
    assert.equal(metrics.length, row.coverageCount);
    assert.equal(metrics.every((metric) => metric!.sevenDayAverageDailyRate === null
      && metric!.sevenDayApr === null
      && metric!.partialSevenDayHistory === false), true);
  }
});
