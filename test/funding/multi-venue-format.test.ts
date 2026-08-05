import assert from 'node:assert/strict';
import test from 'node:test';

import { Decimal } from 'decimal.js';

import type { CompositeFundingLeaderboard, CompositeFundingRow, VenueId } from '../../src/domain.js';
import { renderLeaderboardText, signedAprPercent, signedFundingPercent } from '../../src/funding/multi-venue-format.js';

const AS_OF = 1_700_000_000_000;
const VENUES: VenueId[] = ['binance', 'okx', 'hyperliquid', 'bybit', 'bitget'];

function metric(
  venue: VenueId,
  nextFundingRate: string,
  intervalHours: number,
  sevenDayAverageDailyRate: string | null,
  partialSevenDayHistory = false
) {
  const nextRate = new Decimal(nextFundingRate);
  const dailyRate = sevenDayAverageDailyRate === null ? null : new Decimal(sevenDayAverageDailyRate);
  return {
    venue,
    marketId: `${venue}-BTC-PERP`,
    nextFundingRate: nextRate,
    intervalHours,
    nextFundingTime: AS_OF + 60 * 60 * 1_000,
    nextApr: nextRate.div(intervalHours).times(24 * 365),
    sevenDayAverageDailyRate: dailyRate,
    sevenDayApr: dailyRate?.times(365) ?? null,
    partialSevenDayHistory
  };
}

function fullCoverageRow(rank = 1, asset = 'BTC'): CompositeFundingRow {
  return {
    rank,
    asset,
    compositeNextApr: new Decimal('0.12345'),
    coverageCount: 5,
    venues: {
      binance: metric('binance', '0.0001', 8, '0.00024'),
      okx: metric('okx', '0.00012', 8, '0.00026'),
      hyperliquid: metric('hyperliquid', '0.000015', 1, '0.00023'),
      bybit: metric('bybit', '0.00009', 8, '0.00022'),
      bitget: metric('bitget', '0.000135', 8, '0.00025')
    }
  };
}

export function leaderboard(rows: CompositeFundingRow[] = [fullCoverageRow()]): CompositeFundingLeaderboard {
  return {
    asOf: AS_OF,
    candidateCount: 20,
    venueStats: Object.fromEntries(VENUES.map((venue) => [venue, {
      marketCount: 20,
      requestCount: 1,
      pageCount: 1
    }])) as CompositeFundingLeaderboard['venueStats'],
    rows
  };
}

test('renders all five venues in fixed order with signed rates and partial seven-day history', () => {
  const sparse = fullCoverageRow(2, 'ETH');
  sparse.coverageCount = 2;
  sparse.compositeNextApr = new Decimal('-0.01234');
  sparse.venues = {
    binance: metric('binance', '-0.0001', 8, '0', true),
    hyperliquid: metric('hyperliquid', '0', 1, null, true)
  };

  const text = renderLeaderboardText(leaderboard([fullCoverageRow(), sparse]));

  assert.match(text, /#1 BTC｜综合预估 APR \+12\.35%｜覆盖 5\/5\nBn 下次 \+0\.0100%\/8h \(\+10\.95%\)｜7日均 \+0\.0240%\/日 \(\+8\.76%\)\nOKX 下次 \+0\.0120%\/8h \(\+13\.14%\)｜7日均 \+0\.0260%\/日 \(\+9\.49%\)\nHyper 下次 \+0\.0015%\/1h \(\+13\.14%\)｜7日均 \+0\.0230%\/日 \(\+8\.40%\)\nBybit 下次 \+0\.0090%\/8h \(\+9\.86%\)｜7日均 \+0\.0220%\/日 \(\+8\.03%\)\nBitget 下次 \+0\.0135%\/8h \(\+14\.78%\)｜7日均 \+0\.0250%\/日 \(\+9\.13%\)/);
  assert.match(text, /#2 ETH｜综合预估 APR -1\.23%｜覆盖 2\/5\nBn 下次 -0\.0100%\/8h \(-10\.95%\)｜7日均 0\.0000%\/日 \(0\.00%\)\*\nOKX 下次 --｜7日均 --\nHyper 下次 0\.0000%\/1h \(0\.00%\)｜7日均 --\*\nBybit 下次 --｜7日均 --\nBitget 下次 --｜7日均 --/);
});

test('adds a sign only to positive Decimal values', () => {
  assert.equal(signedFundingPercent(new Decimal('0.0001')), '+0.0100%');
  assert.equal(signedFundingPercent(new Decimal('0')), '0.0000%');
  assert.equal(signedFundingPercent(new Decimal('-0.0001')), '-0.0100%');
  assert.equal(signedAprPercent(new Decimal('0.12345')), '+12.35%');
  assert.equal(signedAprPercent(new Decimal('0')), '0.00%');
  assert.equal(signedAprPercent(new Decimal('-0.12345')), '-12.35%');
});
