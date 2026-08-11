import assert from 'node:assert/strict';
import test from 'node:test';

import { Decimal } from 'decimal.js';

import type {
  CompositeFundingRow,
  CompositeVenueFundingMetric,
  VenueId
} from '../../src/domain.js';
import { compositeSevenDay } from '../../src/funding/seven-day-composite.js';

function metric(
  venue: VenueId,
  dailyRate: string | null,
  options: { partial?: boolean; missingApr?: boolean } = {}
): CompositeVenueFundingMetric {
  const daily = dailyRate === null ? null : new Decimal(dailyRate);
  return {
    venue,
    marketId: `${venue}-TEST`,
    nextFundingRate: new Decimal(0),
    intervalHours: 8,
    nextFundingTime: 0,
    nextApr: new Decimal(0),
    sevenDayAverageDailyRate: daily,
    sevenDayApr: daily === null || options.missingApr === true ? null : daily.times(365),
    partialSevenDayHistory: options.partial ?? false
  };
}

function row(...metrics: CompositeVenueFundingMetric[]): CompositeFundingRow {
  return {
    rank: 1,
    asset: 'TEST',
    compositeNextApr: new Decimal(0),
    coverageCount: metrics.length,
    venues: Object.fromEntries(metrics.map((item) => [item.venue, item]))
  };
}

test('equal-weights valid seven-day daily rates and derives APR from the unrounded average', () => {
  const summary = compositeSevenDay(row(
    metric('binance', '0.003196'),
    metric('bybit', '0.004458'),
    metric('bitget', '0.003509')
  ));

  assert.equal(summary.averageDailyRate?.toString(), '0.003721');
  assert.equal(summary.apr?.toString(), '1.358165');
  assert.equal(summary.venueCount, 3);
  assert.equal(summary.partialHistory, false);
});

test('excludes incomplete venue history from the equal-weight denominator', () => {
  const summary = compositeSevenDay(row(
    metric('binance', '0.001'),
    metric('okx', null),
    metric('hyperliquid', '0.003'),
    metric('bitget', '0.009', { missingApr: true })
  ));

  assert.equal(summary.averageDailyRate?.toString(), '0.002');
  assert.equal(summary.apr?.toString(), '0.73');
  assert.equal(summary.venueCount, 2);
});

test('marks the summary when any participating venue has partial history', () => {
  const summary = compositeSevenDay(row(
    metric('binance', '0.001'),
    metric('bybit', '0.003', { partial: true })
  ));

  assert.equal(summary.partialHistory, true);
});

test('returns unavailable summaries when fewer than two venues have valid history', () => {
  const summary = compositeSevenDay(row(
    metric('binance', '0.001'),
    metric('okx', null)
  ));

  assert.equal(summary.averageDailyRate, null);
  assert.equal(summary.apr, null);
  assert.equal(summary.partialHistory, true);
  assert.equal(summary.venueCount, 1);
});
