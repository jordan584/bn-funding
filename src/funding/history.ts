import { Decimal } from 'decimal.js';

import {
  VENUE_IDS,
  type CompositeFundingLeaderboard,
  type CompositeVenueFundingMetric,
  type FundingHistorySettlement,
  type FundingVenueAdapter,
  type VenueId,
  type VenueRequestTelemetrySink
} from '../domain.js';
import { mapWithConcurrency } from '../exchanges/concurrency.js';

const DAY_MS = 24 * 60 * 60 * 1_000;
const WINDOW_MS = 7 * DAY_MS;
const DAYS_PER_YEAR = new Decimal(365);

export interface HistoryHydrationVenueStats {
  selectedMarketCount: number;
  requestCount: number;
  pageCount: number;
  recordCount: number;
  coverageDays: {
    minimum: Decimal | null;
    maximum: Decimal | null;
    average: Decimal | null;
  };
  stageDurationMs: number;
}

export interface HistoryHydrationResult {
  leaderboard: CompositeFundingLeaderboard;
  venueStats: Record<VenueId, HistoryHydrationVenueStats>;
}

interface HistoryWorkItem {
  rowIndex: number;
  venue: VenueId;
  metric: CompositeVenueFundingMetric;
}

interface HydratedMetric {
  rowIndex: number;
  venue: VenueId;
  metric: CompositeVenueFundingMetric;
}

interface CoverageAccumulator {
  count: number;
  total: Decimal;
}

function historyStats(): Record<VenueId, HistoryHydrationVenueStats> {
  return Object.fromEntries(VENUE_IDS.map((venue) => [venue, {
    selectedMarketCount: 0,
    requestCount: 0,
    pageCount: 0,
    recordCount: 0,
    coverageDays: { minimum: null, maximum: null, average: null },
    stageDurationMs: 0
  }])) as Record<VenueId, HistoryHydrationVenueStats>;
}

function coverageAccumulators(): Record<VenueId, CoverageAccumulator> {
  return Object.fromEntries(VENUE_IDS.map((venue) => [venue, {
    count: 0,
    total: new Decimal(0)
  }])) as Record<VenueId, CoverageAccumulator>;
}

function notifyProgress(
  stats: Record<VenueId, HistoryHydrationVenueStats>,
  onProgress: ((stats: Record<VenueId, HistoryHydrationVenueStats>) => void) | undefined
): void {
  if (onProgress === undefined) return;
  try {
    onProgress(Object.fromEntries(VENUE_IDS.map((venue) => [venue, {
      ...stats[venue],
      coverageDays: { ...stats[venue].coverageDays }
    }])) as Record<VenueId, HistoryHydrationVenueStats>);
  } catch {
    // Observability must not alter history hydration behavior.
  }
}

function matchingSettlements(
  records: FundingHistorySettlement[],
  workItem: HistoryWorkItem,
  windowStartExclusive: number,
  asOf: number
): FundingHistorySettlement[] {
  for (const record of records) {
    if (record.venue !== workItem.venue) {
      throw new Error(`Funding history record venue ${record.venue} does not match requested venue ${workItem.venue}`);
    }
    if (record.marketId !== workItem.metric.marketId) {
      throw new Error(`Funding history record market ${record.marketId} does not match requested market ${workItem.metric.marketId}`);
    }
  }

  const seen = new Set<string>();
  return records
    .filter((record) => record.fundingTime > windowStartExclusive && record.fundingTime <= asOf)
    .sort((left, right) => left.fundingTime - right.fundingTime)
    .filter((record) => {
      const key = `${record.venue}:${record.marketId}:${record.fundingTime}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
}

function decimalRate(record: FundingHistorySettlement, venue: VenueId): Decimal {
  try {
    const rate = new Decimal(record.fundingRate);
    if (!rate.isFinite()) {
      throw new Error('not finite');
    }
    return rate;
  } catch {
    throw new Error(`Invalid settled Funding rate for ${venue}:${record.marketId}`);
  }
}

function coverageStart(
  metric: CompositeVenueFundingMetric,
  settlements: FundingHistorySettlement[],
  windowStartExclusive: number
): number {
  if (metric.listedAt !== undefined) {
    return Math.max(windowStartExclusive, metric.listedAt);
  }
  if (settlements.length === 0) {
    return windowStartExclusive;
  }
  return Math.max(windowStartExclusive, settlements[0]!.fundingTime - metric.intervalHours * 60 * 60 * 1_000);
}

function hydrateMetric(
  workItem: HistoryWorkItem,
  records: FundingHistorySettlement[],
  asOf: number,
  windowStartExclusive: number
): { metric: CompositeVenueFundingMetric; coverageDays: Decimal } {
  const settlements = matchingSettlements(records, workItem, windowStartExclusive, asOf);
  const coverageStartTime = coverageStart(workItem.metric, settlements, windowStartExclusive);
  const coverageDuration = asOf - coverageStartTime;
  const coverageDays = new Decimal(coverageDuration).div(DAY_MS);
  const intervalMs = workItem.metric.intervalHours * 60 * 60 * 1_000;
  const partialSevenDayHistory = coverageStartTime > windowStartExclusive;

  if (settlements.length === 0) {
    if (coverageDuration < intervalMs) {
      return {
        metric: {
          ...workItem.metric,
          sevenDayAverageDailyRate: null,
          sevenDayApr: null,
          partialSevenDayHistory: true
        },
        coverageDays
      };
    }
    throw new Error(`Missing settled Funding history for ${workItem.venue}:${workItem.metric.marketId}`);
  }

  const sum = settlements.reduce(
    (total, settlement) => total.plus(decimalRate(settlement, workItem.venue)),
    new Decimal(0)
  );
  const averageDaily = sum.div(coverageDays);
  return {
    metric: {
      ...workItem.metric,
      sevenDayAverageDailyRate: averageDaily,
      sevenDayApr: averageDaily.times(DAYS_PER_YEAR),
      partialSevenDayHistory
    },
    coverageDays
  };
}

function addCoverageDays(
  stats: HistoryHydrationVenueStats,
  accumulator: CoverageAccumulator,
  coverageDays: Decimal
): void {
  accumulator.count += 1;
  accumulator.total = accumulator.total.plus(coverageDays);
  const minimum = stats.coverageDays.minimum;
  const maximum = stats.coverageDays.maximum;
  stats.coverageDays.minimum = minimum === null || coverageDays.lt(minimum) ? coverageDays : minimum;
  stats.coverageDays.maximum = maximum === null || coverageDays.gt(maximum) ? coverageDays : maximum;
  stats.coverageDays.average = accumulator.total.div(accumulator.count);
}

export async function hydrateSevenDayFunding(input: {
  asOf: number;
  leaderboard: CompositeFundingLeaderboard;
  adapters: Record<VenueId, FundingVenueAdapter>;
  concurrency?: number;
  onRequestTelemetry?: VenueRequestTelemetrySink;
  onProgress?: (stats: Record<VenueId, HistoryHydrationVenueStats>) => void;
  now?: () => number;
}): Promise<HistoryHydrationResult> {
  const windowStartExclusive = input.asOf - WINDOW_MS;
  const requestedStart = windowStartExclusive + 1;
  const workItems = input.leaderboard.rows.flatMap((row, rowIndex) =>
    VENUE_IDS.flatMap((venue) => {
      const metric = row.venues[venue];
      return metric === undefined ? [] : [{ rowIndex, venue, metric }];
    })
  );
  const venueStats = historyStats();
  const coverageByVenue = coverageAccumulators();
  const stageStarts = new Map<VenueId, number>();
  const now = input.now ?? Date.now;
  for (const workItem of workItems) {
    venueStats[workItem.venue].selectedMarketCount += 1;
  }
  notifyProgress(venueStats, input.onProgress);
  const results = await mapWithConcurrency(
    workItems,
    input.concurrency ?? 10,
    async (workItem): Promise<HydratedMetric> => {
      const startedAt = now();
      if (!stageStarts.has(workItem.venue)) stageStarts.set(workItem.venue, startedAt);
      const stats = venueStats[workItem.venue];
      try {
        const history = await input.adapters[workItem.venue].getFundingHistory({
          market: {
            venue: workItem.venue,
            marketId: workItem.metric.marketId,
            rawBaseAsset: input.leaderboard.rows[workItem.rowIndex]!.asset,
            quoteAsset: workItem.venue === 'hyperliquid' ? 'USD' : 'USDT',
            settleAsset: workItem.venue === 'hyperliquid' ? 'USDC' : 'USDT',
            nextFundingRate: workItem.metric.nextFundingRate.toString(),
            intervalHours: workItem.metric.intervalHours,
            nextFundingTime: workItem.metric.nextFundingTime,
            ...(workItem.metric.listedAt === undefined ? {} : { listedAt: workItem.metric.listedAt })
          },
          startTime: requestedStart,
          endTime: input.asOf
        }, input.onRequestTelemetry);
        stats.requestCount += history.requestCount;
        stats.pageCount += history.pageCount;
        stats.recordCount += history.records.length;
        notifyProgress(venueStats, input.onProgress);
        if (history.completeFrom > requestedStart) {
          throw new Error(`Incomplete Funding history for ${workItem.venue}:${workItem.metric.marketId}`);
        }
        const hydrated = hydrateMetric(workItem, history.records, input.asOf, windowStartExclusive);
        addCoverageDays(stats, coverageByVenue[workItem.venue], hydrated.coverageDays);
        notifyProgress(venueStats, input.onProgress);
        return { rowIndex: workItem.rowIndex, venue: workItem.venue, metric: hydrated.metric };
      } finally {
        stats.stageDurationMs = Math.max(0, now() - stageStarts.get(workItem.venue)!);
        notifyProgress(venueStats, input.onProgress);
      }
    }
  );

  const hydratedByRowAndVenue = new Map(
    results.map((entry) => [`${entry.rowIndex}:${entry.venue}`, entry.metric])
  );
  return {
    leaderboard: {
      ...input.leaderboard,
      rows: input.leaderboard.rows.map((row, rowIndex) => ({
        ...row,
        venues: Object.fromEntries(VENUE_IDS.flatMap((venue) => {
          const metric = row.venues[venue];
          return metric === undefined ? [] : [[venue, hydratedByRowAndVenue.get(`${rowIndex}:${venue}`)!]];
        }))
      }))
    },
    venueStats
  };
}
