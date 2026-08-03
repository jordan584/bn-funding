import { Decimal } from 'decimal.js';

import type { FundingLeaderboard, FundingRow } from '../domain.js';

export function formatFundingPercent(rate: Decimal): string {
  return `${rate.times(100).toFixed(4, Decimal.ROUND_HALF_UP)}%`;
}

export function formatAprPercent(apr: Decimal): string {
  return `${apr.times(100).toFixed(2, Decimal.ROUND_HALF_UP)}%`;
}

function renderRow(row: FundingRow): string {
  const partialMarker = row.partialSevenDayHistory ? '*' : '';
  return `${row.rank}. ${row.asset} (${row.exchange}) | Current: ${formatFundingPercent(row.currentRate)}/${row.intervalHours}h (${formatAprPercent(row.currentApr)}) | 24h: ${formatFundingPercent(row.funding24h)} (${formatAprPercent(row.apr24h)}) | 7d: ${formatFundingPercent(row.funding7d)} (${formatAprPercent(row.apr7d)})${partialMarker}`;
}

export function renderLeaderboardText(leaderboard: FundingLeaderboard): string {
  const lines = [
    `Binance Funding Top20 (as of ${leaderboard.asOf})`,
    ...leaderboard.rows.map(renderRow)
  ];
  if (leaderboard.rows.some((row) => row.partialSevenDayHistory)) {
    lines.push('* 新上线资产的 7 日数据按可用历史累计');
  }
  return lines.join('\n');
}
