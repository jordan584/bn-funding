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
import { normalizeAssetWithDiagnostics } from '../exchanges/normalize.js';

const DAYS_PER_YEAR = new Decimal(365);
const MINUTE_MS = 60 * 1_000;
const MAX_SNAPSHOT_FUTURE_SKEW_MS = 5 * MINUTE_MS;
const MAX_SNAPSHOT_AGE_MS = 30 * MINUTE_MS;

export interface BuildCompositeFundingLeaderboardInput {
  asOf: number;
  snapshots: VenueSnapshot[];
  allowedAssets?: ReadonlySet<string>;
  onTelemetry?: (telemetry: CompositeBuildTelemetry) => void;
}

export interface CoverageCountsTelemetry {
  two: number;
  three: number;
  four: number;
  five: number;
}

export interface NormalizationTelemetry {
  beforeAssetCount: number;
  afterAssetCount: number;
  explicitAliasCount: number;
  conflictCount: number;
}

export interface CompositeBuildTelemetry {
  normalization: NormalizationTelemetry;
  candidateCoverageCounts: CoverageCountsTelemetry;
}

function nextApr(rate: Decimal, intervalHours: number): Decimal {
  if (!Number.isFinite(intervalHours) || intervalHours <= 0) {
    throw new Error('Funding interval must be positive');
  }
  return rate.times(24).div(intervalHours).times(DAYS_PER_YEAR);
}

export function assertCompleteVenueSnapshots(
  snapshots: VenueSnapshot[],
  asOf: number
): Record<VenueId, VenueSnapshot> {
  if (!Number.isSafeInteger(asOf) || asOf <= 0) {
    throw new Error('Invalid final aggregation time');
  }
  const byVenue = new Map(snapshots.map((snapshot) => [snapshot.venue, snapshot]));
  if (snapshots.length !== VENUE_IDS.length
    || byVenue.size !== VENUE_IDS.length
    || VENUE_IDS.some((venue) => !byVenue.has(venue))) {
    throw new Error('Funding leaderboard requires one snapshot from every venue');
  }
  for (const venue of VENUE_IDS) {
    const snapshot = byVenue.get(venue)!;
    if (
      !Number.isSafeInteger(snapshot.observedAt)
      || snapshot.observedAt <= 0
      || snapshot.observedAt > asOf + MAX_SNAPSHOT_FUTURE_SKEW_MS
    ) {
      throw new Error(`Invalid ${venue} snapshot observation time`);
    }
    if (snapshot.observedAt < asOf - MAX_SNAPSHOT_AGE_MS) {
      throw new Error(`Stale ${venue} snapshot observation time`);
    }
    if (snapshot.markets.length === 0) {
      throw new Error(`${venue} snapshot has no markets`);
    }
    if (
      snapshot.stats.marketCount !== snapshot.markets.length
      || !Number.isSafeInteger(snapshot.stats.requestCount)
      || snapshot.stats.requestCount < 1
      || !Number.isSafeInteger(snapshot.stats.pageCount)
      || snapshot.stats.pageCount < 0
      || snapshot.stats.pageCount > snapshot.stats.requestCount
    ) {
      throw new Error(`${venue} snapshot stats do not match markets`);
    }
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

function normalizedAsset(
  market: VenueFundingSnapshot,
  venue: VenueId
): { asset: string; explicitAlias: boolean } {
  try {
    return normalizeAssetWithDiagnostics(venue, market.rawBaseAsset);
  } catch {
    throw new Error(`Invalid base asset for ${venue} market ${market.marketId}`);
  }
}

function emptyCoverageCounts(): CoverageCountsTelemetry {
  return { two: 0, three: 0, four: 0, five: 0 };
}

function notifyTelemetry(
  input: BuildCompositeFundingLeaderboardInput,
  telemetry: CompositeBuildTelemetry
): void {
  try {
    input.onTelemetry?.({
      normalization: { ...telemetry.normalization },
      candidateCoverageCounts: { ...telemetry.candidateCoverageCounts }
    });
  } catch {
    // Observability must not alter ranking behavior.
  }
}

function metricForMarket(
  market: VenueFundingSnapshot,
  snapshot: VenueSnapshot,
  asOf: number
): CompositeVenueFundingMetric {
  const venue = snapshot.venue;
  if (market.venue !== venue) {
    throw new Error(`Market venue ${market.venue} does not match snapshot venue ${venue}`);
  }
  if (
    !Number.isSafeInteger(market.nextFundingTime)
    || market.nextFundingTime <= Math.max(asOf, snapshot.observedAt)
  ) {
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

function compareAssetIds(left: string, right: string): number {
  const leftCodePoints = [...left].map((character) => character.codePointAt(0)!);
  const rightCodePoints = [...right].map((character) => character.codePointAt(0)!);
  const sharedLength = Math.min(leftCodePoints.length, rightCodePoints.length);
  for (let index = 0; index < sharedLength; index += 1) {
    if (leftCodePoints[index] !== rightCodePoints[index]) {
      return leftCodePoints[index]! - rightCodePoints[index]!;
    }
  }
  return leftCodePoints.length - rightCodePoints.length;
}

function compareRows(left: CompositeFundingRow, right: CompositeFundingRow): number {
  const aprComparison = right.compositeNextApr.abs().comparedTo(left.compositeNextApr.abs());
  if (aprComparison !== 0) {
    return aprComparison;
  }
  if (left.coverageCount !== right.coverageCount) {
    return right.coverageCount - left.coverageCount;
  }
  return compareAssetIds(left.asset, right.asset);
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
  const snapshotsByVenue = assertCompleteVenueSnapshots(input.snapshots, input.asOf);
  const rowsByAsset = new Map<string, CompositeFundingRow>();
  const telemetry: CompositeBuildTelemetry = {
    normalization: {
      beforeAssetCount: new Set(input.snapshots.flatMap((snapshot) =>
        snapshot.markets.map((market) => market.rawBaseAsset.trim().toUpperCase())
      )).size,
      afterAssetCount: 0,
      explicitAliasCount: 0,
      conflictCount: 0
    },
    candidateCoverageCounts: emptyCoverageCounts()
  };
  notifyTelemetry(input, telemetry);

  for (const venue of VENUE_IDS) {
    const snapshot = snapshotsByVenue[venue];
    const assetsInVenue = new Set<string>();
    for (const market of snapshot.markets) {
      if (market.venue !== venue) {
        throw new Error(`Market venue ${market.venue} does not match snapshot venue ${venue}`);
      }
      const normalized = normalizedAsset(market, venue);
      const asset = normalized.asset;
      if (input.allowedAssets !== undefined && !input.allowedAssets.has(asset)) {
        continue;
      }
      if (normalized.explicitAlias) telemetry.normalization.explicitAliasCount += 1;
      if (assetsInVenue.has(asset)) {
        telemetry.normalization.conflictCount += 1;
        telemetry.normalization.afterAssetCount = rowsByAsset.size;
        notifyTelemetry(input, telemetry);
        throw new Error(`Duplicate normalized asset ${asset} for ${venue}`);
      }
      assetsInVenue.add(asset);

      const metric = metricForMarket(market, snapshot, input.asOf);
      const row = rowsByAsset.get(asset) ?? {
        rank: 0,
        asset,
        compositeNextApr: new Decimal(0),
        coverageCount: 0,
        venues: {}
      };
      row.venues[venue] = metric;
      rowsByAsset.set(asset, row);
      telemetry.normalization.afterAssetCount = rowsByAsset.size;
    }
  }
  notifyTelemetry(input, telemetry);

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
    if (coverageCount === 2) telemetry.candidateCoverageCounts.two += 1;
    if (coverageCount === 3) telemetry.candidateCoverageCounts.three += 1;
    if (coverageCount === 4) telemetry.candidateCoverageCounts.four += 1;
    if (coverageCount === 5) telemetry.candidateCoverageCounts.five += 1;
    return [row];
  });
  notifyTelemetry(input, telemetry);

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
