import { Decimal } from 'decimal.js';

import {
  VENUE_IDS,
  type CompositeFundingLeaderboard,
  type CompositeVenueFundingMetric,
  type FundingHistorySettlement,
  type FundingVenueAdapter,
  type VenueId
} from '../domain.js';
import { mapWithConcurrency } from '../exchanges/concurrency.js';

const DAY_MS = 24 * 60 * 60 * 1_000;
const WINDOW_MS = 7 * DAY_MS;
const DAYS_PER_YEAR = new Decimal(365);

export interface HistoryHydrationVenueStats {
  requestCount: number;
  pageCount: number;
  recordCount: number;
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

function historyStats(): Record<VenueId, HistoryHydrationVenueStats> {
  return Object.fromEntries(VENUE_IDS.map((venue) => [venue, {
    requestCount: 0,
    pageCount: 0,
    recordCount: 0
  }])) as Record<VenueId, HistoryHydrationVenueStats>;
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
): CompositeVenueFundingMetric {
  const settlements = matchingSettlements(records, workItem, windowStartExclusive, asOf);
  const coverageStartTime = coverageStart(workItem.metric, settlements, windowStartExclusive);
  const coverageDuration = asOf - coverageStartTime;
  const intervalMs = workItem.metric.intervalHours * 60 * 60 * 1_000;
  const partialSevenDayHistory = coverageStartTime > windowStartExclusive;

  if (settlements.length === 0) {
    if (coverageDuration < intervalMs) {
      return {
        ...workItem.metric,
        sevenDayAverageDailyRate: null,
        sevenDayApr: null,
        partialSevenDayHistory: true
      };
    }
    throw new Error(`Missing settled Funding history for ${workItem.venue}:${workItem.metric.marketId}`);
  }

  const sum = settlements.reduce(
    (total, settlement) => total.plus(decimalRate(settlement, workItem.venue)),
    new Decimal(0)
  );
  const averageDaily = sum.div(new Decimal(coverageDuration).div(DAY_MS));
  return {
    ...workItem.metric,
    sevenDayAverageDailyRate: averageDaily,
    sevenDayApr: averageDaily.times(DAYS_PER_YEAR),
    partialSevenDayHistory
  };
}

export async function hydrateSevenDayFunding(input: {
  asOf: number;
  leaderboard: CompositeFundingLeaderboard;
  adapters: Record<VenueId, FundingVenueAdapter>;
  concurrency?: number;
}): Promise<HistoryHydrationResult> {
  const windowStartExclusive = input.asOf - WINDOW_MS;
  const requestedStart = windowStartExclusive + 1;
  const workItems = input.leaderboard.rows.flatMap((row, rowIndex) =>
    VENUE_IDS.flatMap((venue) => {
      const metric = row.venues[venue];
      return metric === undefined ? [] : [{ rowIndex, venue, metric }];
    })
  );
  const results = await mapWithConcurrency(
    workItems,
    input.concurrency ?? 10,
    async (workItem) => ({
      ...workItem,
      history: await input.adapters[workItem.venue].getFundingHistory({
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
      })
    })
  );
  const venueStats = historyStats();
  const hydratedMetrics: HydratedMetric[] = [];

  for (const result of results) {
    const stats = venueStats[result.venue];
    stats.requestCount += result.history.requestCount;
    stats.pageCount += result.history.pageCount;
    stats.recordCount += result.history.records.length;
    if (result.history.completeFrom > requestedStart) {
      throw new Error(`Incomplete Funding history for ${result.venue}:${result.metric.marketId}`);
    }
    hydratedMetrics.push({
      rowIndex: result.rowIndex,
      venue: result.venue,
      metric: hydrateMetric(result, result.history.records, input.asOf, windowStartExclusive)
    });
  }

  const hydratedByRowAndVenue = new Map(
    hydratedMetrics.map((entry) => [`${entry.rowIndex}:${entry.venue}`, entry.metric])
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
