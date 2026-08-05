import { Decimal } from 'decimal.js';

import type {
  CompositeFundingLeaderboard,
  CompositeFundingRow,
  CompositeVenueFundingMetric,
  VenueId
} from '../domain.js';

function formatFundingPercent(rate: Decimal): string {
  return `${rate.times(100).toFixed(4, Decimal.ROUND_HALF_UP)}%`;
}

function formatAprPercent(apr: Decimal): string {
  return `${apr.times(100).toFixed(2, Decimal.ROUND_HALF_UP)}%`;
}

export const VENUE_LABELS: Record<VenueId, string> = {
  binance: 'Bn',
  okx: 'OKX',
  hyperliquid: 'Hyper',
  bybit: 'Bybit',
  bitget: 'Bitget'
};

export function signedFundingPercent(value: Decimal): string {
  const formatted = formatFundingPercent(value);
  return value.gt(0) ? `+${formatted}` : formatted;
}

export function signedAprPercent(value: Decimal): string {
  const formatted = formatAprPercent(value);
  return value.gt(0) ? `+${formatted}` : formatted;
}

export function venueDisplayText(venue: VenueId, metric: CompositeVenueFundingMetric | undefined): string {
  const label = VENUE_LABELS[venue];
  if (metric === undefined) return `${label} 下次 --｜7日均 --`;

  const partialMarker = metric.partialSevenDayHistory ? '*' : '';
  const history = metric.sevenDayAverageDailyRate === null || metric.sevenDayApr === null
    ? '--'
    : `${signedFundingPercent(metric.sevenDayAverageDailyRate)}/日 (${signedAprPercent(metric.sevenDayApr)})`;
  return `${label} 下次 ${signedFundingPercent(metric.nextFundingRate)}/${metric.intervalHours}h (${signedAprPercent(metric.nextApr)})｜7日均 ${history}${partialMarker}`;
}

export function renderCompositeRowText(row: CompositeFundingRow): string {
  return [
    `#${row.rank} ${row.asset}｜综合预估 APR ${signedAprPercent(row.compositeNextApr)}｜覆盖 ${row.coverageCount}/5`,
    ...(['binance', 'okx', 'hyperliquid', 'bybit', 'bitget'] as const)
      .map((venue) => venueDisplayText(venue, row.venues[venue]))
  ].join('\n');
}

export function renderLeaderboardText(leaderboard: CompositeFundingLeaderboard): string {
  const lines = [
    `五交易所 Funding Top20（截至 ${leaderboard.asOf}）`,
    ...leaderboard.rows.map(renderCompositeRowText)
  ];
  if (leaderboard.rows.some((row) => Object.values(row.venues).some((metric) => metric?.partialSevenDayHistory))) {
    lines.push('* 表示该平台历史不足 7 日。');
  }
  return lines.join('\n');
}
