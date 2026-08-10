import sharp from 'sharp';

import type {
  CompositeFundingLeaderboard,
  CompositeFundingRow,
  CompositeVenueFundingMetric,
  VenueId
} from '../domain.js';
import {
  signedAprPercent,
  signedFundingPercent,
  VENUE_LABELS
} from '../funding/multi-venue-format.js';

export type FundingImageRange = '1-10' | '11-20';

export interface FundingReportImage {
  range: FundingImageRange;
  png: Buffer;
}

const WIDTH = 1440;
const PAGE_PADDING = 48;
const HEADER_HEIGHT = 174;
const ASSET_HEADER_HEIGHT = 50;
const TABLE_HEADER_HEIGHT = 34;
const VENUE_ROW_HEIGHT = 34;
const ASSET_GAP = 16;
const FOOTER_HEIGHT = 72;
const VENUES: VenueId[] = ['binance', 'okx', 'hyperliquid', 'bybit', 'bitget'];

const COLORS = {
  background: '#0b1020',
  panel: '#151c2f',
  panelAlt: '#11182a',
  border: '#28334d',
  text: '#f3f6ff',
  muted: '#93a0bb',
  positive: '#ff6b6b',
  negative: '#2ed6a1',
  accent: '#7aa2ff'
} as const;

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function valueColor(sign: number): string {
  if (sign > 0) return COLORS.positive;
  if (sign < 0) return COLORS.negative;
  return COLORS.text;
}

function text(x: number, y: number, value: string, options: {
  size?: number;
  fill?: string;
  weight?: number;
  className?: string;
  anchor?: 'start' | 'middle' | 'end';
} = {}): string {
  const attributes = [
    `x="${x}"`,
    `y="${y}"`,
    `font-size="${options.size ?? 22}"`,
    `font-weight="${options.weight ?? 400}"`,
    `fill="${options.fill ?? COLORS.text}"`,
    `text-anchor="${options.anchor ?? 'start'}"`,
    ...(options.className === undefined ? [] : [`class="${options.className}"`])
  ];
  return `<text ${attributes.join(' ')}>${escapeXml(value)}</text>`;
}

function formatBeijingTime(timestamp: number): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(timestamp);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')} CST`;
}

interface VenueCells {
  nextFunding: string;
  interval: string;
  nextApr: string;
  historyDaily: string;
  historyApr: string;
  nextSign: number;
  historySign: number;
}

function venueCells(metric: CompositeVenueFundingMetric | undefined): VenueCells {
  if (metric === undefined) {
    return {
      nextFunding: '--', interval: '--', nextApr: '--', historyDaily: '--', historyApr: '--',
      nextSign: 0, historySign: 0
    };
  }
  const partial = metric.partialSevenDayHistory ? '*' : '';
  return {
    nextFunding: signedFundingPercent(metric.nextFundingRate),
    interval: `${metric.intervalHours}h`,
    nextApr: signedAprPercent(metric.nextApr),
    historyDaily: metric.sevenDayAverageDailyRate === null
      ? `--${partial}`
      : `${signedFundingPercent(metric.sevenDayAverageDailyRate)}${partial}`,
    historyApr: metric.sevenDayApr === null
      ? `--${partial}`
      : `${signedAprPercent(metric.sevenDayApr)}${partial}`,
    nextSign: metric.nextFundingRate.comparedTo(0),
    historySign: metric.sevenDayAverageDailyRate?.comparedTo(0) ?? 0
  };
}

function presentVenues(row: CompositeFundingRow): VenueId[] {
  return VENUES.filter((venue) => row.venues[venue] !== undefined);
}

function assetHeight(row: CompositeFundingRow): number {
  return ASSET_HEADER_HEIGHT + TABLE_HEADER_HEIGHT + VENUE_ROW_HEIGHT * presentVenues(row).length;
}

function assetBlock(row: CompositeFundingRow, y: number): string {
  const left = PAGE_PADDING;
  const width = WIDTH - PAGE_PADDING * 2;
  const columns = [left + 28, left + 220, left + 535, left + 690, left + 900, left + 1170];
  const tableTop = y + ASSET_HEADER_HEIGHT;
  const venues = presentVenues(row);
  const height = assetHeight(row);
  const output = [
    `<rect x="${left}" y="${y}" width="${width}" height="${height}" rx="14" fill="${COLORS.panel}" stroke="${COLORS.border}"/>`,
    `<rect x="${left}" y="${tableTop}" width="${width}" height="${TABLE_HEADER_HEIGHT}" fill="${COLORS.panelAlt}"/>`,
    text(left + 22, y + 33, `#${row.rank}`, { size: 24, fill: COLORS.accent, weight: 700 }),
    text(left + 92, y + 33, row.asset, { size: 25, weight: 700, className: 'asset-symbol' }),
    text(left + 400, y + 32, 'Composite Next APR', { size: 18, fill: COLORS.muted }),
    text(left + 625, y + 33, signedAprPercent(row.compositeNextApr), {
      size: 23, fill: valueColor(row.compositeNextApr.comparedTo(0)), weight: 700
    }),
    text(left + width - 22, y + 32, `Coverage ${row.coverageCount}/5`, {
      size: 18, fill: COLORS.muted, anchor: 'end'
    }),
    text(columns[0]!, tableTop + 23, 'Venue', { size: 16, fill: COLORS.muted, weight: 600 }),
    text(columns[1]!, tableTop + 23, 'Next Funding', { size: 16, fill: COLORS.muted, weight: 600 }),
    text(columns[2]!, tableTop + 23, 'Interval', { size: 16, fill: COLORS.muted, weight: 600 }),
    text(columns[3]!, tableTop + 23, 'Next APR', { size: 16, fill: COLORS.muted, weight: 600 }),
    text(columns[4]!, tableTop + 23, '7D Avg / Day', { size: 16, fill: COLORS.muted, weight: 600 }),
    text(columns[5]!, tableTop + 23, '7D APR', { size: 16, fill: COLORS.muted, weight: 600 })
  ];

  for (const [index, venue] of venues.entries()) {
    const rowTop = tableTop + TABLE_HEADER_HEIGHT + index * VENUE_ROW_HEIGHT;
    const baseline = rowTop + 24;
    const cells = venueCells(row.venues[venue]);
    if (index > 0) {
      output.push(`<line x1="${left + 20}" y1="${rowTop}" x2="${left + width - 20}" y2="${rowTop}" stroke="${COLORS.border}"/>`);
    }
    output.push(
      text(columns[0]!, baseline, VENUE_LABELS[venue], { size: 18, weight: 600 }),
      text(columns[1]!, baseline, cells.nextFunding, { size: 18, fill: valueColor(cells.nextSign) }),
      text(columns[2]!, baseline, cells.interval, { size: 18, fill: COLORS.muted }),
      text(columns[3]!, baseline, cells.nextApr, { size: 18, fill: valueColor(cells.nextSign) }),
      text(columns[4]!, baseline, cells.historyDaily, { size: 18, fill: valueColor(cells.historySign) }),
      text(columns[5]!, baseline, cells.historyApr, { size: 18, fill: valueColor(cells.historySign) })
    );
  }
  return output.join('');
}

export function renderFundingReportSvg(
  leaderboard: CompositeFundingLeaderboard,
  start: number,
  end: number
): string {
  const rows = leaderboard.rows.slice(start, end);
  if (rows.length !== 10) {
    throw new Error(`Funding report image requires exactly 10 rows, received ${rows.length}`);
  }
  const height = HEADER_HEIGHT
    + rows.reduce((sum, row) => sum + assetHeight(row) + ASSET_GAP, 0)
    + FOOTER_HEIGHT;
  const firstRank = rows[0]!.rank;
  const lastRank = rows.at(-1)!.rank;
  let nextY = HEADER_HEIGHT;
  const blocks = rows.map((row) => {
    const block = assetBlock(row, nextY);
    nextY += assetHeight(row) + ASSET_GAP;
    return block;
  });
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}">`,
    `<rect width="100%" height="100%" fill="${COLORS.background}"/>`,
    '<style>text { font-family: Arial, "DejaVu Sans", sans-serif; }</style>',
    text(PAGE_PADDING, 58, `5-Venue Funding Top20 · #${firstRank}–${lastRank}`, { size: 34, weight: 700 }),
    text(PAGE_PADDING, 96, `Updated ${formatBeijingTime(leaderboard.asOf)}`, { size: 20, fill: COLORS.muted }),
    text(PAGE_PADDING, 133, 'Ranked by equal-weight average of available Next Funding APR · minimum 2 venues', { size: 19, fill: COLORS.muted }),
    ...blocks,
    text(PAGE_PADDING, height - 32, 'Positive Funding: longs pay shorts  ·  * history shorter than 7 days', { size: 18, fill: COLORS.muted }),
    '</svg>'
  ].join('');
}

export async function renderFundingReportImages(
  leaderboard: CompositeFundingLeaderboard
): Promise<FundingReportImage[]> {
  const definitions = [
    { range: '1-10' as const, start: 0, end: 10 },
    { range: '11-20' as const, start: 10, end: 20 }
  ];
  return Promise.all(definitions.map(async ({ range, start, end }) => ({
    range,
    png: await sharp(Buffer.from(renderFundingReportSvg(leaderboard, start, end)), { density: 144 })
      .png({ compressionLevel: 9, adaptiveFiltering: true })
      .toBuffer()
  })));
}
