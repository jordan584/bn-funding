# Compact Funding Image Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce both Funding Top10 images to an 800-unit narrow layout with 1600-pixel 2× PNG output and roughly 35% less height while preserving every metric and dynamic venue filtering.

**Architecture:** Keep the existing `renderFundingReportSvg` and `renderFundingReportImages` interfaces. Change only the SVG layout constants, compact labels, text anchors, positions, and decoration inside the renderer; use exact SVG/PNG dimensions and existing content assertions as the consumer-visible regression boundary.

**Tech Stack:** Node.js 24, TypeScript, SVG, Sharp, Node test runner, Decimal.js

## Global Constraints

- SVG width is 800 units, horizontal page padding is 24 units, and PNG width is 1600 pixels.
- Header height is 110, asset header height is 36, table header height is 22, venue row height is 22, asset gap is 6, footer height is 42, and card radius is 10 SVG units.
- Render only venues present in each asset row; never add placeholder venue rows.
- Preserve Rank, asset, Composite APR, Coverage, Funding, Interval, Next APR, 7D Avg/Day, and 7D APR; right-align the five numeric columns inside the 752-unit content area.
- Preserve positive red, negative green, rank blue, XML escaping, two Top10 images, and all collection/publication/delivery behavior.
- Add no dependency, environment variable, or deployment change.

---

### Task 1: Compact the Funding SVG renderer

**Files:**
- Modify: `test/image/funding-report.test.ts`
- Modify: `src/image/funding-report.ts`

**Interfaces:**
- Consumes: `CompositeFundingLeaderboard`, `CompositeFundingRow`, and the existing dynamic `presentVenues(row)` behavior.
- Produces: unchanged `renderFundingReportSvg(leaderboard, start, end): string` and `renderFundingReportImages(leaderboard): Promise<FundingReportImage[]>` interfaces.

- [x] **Step 1: Write failing output-dimension tests**

Add a hand-derived full-coverage SVG height assertion:

```ts
assert.match(svg, /width="800" height="1892" viewBox="0 0 800 1892"/);
```

Update the two-venue compact assertion and verify the 2× PNG height:

```ts
assert.match(svg, /width="800" height="1232" viewBox="0 0 800 1232"/);

const images = await renderFundingReportImages(board);
const metadata = await sharp(images[0]!.png).metadata();
assert.equal(metadata.height, 2464);
assert.equal(metadata.width, 1600);
```

These literals are independently derived as `110 + 10 × (36 + 22 + venueCount × 22 + 6) + 42`.

- [x] **Step 2: Run the renderer test and verify RED**

Run:

```bash
npx -y node@24 --import tsx --test test/image/funding-report.test.ts
```

Expected: FAIL because the current SVG and PNG widths are 1440 and 2880, not 800 and 1600.

- [x] **Step 3: Implement the compact layout**

In `src/image/funding-report.ts`:

```ts
const WIDTH = 800;
const PAGE_PADDING = 24;
const HEADER_HEIGHT = 110;
const ASSET_HEADER_HEIGHT = 36;
const TABLE_HEADER_HEIGHT = 22;
const VENUE_ROW_HEIGHT = 22;
const ASSET_GAP = 6;
const FOOTER_HEIGHT = 42;
```

Then align the SVG elements to those dimensions:

- use card radius `10`;
- use compact baselines centered within 36/22/22-unit rows;
- combine update time and equal-weight ranking copy into one metadata line;
- shorten table headings to `Venue`, `Funding`, `Int.`, `APR`, `7D / Day`, and `7D APR`;
- reduce title, asset, metadata, table, and footer font sizes proportionally without removing content;
- place Venue at x 36 and right-align Funding, Int., APR, 7D / Day, and 7D APR at x 240, 326, 430, 594, and 764 respectively;
- keep every generated x coordinate in the inclusive 0–800 canvas boundary.

- [x] **Step 4: Run the renderer test and verify GREEN**

Run:

```bash
npx -y node@24 --import tsx --test test/image/funding-report.test.ts
```

Expected: 3 tests pass, including exact SVG/PNG dimensions, all content fields, signed colors, escaping, and missing-venue filtering.

- [x] **Step 5: Run project verification**

Run:

```bash
npm run typecheck
npm run build
npx -y node@24 --import tsx --test test/*.test.ts test/**/*.test.ts
```

Expected: typecheck and build exit 0; all tests pass with zero failures.

- [x] **Step 6: Generate and inspect real images**

Run a real forced send using the existing `.env` configuration:

```bash
npx -y node@24 dist/cli.js --send --force
```

Expected: two GitHub-hosted images are published and one Google Chat message is accepted. Download both public PNGs, inspect their pixel metadata and visual layout, and confirm no clipping or overlapping columns.

- [x] **Step 7: Commit and push**

```bash
git add src/image/funding-report.ts test/image/funding-report.test.ts docs/superpowers/plans/2026-08-11-compact-funding-image-layout.md
git commit -m "feat: compact funding report images"
git push origin main
```
