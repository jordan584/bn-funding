import type { FundingLeaderboard, FundingRow, GoogleChatMessage } from '../domain.js';
import { formatAprPercent, formatFundingPercent } from '../funding/format.js';

const MAX_MESSAGE_BYTES = 32_000;
const POSITIVE_FUNDING_COLOR = '#D93025';
const NEGATIVE_FUNDING_COLOR = '#188038';

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function fundingHtml(value: string, sign: number): string {
  if (sign > 0) {
    return `<font color="${POSITIVE_FUNDING_COLOR}">${escapeHtml(value)}</font>`;
  }
  if (sign < 0) {
    return `<font color="${NEGATIVE_FUNDING_COLOR}">${escapeHtml(value)}</font>`;
  }
  return escapeHtml(value);
}

function metricsHtml(row: FundingRow): string {
  const current = fundingHtml(formatFundingPercent(row.currentRate), row.currentRate.comparedTo(0));
  const funding24h = fundingHtml(formatFundingPercent(row.funding24h), row.funding24h.comparedTo(0));
  const funding7d = fundingHtml(formatFundingPercent(row.funding7d), row.funding7d.comparedTo(0));
  const partialMarker = row.partialSevenDayHistory ? '*' : '';

  return [
    `当前：${current}/${row.intervalHours}h（${escapeHtml(formatAprPercent(row.currentApr))}）`,
    `24h：${funding24h}（${escapeHtml(formatAprPercent(row.apr24h))}）`,
    `7日：${funding7d}（${escapeHtml(formatAprPercent(row.apr7d))}）${partialMarker}`
  ].join('<br>');
}

function rowWidget(row: FundingRow): Record<string, unknown> {
  return {
    columns: {
      columnItems: [
        {
          horizontalSizeStyle: 'FILL_MINIMUM_SPACE',
          verticalAlignment: 'TOP',
          widgets: [{
            decoratedText: {
              topLabel: `#${row.rank} · Binance`,
              text: `<b>${escapeHtml(row.asset)}</b>`
            }
          }]
        },
        {
          horizontalSizeStyle: 'FILL_AVAILABLE_SPACE',
          verticalAlignment: 'TOP',
          widgets: [{ textParagraph: { text: metricsHtml(row) } }]
        }
      ]
    }
  };
}

function buildCard(rows: FundingRow[], title: string, asOf: number): Record<string, unknown> {
  const widgets: Record<string, unknown>[] = [
    { textParagraph: { text: '按过去 24 小时累计 Funding 从高到低排序。' } }
  ];
  for (const [index, row] of rows.entries()) {
    widgets.push(rowWidget(row));
    if (index < rows.length - 1) {
      widgets.push({ divider: {} });
    }
  }
  widgets.push({
    textParagraph: {
      text: 'Funding 为正表示多头支付空头。<br>括号内为 APR 年化。<br>* 新上线资产的 7 日数据按可用历史累计。'
    }
  });

  return {
    header: { title, subtitle: `统计时间：${asOf}` },
    sections: [{ widgets }]
  };
}

export function buildFundingChatMessage(leaderboard: FundingLeaderboard): GoogleChatMessage {
  const message: GoogleChatMessage = {
    text: `Binance Funding Top20（截至 ${leaderboard.asOf}）`,
    cardsV2: [
      {
        cardId: 'binance-funding-1-10',
        card: buildCard(leaderboard.rows.slice(0, 10), 'Binance Funding Top20 · #1–10', leaderboard.asOf)
      },
      {
        cardId: 'binance-funding-11-20',
        card: buildCard(leaderboard.rows.slice(10, 20), 'Binance Funding Top20 · #11–20', leaderboard.asOf)
      }
    ]
  };

  if (Buffer.byteLength(JSON.stringify(message), 'utf8') >= MAX_MESSAGE_BYTES) {
    throw new Error('Google Chat message exceeds 32000 bytes');
  }
  return message;
}
