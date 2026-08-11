import { Decimal } from 'decimal.js';

import type {
  CompositeFundingRow,
  CompositeVenueFundingMetric
} from '../domain.js';

export interface CompositeSevenDaySummary {
  averageDailyRate: Decimal | null;
  apr: Decimal | null;
  partialHistory: boolean;
  venueCount: number;
}

function hasCompleteHistory(
  metric: CompositeVenueFundingMetric | undefined
): metric is CompositeVenueFundingMetric {
  return metric !== undefined
    && metric.sevenDayAverageDailyRate !== null
    && metric.sevenDayApr !== null;
}

export function compositeSevenDay(row: CompositeFundingRow): CompositeSevenDaySummary {
  const metrics = Object.values(row.venues).filter(hasCompleteHistory);

  if (metrics.length < 2) {
    return {
      averageDailyRate: null,
      apr: null,
      partialHistory: true,
      venueCount: metrics.length
    };
  }

  const averageDailyRate = metrics
    .reduce(
      (sum, metric) => sum.plus(metric.sevenDayAverageDailyRate!),
      new Decimal(0)
    )
    .div(metrics.length);

  return {
    averageDailyRate,
    apr: averageDailyRate.times(365),
    partialHistory: metrics.some((metric) => metric.partialSevenDayHistory),
    venueCount: metrics.length
  };
}
