import assert from 'node:assert/strict';
import test from 'node:test';
import { Decimal } from 'decimal.js';

import type { FundingLeaderboard, FundingRow } from '../../src/domain.js';
import { buildFundingChatMessage } from '../../src/chat/cards.js';

const AS_OF = Date.UTC(2026, 7, 3, 8, 5, 0);

function row(rank: number, overrides: Partial<FundingRow> = {}): FundingRow {
  return {
    rank,
    symbol: `ASSET${rank}USDT`,
    asset: `ASSET${rank}`,
    exchange: 'Binance',
    intervalHours: ([1, 4, 8] as const)[(rank - 1) % 3]!,
    currentRate: new Decimal(rank % 3 === 1 ? '0.0001' : rank % 3 === 2 ? '-0.0002' : '0'),
    currentApr: new Decimal(rank % 3 === 1 ? '0.876' : rank % 3 === 2 ? '-0.438' : '0'),
    funding24h: new Decimal('0.0003'),
    apr24h: new Decimal('0.1095'),
    funding7d: new Decimal('0.0005'),
    apr7d: new Decimal('0.026071428571428571'),
    partialSevenDayHistory: rank === 3,
    ...overrides
  };
}

function leaderboard(rows = Array.from({ length: 20 }, (_, index) => row(index + 1))): FundingLeaderboard {
  return { asOf: AS_OF, eligibleContractCount: 20, historyRecordCount: 140, rows };
}

function sectionWidgets(message: ReturnType<typeof buildFundingChatMessage>, cardIndex: number): unknown[] {
  const card = message.cardsV2[cardIndex]!.card as {
    sections: Array<{ widgets: unknown[] }>;
  };
  return card.sections[0]!.widgets;
}

function cardText(message: ReturnType<typeof buildFundingChatMessage>, cardIndex: number): string {
  return JSON.stringify(message.cardsV2[cardIndex]!.card);
}

function metricsText(message: ReturnType<typeof buildFundingChatMessage>, cardIndex: number, rowIndex: number): string {
  const widget = sectionWidgets(message, cardIndex)[1 + rowIndex * 2] as {
    columns: { columnItems: Array<{ widgets: Array<{ textParagraph?: { text: string } }> }> };
  };
  return widget.columns.columnItems[1]!.widgets[0]!.textParagraph!.text;
}

test('builds one fallback message with two cards containing ranks 1 through 20 exactly once', () => {
  const message = buildFundingChatMessage(leaderboard());

  assert.equal(message.text, `Binance Funding Top20（截至 ${AS_OF}）`);
  assert.equal(message.cardsV2.length, 2);
  assert.equal(message.cardsV2[0]!.cardId, 'binance-funding-1-10');
  assert.equal(message.cardsV2[1]!.cardId, 'binance-funding-11-20');

  const ranks = JSON.stringify(message.cardsV2).match(/#(\d+) · Binance/g) ?? [];
  assert.deepEqual(ranks, Array.from({ length: 20 }, (_, index) => `#${index + 1} · Binance`));
});

test('puts ranks 1 through 10 in the first card with a two-column row and dividers between rows', () => {
  const message = buildFundingChatMessage(leaderboard());
  const widgets = sectionWidgets(message, 0);
  const rows = widgets.filter((widget): widget is { columns: { columnItems: unknown[] } } =>
    typeof widget === 'object' && widget !== null && 'columns' in widget
  );

  assert.equal(rows.length, 10);
  assert.deepEqual(rows.map((widget) => {
    const first = widget.columns.columnItems[0] as { widgets: Array<{ decoratedText: { topLabel: string } }> };
    return first.widgets[0]!.decoratedText.topLabel;
  }), Array.from({ length: 10 }, (_, index) => `#${index + 1} · Binance`));
  assert.deepEqual(rows[0]!.columns.columnItems, [
    {
      horizontalSizeStyle: 'FILL_MINIMUM_SPACE',
      verticalAlignment: 'TOP',
      widgets: [{ decoratedText: { topLabel: '#1 · Binance', text: '<b>ASSET1</b>' } }]
    },
    {
      horizontalSizeStyle: 'FILL_AVAILABLE_SPACE',
      verticalAlignment: 'TOP',
      widgets: [{ textParagraph: { text: '当前：<font color="#D93025">+0.0100%</font>/1h（87.60%）<br>24h：<font color="#D93025">+0.0300%</font>（10.95%）<br>7日：<font color="#D93025">+0.0500%</font>（2.61%）' } }]
    }
  ]);
  assert.equal(widgets.filter((widget) => JSON.stringify(widget) === JSON.stringify({ divider: {} })).length, 9);
});

test('puts ranks 11 through 20 in the second card and retains current 4h and 8h periods', () => {
  const message = buildFundingChatMessage(leaderboard());
  const widgets = sectionWidgets(message, 1);
  const rows = widgets.filter((widget): widget is { columns: { columnItems: unknown[] } } =>
    typeof widget === 'object' && widget !== null && 'columns' in widget
  );

  assert.equal(rows.length, 10);
  assert.deepEqual(rows.map((widget) => {
    const first = widget.columns.columnItems[0] as { widgets: Array<{ decoratedText: { topLabel: string } }> };
    return first.widgets[0]!.decoratedText.topLabel;
  }), Array.from({ length: 10 }, (_, index) => `#${index + 11} · Binance`));
  assert.match(cardText(message, 1), /\/4h/);
  assert.match(cardText(message, 1), /\/8h/);
  assert.equal(widgets.filter((widget) => JSON.stringify(widget) === JSON.stringify({ divider: {} })).length, 9);
});

test('includes the specified card copy, signed color semantics, and partial-history marker', () => {
  const message = buildFundingChatMessage(leaderboard());
  const firstCard = message.cardsV2[0]!.card as { header: { title: string; subtitle: string } };
  const serialized = JSON.stringify(message);

  assert.equal(firstCard.header.title, 'Binance Funding Top20 · #1–10');
  assert.equal(firstCard.header.subtitle, `统计时间：${AS_OF}`);
  assert.match(serialized, /按过去 24 小时累计 Funding 从高到低排序。/);
  assert.match(serialized, /Funding 为正表示多头支付空头。/);
  assert.match(serialized, /括号内为 APR 年化。/);
  assert.match(serialized, /\* 新上线资产的 7 日数据按可用历史累计。/);
  assert.match(metricsText(message, 0, 0), /<font color="#D93025">\+0\.0100%<\/font>/);
  assert.match(metricsText(message, 0, 1), /<font color="#188038">-0\.0200%<\/font>/);
  assert.match(metricsText(message, 0, 2), /当前：0\.0000%\/8h/);
  assert.match(metricsText(message, 0, 2), /\+0\.0500%<\/font>（2\.61%）\*/);
});

test('makes Funding direction visible with a sign before color, including rounded positive zero', () => {
  const message = buildFundingChatMessage(leaderboard([
    row(1, { currentRate: new Decimal('0.0001') }),
    row(2, { currentRate: new Decimal('0.0000000001') }),
    row(3, { currentRate: new Decimal('0') }),
    row(4, { currentRate: new Decimal('-0.0002') }),
    ...Array.from({ length: 16 }, (_, index) => row(index + 5))
  ]));

  assert.match(metricsText(message, 0, 0), /当前：<font color="#D93025">\+0\.0100%<\/font>/);
  assert.match(metricsText(message, 0, 1), /当前：<font color="#D93025">\+0\.0000%<\/font>/);
  assert.match(metricsText(message, 0, 2), /当前：0\.0000%\/8h/);
  assert.doesNotMatch(metricsText(message, 0, 2), /当前：\+/);
  assert.match(metricsText(message, 0, 3), /当前：<font color="#188038">-0\.0200%<\/font>/);
});

test('escapes every dynamic HTML value and stays below the Google Chat UTF-8 message limit', () => {
  const message = buildFundingChatMessage(leaderboard([
    row(1, { asset: `A&<B>\"'`, symbol: `A&<B>\"'USDT` }),
    ...Array.from({ length: 19 }, (_, index) => row(index + 2))
  ]));
  const serialized = JSON.stringify(message);

  assert.match(serialized, /<b>A&amp;&lt;B&gt;&quot;&#39;<\/b>/);
  assert.ok(Buffer.byteLength(serialized, 'utf8') < 32_000);
});

test('rejects an oversized message instead of truncating text or dropping rows', () => {
  const rows = Array.from({ length: 20 }, (_, index) => row(index + 1, {
    asset: `ASSET-${index + 1}-${'币'.repeat(2_000)}`
  }));

  assert.throws(() => buildFundingChatMessage(leaderboard(rows)), {
    message: 'Google Chat message exceeds 32000 bytes'
  });
});

test('accepts 31999 UTF-8 bytes and rejects exactly 32000 UTF-8 bytes', () => {
  const rowsWithAssetLength = (assetLength: number) => [
    row(1, { asset: 'A'.repeat(assetLength) }),
    ...Array.from({ length: 19 }, (_, index) => row(index + 2))
  ];
  const accepted = buildFundingChatMessage(leaderboard(rowsWithAssetLength(21_347)));

  assert.equal(Buffer.byteLength(JSON.stringify(accepted), 'utf8'), 31_999);
  assert.throws(
    () => buildFundingChatMessage(leaderboard(rowsWithAssetLength(21_348))),
    { message: 'Google Chat message exceeds 32000 bytes' }
  );
});
