import { Decimal } from 'decimal.js';

import {
  VENUE_IDS,
  type CompositeFundingLeaderboard,
  type CompositeFundingRow,
  type CompositeVenueFundingMetric,
  type VenueFundingSnapshot,
  type VenueId,
  type VenueSnapshot
} from '../domain.js';
import { normalizeAsset } from '../exchanges/normalize.js';

const DAYS_PER_YEAR = new Decimal(365);

export interface BuildCompositeFundingLeaderboardInput {
  asOf: number;
  snapshots: VenueSnapshot[];
}

function nextApr(rate: Decimal, intervalHours: number): Decimal {
  if (!Number.isFinite(intervalHours) || intervalHours <= 0) {
    throw new Error('Funding interval must be positive');
  }
  return rate.times(24).div(intervalHours).times(DAYS_PER_YEAR);
}

function requireCompleteSnapshots(snapshots: VenueSnapshot[]): Record<VenueId, VenueSnapshot> {
  const byVenue = new Map(snapshots.map((snapshot) => [snapshot.venue, snapshot]));
  if (snapshots.length !== VENUE_IDS.length
    || byVenue.size !== VENUE_IDS.length
    || VENUE_IDS.some((venue) => !byVenue.has(venue))) {
    throw new Error('Funding leaderboard requires one snapshot from every venue');
  }
  return Object.fromEntries(
    VENUE_IDS.map((venue) => [venue, byVenue.get(venue)!])
  ) as Record<VenueId, VenueSnapshot>;
}

function parseRate(market: VenueFundingSnapshot, venue: VenueId): Decimal {
  try {
    const rate = new Decimal(market.nextFundingRate);
    if (!rate.isFinite()) {
      throw new Error('not finite');
    }
    return rate;
  } catch {
    throw new Error(`Invalid funding rate for ${venue} market ${market.marketId}`);
  }
}

function normalizedAsset(market: VenueFundingSnapshot, venue: VenueId): string {
  try {
    return normalizeAsset(venue, market.rawBaseAsset);
  } catch {
    throw new Error(`Invalid base asset for ${venue} market ${market.marketId}`);
  }
}

function metricForMarket(market: VenueFundingSnapshot, snapshot: VenueSnapshot): CompositeVenueFundingMetric {
  const venue = snapshot.venue;
  if (market.venue !== venue) {
    throw new Error(`Market venue ${market.venue} does not match snapshot venue ${venue}`);
  }
  if (!Number.isFinite(market.nextFundingTime) || market.nextFundingTime <= snapshot.observedAt) {
    throw new Error(`Invalid next funding time for ${venue} market ${market.marketId}`);
  }

  const rate = parseRate(market, venue);
  let apr: Decimal;
  try {
    apr = nextApr(rate, market.intervalHours);
  } catch {
    throw new Error(`Invalid funding interval for ${venue} market ${market.marketId}`);
  }

  return {
    venue,
    marketId: market.marketId,
    nextFundingRate: rate,
    intervalHours: market.intervalHours,
    nextFundingTime: market.nextFundingTime,
    nextApr: apr,
    ...(market.listedAt === undefined ? {} : { listedAt: market.listedAt }),
    sevenDayAverageDailyRate: null,
    sevenDayApr: null,
    partialSevenDayHistory: false
  };
}

function compareRows(left: CompositeFundingRow, right: CompositeFundingRow): number {
  const aprComparison = right.compositeNextApr.comparedTo(left.compositeNextApr);
  if (aprComparison !== 0) {
    return aprComparison;
  }
  if (left.coverageCount !== right.coverageCount) {
    return right.coverageCount - left.coverageCount;
  }
  return left.asset < right.asset ? -1 : left.asset > right.asset ? 1 : 0;
}

function assertRankedRows(rows: CompositeFundingRow[]): void {
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    if (row.rank !== index + 1
      || Object.values(row.venues).length !== row.coverageCount
      || (index > 0 && compareRows(rows[index - 1]!, row) > 0)) {
      throw new Error('Composite funding leaderboard order validation failed');
    }
  }
}

export function buildCompositeFundingLeaderboard(
  input: BuildCompositeFundingLeaderboardInput
): CompositeFundingLeaderboard {
  const snapshotsByVenue = requireCompleteSnapshots(input.snapshots);
  const rowsByAsset = new Map<string, CompositeFundingRow>();

  for (const venue of VENUE_IDS) {
    const snapshot = snapshotsByVenue[venue];
    const assetsInVenue = new Set<string>();
    for (const market of snapshot.markets) {
      if (market.venue !== venue) {
        throw new Error(`Market venue ${market.venue} does not match snapshot venue ${venue}`);
      }
      const asset = normalizedAsset(market, venue);
      if (assetsInVenue.has(asset)) {
        throw new Error(`Duplicate normalized asset ${asset} for ${venue}`);
      }
      assetsInVenue.add(asset);

      const metric = metricForMarket(market, snapshot);
      const row = rowsByAsset.get(asset) ?? {
        rank: 0,
        asset,
        compositeNextApr: new Decimal(0),
        coverageCount: 0,
        venues: {}
      };
      row.venues[venue] = metric;
      rowsByAsset.set(asset, row);
    }
  }

  const candidates = [...rowsByAsset.values()].flatMap((row) => {
    const metrics = Object.values(row.venues);
    const coverageCount = metrics.length;
    if (coverageCount < 2) {
      return [];
    }
    row.coverageCount = coverageCount;
    row.compositeNextApr = metrics
      .reduce((sum, metric) => sum.plus(metric!.nextApr), new Decimal(0))
      .div(coverageCount);
    return [row];
  });

  if (candidates.length < 20) {
    throw new Error('Funding leaderboard has fewer than 20 valid assets');
  }

  candidates.sort(compareRows);
  const rows = candidates.slice(0, 20).map((row, index) => ({ ...row, rank: index + 1 }));
  assertRankedRows(rows);

  return {
    asOf: input.asOf,
    candidateCount: candidates.length,
    venueStats: Object.fromEntries(
      VENUE_IDS.map((venue) => [venue, snapshotsByVenue[venue].stats])
    ) as CompositeFundingLeaderboard['venueStats'],
    rows
  };
}
