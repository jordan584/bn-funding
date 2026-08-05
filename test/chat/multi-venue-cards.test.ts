import assert from 'node:assert/strict';
import test from 'node:test';

import { Decimal } from 'decimal.js';

import type { CompositeFundingLeaderboard, CompositeFundingRow, VenueId } from '../../src/domain.js';
import { buildFundingChatMessage } from '../../src/chat/multi-venue-cards.js';

const AS_OF = 1_700_000_000_000;
const VENUES: VenueId[] = ['binance', 'okx', 'hyperliquid', 'bybit', 'bitget'];

function metric(venue: VenueId, rate: string, intervalHours: number, dailyRate: string) {
  const nextFundingRate = new Decimal(rate);
  const sevenDayAverageDailyRate = new Decimal(dailyRate);
  return {
    venue,
    marketId: `${venue}-BTC-PERP`,
    nextFundingRate,
    intervalHours,
    nextFundingTime: AS_OF + 60 * 60 * 1_000,
    nextApr: nextFundingRate.div(intervalHours).times(24 * 365),
    sevenDayAverageDailyRate,
    sevenDayApr: sevenDayAverageDailyRate.times(365),
    partialSevenDayHistory: false
  };
}

function baseRow(): CompositeFundingRow {
  return {
    rank: 1,
    asset: 'BTC',
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

function leaderboard(rows: CompositeFundingRow[]): CompositeFundingLeaderboard {
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

function rows(): CompositeFundingRow[] {
  return Array.from({ length: 20 }, (_, index) => {
    const row = baseRow();
    return { ...row, rank: index + 1, asset: `ASSET${index + 1}` };
  });
}

function widgets(message: ReturnType<typeof buildFundingChatMessage>, cardIndex: number): Array<Record<string, unknown>> {
  const card = message.cardsV2[cardIndex]!.card as {
    sections: Array<{ widgets: Array<Record<string, unknown>> }>;
  };
  return card.sections[0]!.widgets;
}

function assetHtml(message: ReturnType<typeof buildFundingChatMessage>): string[] {
  return message.cardsV2.flatMap((_, cardIndex) => widgets(message, cardIndex)
    .flatMap((widget) => 'textParagraph' in widget
      ? [(widget.textParagraph as { text: string }).text]
      : [])
    .filter((text) => text.startsWith('<b>#')));
}

function withFirstAssetLength(length: number): CompositeFundingRow[] {
  const result = rows();
  result[0] = { ...result[0]!, asset: 'X'.repeat(length) };
  return result;
}

test('builds exactly two Top10 cards with five venue blocks and the prescribed Chinese copy', () => {
  const message = buildFundingChatMessage(leaderboard(rows()));
  const blocks = assetHtml(message);

  assert.equal(message.text, '五交易所 Funding Top20（截至 1700000000000）');
  assert.deepEqual(message.cardsV2.map(({ cardId }) => cardId), ['funding-top20-1-10', 'funding-top20-11-20']);
  assert.deepEqual(blocks.map((block) => Number(block.match(/#(\d+)/)?.[1])), Array.from({ length: 20 }, (_, index) => index + 1));
  for (const block of blocks) {
    assert.ok(block.indexOf('Bn 下次') < block.indexOf('OKX 下次'));
    assert.ok(block.indexOf('OKX 下次') < block.indexOf('Hyper 下次'));
    assert.ok(block.indexOf('Hyper 下次') < block.indexOf('Bybit 下次'));
    assert.ok(block.indexOf('Bybit 下次') < block.indexOf('Bitget 下次'));
  }
  assert.match(JSON.stringify(message.cardsV2[0]!.card), /按有效平台的下一次 Funding APR 等权平均排序。/);
  assert.match(JSON.stringify(message.cardsV2[0]!.card), /下一次为当前预估；括号内为 APR。/);
});

test('renders missing metrics as dashes, colors signed numeric values, and escapes asset IDs', () => {
  const row = rows()[0]!;
  row.asset = '<BTC&"\'>';
  row.venues = {
    binance: {
      ...row.venues.binance!,
      nextFundingRate: new Decimal('0.0001'),
      nextApr: new Decimal('0.1095'),
      sevenDayAverageDailyRate: new Decimal('-0.0002'),
      sevenDayApr: new Decimal('-0.073'),
      partialSevenDayHistory: true
    },
    okx: {
      ...row.venues.okx!,
      nextFundingRate: new Decimal('0'),
      nextApr: new Decimal('0'),
      sevenDayAverageDailyRate: null,
      sevenDayApr: null,
      partialSevenDayHistory: false
    }
  };
  row.coverageCount = 2;
  const message = buildFundingChatMessage(leaderboard([row, ...rows().slice(1)]));
  const first = assetHtml(message)[0]!;

  assert.match(first, /&lt;BTC&amp;&quot;&#39;&gt;/);
  assert.match(first, /<font color="#D93025">\+0\.0100%<\/font>/);
  assert.match(first, /<font color="#188038">-0\.0200%<\/font>/);
  assert.match(first, /OKX 下次 0\.0000%\/8h \(0\.00%\)｜7日均 --/);
  assert.match(first, /Hyper 下次 --｜7日均 --/);
  assert.doesNotMatch(first, /color="[^"]+">0\.0000%/);
  assert.match(first, /-7\.30%<\/font>\)\*<br>OKX 下次/);
});

test('accepts 31,999 UTF-8 bytes and rejects 32,000 bytes without omitting rows or venues', () => {
  const base = buildFundingChatMessage(leaderboard(withFirstAssetLength(1)));
  const baseBytes = Buffer.byteLength(JSON.stringify(base), 'utf8');
  const acceptedRows = withFirstAssetLength(31_999 - baseBytes + 1);
  const accepted = buildFundingChatMessage(leaderboard(acceptedRows));

  assert.equal(Buffer.byteLength(JSON.stringify(accepted), 'utf8'), 31_999);
  assert.equal(assetHtml(accepted).length, 20);
  assert.match(assetHtml(accepted)[0]!, /Bn 下次.*OKX 下次.*Hyper 下次.*Bybit 下次.*Bitget 下次/);
  assert.throws(
    () => buildFundingChatMessage(leaderboard(withFirstAssetLength(32_000 - baseBytes + 1))),
    { message: 'Google Chat message exceeds 32000 bytes' }
  );
});
