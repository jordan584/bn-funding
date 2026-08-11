import assert from 'node:assert/strict';
import test from 'node:test';

import { Decimal } from 'decimal.js';
import sharp from 'sharp';

import type { CompositeFundingLeaderboard, CompositeFundingRow, VenueId } from '../../src/domain.js';
import {
  renderFundingReportImages,
  renderFundingReportSvg
} from '../../src/image/funding-report.js';

const AS_OF = Date.UTC(2026, 7, 10, 8, 5);
const VENUES: VenueId[] = ['binance', 'okx', 'hyperliquid', 'bybit', 'bitget'];

function row(rank: number): CompositeFundingRow {
  const venues = Object.fromEntries(VENUES.map((venue, venueIndex) => {
    const nextFundingRate = new Decimal(venueIndex === 1 ? '-0.0002' : '0.0001');
    const daily = new Decimal(venueIndex === 1 ? '-0.0003' : '0.00025');
    return [venue, {
      venue,
      marketId: `${venue}-asset-${rank}`,
      nextFundingRate,
      intervalHours: venue === 'hyperliquid' ? 1 : 8,
      nextFundingTime: AS_OF + 60 * 60_000,
      nextApr: nextFundingRate.div(venue === 'hyperliquid' ? 1 : 8).times(24 * 365),
      sevenDayAverageDailyRate: daily,
      sevenDayApr: daily.times(365),
      partialSevenDayHistory: venue === 'bitget'
    }];
  })) as CompositeFundingRow['venues'];
  return {
    rank,
    asset: rank === 1 ? 'BTC<&' : `ASSET${rank}`,
    compositeNextApr: new Decimal('0.1234'),
    coverageCount: 5,
    venues
  };
}

function leaderboard(): CompositeFundingLeaderboard {
  return {
    asOf: AS_OF,
    candidateCount: 30,
    venueStats: Object.fromEntries(VENUES.map((venue) => [venue, {
      marketCount: 100,
      requestCount: 1,
      pageCount: 1
    }])) as CompositeFundingLeaderboard['venueStats'],
    rows: Array.from({ length: 20 }, (_, index) => row(index + 1))
  };
}

test('renders an escaped ten-asset SVG as a fixed eight-column summary table', () => {
  const svg = renderFundingReportSvg(leaderboard(), 0, 10);

  assert.match(svg, /Funding Top20 · #1–10/);
  assert.match(svg, /2026-08-10 16:05 CST/);
  assert.match(svg, /BTC&lt;&amp;/);
  assert.doesNotMatch(svg, /BTC<&/);
  assert.match(svg, />Asset</);
  assert.match(svg, />Binance</);
  assert.match(svg, />OKX</);
  assert.match(svg, />Hyper</);
  assert.match(svg, />Bybit</);
  assert.match(svg, />Bitget</);
  assert.match(svg, />7D \/ Day</);
  assert.match(svg, />7D APR</);
  assert.match(svg, /\+0\.0100%/);
  assert.match(svg, /-0\.0200%/);
  assert.match(svg, /APR \+10\.95%/);
  assert.match(svg, /\+0\.0140%\*/);
  assert.match(svg, /\+5\.11%\*/);
  assert.match(svg, /#ff6b6b/);
  assert.match(svg, /#2ed6a1/);
  assert.match(svg, /width="800" height="826" viewBox="0 0 800 826"/);
  assert.equal((svg.match(/class="asset-symbol"/g) ?? []).length, 10);
});

test('renders exactly two non-empty PNG images for the two Top10 ranges', async () => {
  const images = await renderFundingReportImages(leaderboard());

  assert.deepEqual(images.map(({ range }) => range), ['1-10', '11-20']);
  for (const { png } of images) {
    assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.ok(png.byteLength > 10_000);
    const metadata = await sharp(png).metadata();
    assert.equal(metadata.width, 1600);
    assert.equal(metadata.height, 1652);
  }
});

test('keeps fixed venue columns and renders missing venues as dashes', async () => {
  const board = leaderboard();
  for (const item of board.rows) {
    item.venues = {
      binance: item.venues.binance!,
      bybit: item.venues.bybit!
    };
    item.coverageCount = 2;
  }

  const svg = renderFundingReportSvg(board, 0, 10);

  assert.match(svg, />Binance</);
  assert.match(svg, />Bybit</);
  assert.match(svg, />OKX</);
  assert.match(svg, />Hyper</);
  assert.match(svg, />Bitget</);
  assert.equal((svg.match(/>--<\/text>/g) ?? []).length, 30);
  assert.match(svg, /\+0\.0250%/);
  assert.match(svg, /\+9\.13%/);
  assert.match(svg, /width="800" height="826" viewBox="0 0 800 826"/);

  const images = await renderFundingReportImages(board);
  const metadata = await sharp(images[0]!.png).metadata();
  assert.equal(metadata.height, 1652);
});
