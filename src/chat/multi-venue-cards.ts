import type {
  CompositeFundingLeaderboard,
  CompositeFundingRow,
  CompositeVenueFundingMetric,
  GoogleChatMessage,
  VenueId
} from '../domain.js';
import { signedAprPercent, signedFundingPercent, VENUE_LABELS } from '../funding/multi-venue-format.js';

const MAX_MESSAGE_BYTES = 32_000;
const POSITIVE_FUNDING_COLOR = '#D93025';
const NEGATIVE_FUNDING_COLOR = '#188038';
const VENUES: VenueId[] = ['binance', 'okx', 'hyperliquid', 'bybit', 'bitget'];

export class GoogleChatPayloadSizeError extends Error {
  constructor(readonly payloadBytes: number) {
    super('Google Chat message exceeds 32000 bytes');
    this.name = 'GoogleChatPayloadSizeError';
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function colored(value: string, sign: number): string {
  const escaped = escapeHtml(value);
  if (sign > 0) return `<font color="${POSITIVE_FUNDING_COLOR}">${escaped}</font>`;
  if (sign < 0) return `<font color="${NEGATIVE_FUNDING_COLOR}">${escaped}</font>`;
  return escaped;
}

function fundingHtml(metric: CompositeVenueFundingMetric): string {
  return colored(signedFundingPercent(metric.nextFundingRate), metric.nextFundingRate.comparedTo(0));
}

function aprHtml(metric: CompositeVenueFundingMetric): string {
  return colored(signedAprPercent(metric.nextApr), metric.nextApr.comparedTo(0));
}

function historyHtml(metric: CompositeVenueFundingMetric): string {
  if (metric.sevenDayAverageDailyRate === null || metric.sevenDayApr === null) return '--';
  return `${colored(signedFundingPercent(metric.sevenDayAverageDailyRate), metric.sevenDayAverageDailyRate.comparedTo(0))}/日 (${colored(signedAprPercent(metric.sevenDayApr), metric.sevenDayApr.comparedTo(0))})`;
}

function venueHtml(venue: VenueId, metric: CompositeVenueFundingMetric | undefined): string {
  const label = VENUE_LABELS[venue];
  if (metric === undefined) return `${label} 下次 --｜7日均 --`;
  const partialMarker = metric.partialSevenDayHistory ? '*' : '';
  return `${label} 下次 ${fundingHtml(metric)}/${escapeHtml(String(metric.intervalHours))}h (${aprHtml(metric)})｜7日均 ${historyHtml(metric)}${partialMarker}`;
}

function rowHtml(row: CompositeFundingRow): string {
  return [
    `<b>#${escapeHtml(String(row.rank))} ${escapeHtml(row.asset)}</b>｜综合预估 APR ${colored(signedAprPercent(row.compositeNextApr), row.compositeNextApr.comparedTo(0))}｜覆盖 ${escapeHtml(String(row.coverageCount))}/5`,
    ...VENUES.map((venue) => venueHtml(venue, row.venues[venue]))
  ].join('<br>');
}

function buildCard(rows: CompositeFundingRow[], title: string, asOf: number): Record<string, unknown> {
  const widgets: Array<Record<string, unknown>> = [
    { textParagraph: { text: '按有效平台的下一次 Funding APR 等权平均排序。' } }
  ];
  for (const [index, row] of rows.entries()) {
    widgets.push({ textParagraph: { text: rowHtml(row) } });
    if (index < rows.length - 1) widgets.push({ divider: {} });
  }
  widgets.push({
    textParagraph: {
      text: 'Funding 为正表示多头支付空头。<br>下一次为当前预估；括号内为 APR。<br>* 表示该平台历史不足 7 日。'
    }
  });
  return {
    header: { title, subtitle: `统计时间：${asOf}` },
    sections: [{ widgets }]
  };
}

export function buildFundingChatMessage(leaderboard: CompositeFundingLeaderboard): GoogleChatMessage {
  const message: GoogleChatMessage = {
    text: `五交易所 Funding Top20（截至 ${leaderboard.asOf}）`,
    cardsV2: [
      {
        cardId: 'funding-top20-1-10',
        card: buildCard(leaderboard.rows.slice(0, 10), '五交易所 Funding Top20 · #1–10', leaderboard.asOf)
      },
      {
        cardId: 'funding-top20-11-20',
        card: buildCard(leaderboard.rows.slice(10, 20), '五交易所 Funding Top20 · #11–20', leaderboard.asOf)
      }
    ]
  };

  const payloadBytes = Buffer.byteLength(JSON.stringify(message), 'utf8');
  if (payloadBytes >= MAX_MESSAGE_BYTES) {
    throw new GoogleChatPayloadSizeError(payloadBytes);
  }
  return message;
}
