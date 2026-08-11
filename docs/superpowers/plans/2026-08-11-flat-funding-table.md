# Flat Funding Summary Table Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the per-asset venue-card images with two compact eight-column Top10 tables that show five venue next-Funding values plus cross-venue 7D / Day and 7D APR equal-weight averages.

**Architecture:** Add one pure funding-domain helper that derives the row-level seven-day summary from hydrated venue metrics without changing ranking or history collection. Rebuild only the SVG renderer around a fixed eight-column table; preserve the existing image-renderer interface, GitHub publisher, Chat payload, scheduler, and deployment configuration.

**Tech Stack:** Node.js 24, TypeScript, Decimal.js, SVG, Sharp, Node test runner

## Global Constraints

- Produce exactly two images for ranks 1–10 and 11–20.
- SVG width remains 800 units and PNG width remains 1600 pixels at 2× density.
- Fixed columns are Asset, Binance, OKX, Hyper, Bybit, Bitget, 7D / Day Avg, and 7D APR Avg.
- Venue cells show next Funding on line one and annualized next APR on line two; missing venues show `--`.
- Cross-venue 7D values use equal weights across venues with non-null seven-day daily rates and APRs; missing values do not enter the denominator.
- Fewer than two valid histories produces null summaries rendered as `--*`.
- 7D APR is derived from the unrounded cross-venue daily average multiplied by 365.
- Any participating venue with partial history adds `*` to both summary cells.
- Preserve positive red, negative green, zero neutral, XML escaping, rank order, and all non-renderer behavior.
- Add no dependency, environment variable, 30-day history, OI weighting, or volume weighting.

---

### Task 1: Cross-venue seven-day summary

**Files:**
- Create: `src/funding/seven-day-composite.ts`
- Create: `test/funding/seven-day-composite.test.ts`

**Interfaces:**
- Consumes: `CompositeFundingRow` with hydrated `CompositeVenueFundingMetric` values.
- Produces: `compositeSevenDay(row): CompositeSevenDaySummary` where the summary contains `averageDailyRate`, `apr`, `partialHistory`, and `venueCount`.

- [x] **Step 1: Write failing helper tests**

Create literal fixtures covering three valid venues, one missing history, a partial venue, and fewer than two valid histories. The core hand-calculated assertion is:

```ts
const summary = compositeSevenDay(rowWithDailyRates('0.003196', '0.004458', '0.003509'));
assert.equal(summary.averageDailyRate?.toString(), '0.003721');
assert.equal(summary.apr?.toString(), '1.358165');
assert.equal(summary.venueCount, 3);
assert.equal(summary.partialHistory, false);
```

Also assert that a null venue is excluded from the denominator, any participating partial venue sets `partialHistory`, and one valid history returns both values as null with `venueCount: 1`.

- [x] **Step 2: Run the helper test and verify RED**

Run:

```bash
npx -y node@24 --import tsx --test test/funding/seven-day-composite.test.ts
```

Expected: FAIL because `src/funding/seven-day-composite.ts` does not exist.

- [x] **Step 3: Implement the pure helper**

Create:

```ts
export interface CompositeSevenDaySummary {
  averageDailyRate: Decimal | null;
  apr: Decimal | null;
  partialHistory: boolean;
  venueCount: number;
}

export function compositeSevenDay(row: CompositeFundingRow): CompositeSevenDaySummary {
  const metrics = Object.values(row.venues).filter(
    (metric): metric is CompositeVenueFundingMetric =>
      metric !== undefined
      && metric.sevenDayAverageDailyRate !== null
      && metric.sevenDayApr !== null
  );
  if (metrics.length < 2) {
    return { averageDailyRate: null, apr: null, partialHistory: true, venueCount: metrics.length };
  }
  const averageDailyRate = metrics
    .reduce((sum, metric) => sum.plus(metric.sevenDayAverageDailyRate!), new Decimal(0))
    .div(metrics.length);
  return {
    averageDailyRate,
    apr: averageDailyRate.times(365),
    partialHistory: metrics.some((metric) => metric.partialSevenDayHistory),
    venueCount: metrics.length
  };
}
```

- [x] **Step 4: Run the helper test and verify GREEN**

Run the same focused command. Expected: all helper tests pass with zero failures.

---

### Task 2: Eight-column flat SVG table

**Files:**
- Modify: `src/image/funding-report.ts`
- Modify: `test/image/funding-report.test.ts`

**Interfaces:**
- Consumes: `compositeSevenDay(row)` from Task 1 and the existing `CompositeFundingLeaderboard`.
- Produces: unchanged `renderFundingReportSvg(leaderboard, start, end): string` and `renderFundingReportImages(leaderboard): Promise<FundingReportImage[]>`.

- [x] **Step 1: Rewrite renderer expectations and verify RED**

Update the renderer tests to assert:

```ts
assert.match(svg, />Asset</);
assert.match(svg, />Binance</);
assert.match(svg, />OKX</);
assert.match(svg, />Hyper</);
assert.match(svg, />Bybit</);
assert.match(svg, />Bitget</);
assert.match(svg, />7D \/ Day</);
assert.match(svg, />7D APR</);
assert.match(svg, /APR \+10\.95%/);
assert.match(svg, /\+0\.0220%/);
assert.match(svg, /\+8\.03%/);
```

Replace the dynamic-card test with a fixed-column missing-venue test that expects Binance and Bybit values plus `--` cells for OKX, Hyper, and Bitget. Assert exactly ten asset symbols and exact 800-unit SVG/1600-pixel PNG dimensions.

Run:

```bash
npx -y node@24 --import tsx --test test/image/funding-report.test.ts
```

Expected: FAIL because the renderer still produces per-asset venue rows instead of the flat table.

- [x] **Step 2: Implement the fixed table renderer**

Use these layout values:

```ts
const WIDTH = 800;
const PAGE_PADDING = 24;
const HEADER_HEIGHT = 104;
const TABLE_HEADER_HEIGHT = 38;
const ASSET_ROW_HEIGHT = 64;
const FOOTER_HEIGHT = 44;
```

Use fixed column boundaries `[24, 96, 198, 300, 402, 504, 606, 696, 776]`. Render one table header, ten asset rows, and a footer. Each venue cell uses two centered lines; the final two cells use `compositeSevenDay(row)`. Keep the current title and timestamp formatter but change the subtitle to `Equal-weight available Next APR · 7D summaries equal-weight valid venues`.

- [x] **Step 3: Run focused renderer and helper tests**

Run:

```bash
npx -y node@24 --import tsx --test test/funding/seven-day-composite.test.ts test/image/funding-report.test.ts
```

Expected: both files pass, including missing venue/history, partial history, signed colors, escaping, two images, and dimensions.

- [x] **Step 4: Run full project verification**

Run:

```bash
npm run typecheck
npm run build
npx -y node@24 --import tsx --test test/*.test.ts test/**/*.test.ts
```

Expected: typecheck and build exit 0; all tests pass with zero failures.

- [x] **Step 5: Generate, publish, send, and inspect real images**

Run:

```bash
npx -y node@24 dist/cli.js --send --force
```

Expected: two 1600-pixel-wide GitHub images replace the current slot, Google Chat accepts one message, and visual inspection confirms all eight columns and ten rows are legible without clipping.

- [x] **Step 6: Commit and push main**

```bash
git add src/funding/seven-day-composite.ts test/funding/seven-day-composite.test.ts src/image/funding-report.ts test/image/funding-report.test.ts docs/superpowers/plans/2026-08-11-flat-funding-table.md
git commit -m "feat: render flat funding summary tables"
git push origin main
```
