import sharp from 'sharp';

import type {
  CompositeFundingLeaderboard,
  CompositeFundingRow,
  CompositeVenueFundingMetric,
  VenueId
} from '../domain.js';
import {
  signedAprPercent,
  signedFundingPercent
} from '../funding/multi-venue-format.js';
import { compositeSevenDay } from '../funding/seven-day-composite.js';

export type FundingImageRange = '1-10' | '11-20';

export interface FundingReportImage {
  range: FundingImageRange;
  png: Buffer;
}

const WIDTH = 800;
const PAGE_PADDING = 24;
const HEADER_HEIGHT = 104;
const TABLE_HEADER_HEIGHT = 38;
const ASSET_ROW_HEIGHT = 64;
const FOOTER_HEIGHT = 44;
const ROW_COUNT = 10;
const HEIGHT = HEADER_HEIGHT + TABLE_HEADER_HEIGHT + ASSET_ROW_HEIGHT * ROW_COUNT + FOOTER_HEIGHT;

const VENUES: Array<{ id: VenueId; label: string }> = [
  { id: 'binance', label: 'Binance' },
  { id: 'okx', label: 'OKX' },
  { id: 'hyperliquid', label: 'Hyper' },
  { id: 'bybit', label: 'Bybit' },
  { id: 'bitget', label: 'Bitget' }
];

const COLUMN_BOUNDARIES = [24, 110, 188, 272, 356, 440, 524, 608, 692, 776] as const;
const COLUMN_CENTERS = COLUMN_BOUNDARIES.slice(0, -1).map(
  (left, index) => (left + COLUMN_BOUNDARIES[index + 1]!) / 2
);

const COLORS = {
  background: '#0b1020',
  panel: '#151c2f',
  panelAlt: '#11182a',
  rowAlt: '#131a2c',
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

function compactAsset(asset: string): string {
  return asset.length <= 9 ? asset : `${asset.slice(0, 8)}…`;
}

function assetFontSize(asset: string): number {
  if (asset.length <= 6) return 15;
  if (asset.length <= 8) return 13;
  return 12;
}

function venueCell(metric: CompositeVenueFundingMetric | undefined, x: number, rowTop: number): string {
  if (metric === undefined) {
    return text(x, rowTop + 38, '--', { size: 15, fill: COLORS.muted, anchor: 'middle' });
  }

  const sign = metric.nextFundingRate.comparedTo(0);
  return [
    text(x, rowTop + 27, signedFundingPercent(metric.nextFundingRate), {
      size: 13,
      fill: valueColor(sign),
      weight: 600,
      anchor: 'middle'
    }),
    text(x, rowTop + 48, `APR ${signedAprPercent(metric.nextApr)}`, {
      size: 10,
      fill: valueColor(metric.nextApr.comparedTo(0)),
      anchor: 'middle'
    })
  ].join('');
}

function summaryCell(
  value: string,
  sign: number,
  venueCount: number,
  x: number,
  rowTop: number
): string {
  return [
    text(x, rowTop + 29, value, {
      size: 14,
      fill: valueColor(sign),
      weight: 700,
      anchor: 'middle'
    }),
    text(x, rowTop + 48, venueCount > 0 ? `${venueCount} venues` : 'No history', {
      size: 9,
      fill: COLORS.muted,
      anchor: 'middle'
    })
  ].join('');
}

function compositeCell(row: CompositeFundingRow, x: number, rowTop: number): string {
  return [
    text(x, rowTop + 29, signedAprPercent(row.compositeNextApr), {
      size: 13,
      fill: valueColor(row.compositeNextApr.comparedTo(0)),
      weight: 700,
      anchor: 'middle',
      className: 'composite-apr'
    }),
    text(x, rowTop + 48, 'Next avg', {
      size: 9,
      fill: COLORS.muted,
      anchor: 'middle'
    })
  ].join('');
}

function assetRow(row: CompositeFundingRow, index: number): string {
  const rowTop = HEADER_HEIGHT + TABLE_HEADER_HEIGHT + index * ASSET_ROW_HEIGHT;
  const summary = compositeSevenDay(row);
  const suffix = summary.partialHistory ? '*' : '';
  const dailyValue = summary.averageDailyRate === null
    ? '--*'
    : `${signedFundingPercent(summary.averageDailyRate)}${suffix}`;
  const aprValue = summary.apr === null
    ? '--*'
    : `${signedAprPercent(summary.apr)}${suffix}`;
  const output = [
    `<rect x="${PAGE_PADDING}" y="${rowTop}" width="${WIDTH - PAGE_PADDING * 2}" height="${ASSET_ROW_HEIGHT}" fill="${index % 2 === 0 ? COLORS.panel : COLORS.rowAlt}"/>`,
    text(COLUMN_BOUNDARIES[0] + 8, rowTop + 22, `#${row.rank}`, {
      size: 12,
      fill: COLORS.accent,
      weight: 700
    }),
    text(COLUMN_CENTERS[0]!, rowTop + 45, compactAsset(row.asset), {
      size: assetFontSize(row.asset),
      weight: 700,
      anchor: 'middle',
      className: 'asset-symbol'
    }),
    compositeCell(row, COLUMN_CENTERS[1]!, rowTop)
  ];

  for (const [venueIndex, venue] of VENUES.entries()) {
    output.push(venueCell(row.venues[venue.id], COLUMN_CENTERS[venueIndex + 2]!, rowTop));
  }
  output.push(
    summaryCell(
      dailyValue,
      summary.averageDailyRate?.comparedTo(0) ?? 0,
      summary.venueCount,
      COLUMN_CENTERS[7]!,
      rowTop
    ),
    summaryCell(
      aprValue,
      summary.apr?.comparedTo(0) ?? 0,
      summary.venueCount,
      COLUMN_CENTERS[8]!,
      rowTop
    ),
    `<line x1="${PAGE_PADDING}" y1="${rowTop + ASSET_ROW_HEIGHT}" x2="${WIDTH - PAGE_PADDING}" y2="${rowTop + ASSET_ROW_HEIGHT}" stroke="${COLORS.border}" stroke-opacity="0.75"/>`
  );
  return output.join('');
}

function tableHeader(): string {
  const y = HEADER_HEIGHT;
  const labels = ['Asset', 'Composite APR', ...VENUES.map(({ label }) => label), '7D / Day', '7D APR'];
  const output = [
    `<rect x="${PAGE_PADDING}" y="${y}" width="${WIDTH - PAGE_PADDING * 2}" height="${TABLE_HEADER_HEIGHT}" rx="10" fill="${COLORS.panelAlt}"/>`,
    `<rect x="${PAGE_PADDING}" y="${y + 10}" width="${WIDTH - PAGE_PADDING * 2}" height="${TABLE_HEADER_HEIGHT - 10}" fill="${COLORS.panelAlt}"/>`
  ];
  for (const [index, label] of labels.entries()) {
    output.push(text(COLUMN_CENTERS[index]!, y + 25, label, {
      size: index === 1 ? 10 : index >= 7 ? 11 : 12,
      fill: COLORS.muted,
      weight: 700,
      anchor: 'middle'
    }));
  }
  return output.join('');
}

export function renderFundingReportSvg(
  leaderboard: CompositeFundingLeaderboard,
  start: number,
  end: number
): string {
  const rows = leaderboard.rows.slice(start, end);
  if (rows.length !== ROW_COUNT) {
    throw new Error(`Funding report image requires exactly 10 rows, received ${rows.length}`);
  }
  const firstRank = rows[0]!.rank;
  const lastRank = rows.at(-1)!.rank;
  const tableBottom = HEADER_HEIGHT + TABLE_HEADER_HEIGHT + ASSET_ROW_HEIGHT * ROW_COUNT;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">`,
    `<rect width="100%" height="100%" fill="${COLORS.background}"/>`,
    '<style>text { font-family: Arial, "DejaVu Sans", sans-serif; }</style>',
    text(PAGE_PADDING, 38, `5-Venue Stock Funding Top20 · #${firstRank}–${lastRank}`, { size: 25, weight: 700 }),
    text(PAGE_PADDING, 68, `Updated ${formatBeijingTime(leaderboard.asOf)} · ranked by absolute equal-weight Next APR`, {
      size: 13,
      fill: COLORS.muted
    }),
    text(PAGE_PADDING, 91, 'Universe: Binance bStocks · 7D metrics: equal-weight valid venue histories · min 2 venues', {
      size: 12,
      fill: COLORS.muted
    }),
    `<rect x="${PAGE_PADDING}" y="${HEADER_HEIGHT}" width="${WIDTH - PAGE_PADDING * 2}" height="${TABLE_HEADER_HEIGHT + ASSET_ROW_HEIGHT * ROW_COUNT}" rx="10" fill="none" stroke="${COLORS.border}"/>`,
    tableHeader(),
    ...rows.map(assetRow),
    ...COLUMN_BOUNDARIES.slice(1, -1).map((x) =>
      `<line x1="${x}" y1="${HEADER_HEIGHT}" x2="${x}" y2="${tableBottom}" stroke="${COLORS.border}" stroke-opacity="0.82"/>`
    ),
    text(PAGE_PADDING, HEIGHT - 16, 'Positive Funding: longs pay shorts  ·  APR annualized  ·  * partial / insufficient 7D history', {
      size: 11,
      fill: COLORS.muted
    }),
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
