# Composite APR Column and Image Cache Versioning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the existing equal-weight Composite Next APR ranking value to each flat-table row and version GitHub raw image URLs by PNG content so Google Chat never reuses a stale thumbnail after a forced republish.

**Architecture:** Keep ranking, rendering dimensions, GitHub object paths, and Chat payload structure unchanged. Extend the SVG's fixed column grid by one Composite APR column, then make the GitHub publisher derive a short SHA-256 digest from each uploaded PNG and append it to the corresponding raw URL.

**Tech Stack:** Node.js 24, TypeScript, Decimal.js, SVG, Sharp, Node crypto, Node test runner

## Global Constraints

- Preserve the existing equal-weight `CompositeFundingRow.compositeNextApr` calculation and ranking.
- Render nine columns in this order: Asset, Composite APR, Binance, OKX, Hyper, Bybit, Bitget, 7D / Day, 7D APR.
- Keep SVG width 800, two Top10 images, and PNG width 1600 at 2× density.
- Preserve signed colors, missing-value dashes, partial-history markers, 7D summaries, long-asset scaling, and all delivery behavior.
- Keep existing GitHub slot paths and append `?v=<12 lowercase hexadecimal SHA-256 characters>` to each public URL.
- Add no dependency or environment variable.

---

### Task 1: Display Composite APR in the nine-column table

**Files:**
- Modify: `test/image/funding-report.test.ts`
- Modify: `src/image/funding-report.ts`

**Interfaces:**
- Consumes: existing `CompositeFundingRow.compositeNextApr: DecimalInstance`.
- Produces: unchanged `renderFundingReportSvg(...)` and `renderFundingReportImages(...)`, now with a visible `Composite APR` column.

- [x] **Step 1: Write the failing renderer assertions**

In the main SVG test, assert the header, ten rendered Composite values, and the existing fixture value:

```ts
assert.match(svg, />Composite APR</);
assert.match(svg, />\+12\.34%<\/text>/);
assert.equal((svg.match(/class="composite-apr"/g) ?? []).length, 10);
```

Keep the existing exact SVG height, PNG dimensions, missing-venue checks, and asset count assertions.

- [x] **Step 2: Run the renderer test and verify RED**

Run:

```bash
node --import tsx --test test/image/funding-report.test.ts
```

Expected: FAIL because the flat table does not render `Composite APR` or `class="composite-apr"`.

- [x] **Step 3: Implement the nine-column layout**

Change the fixed boundaries to:

```ts
const COLUMN_BOUNDARIES = [24, 110, 188, 272, 356, 440, 524, 608, 692, 776] as const;
```

Insert `Composite APR` after `Asset` in the header. Render `signedAprPercent(row.compositeNextApr)` at `COLUMN_CENTERS[1]` with `className: 'composite-apr'`, signed color, and a small `Next avg` caption. Shift all five venue center indexes by one and the two 7D summary indexes to 7 and 8. Reduce venue primary/secondary text sizes to 13/10 only as needed to fit the 84-unit columns.

- [x] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
node --import tsx --test test/image/funding-report.test.ts test/funding/seven-day-composite.test.ts
```

Expected: all renderer and summary tests pass with zero failures.

---

### Task 2: Version public image URLs by PNG content

**Files:**
- Modify: `test/github/image-publisher.test.ts`
- Modify: `src/github/image-publisher.ts`

**Interfaces:**
- Consumes: each existing `FundingReportImage.png: Buffer` after the same upload flow.
- Produces: unchanged `PublishedFundingImages`, with each URL suffixed by its own deterministic `?v=<digest>`.

- [x] **Step 1: Write failing publisher URL assertions**

Change the first publisher expectation to:

```ts
assert.deepEqual(published, {
  first: 'https://raw.githubusercontent.com/jordan584/bn-funding/funding-images/reports/2026/08/10/2026-08-10T16-top-1-10.png?v=53d0c513f46b',
  second: 'https://raw.githubusercontent.com/jordan584/bn-funding/funding-images/reports/2026/08/10/2026-08-10T16-top-11-20.png?v=64d0262b4609'
});
```

Add a pure behavior assertion by publishing `Buffer.from('changed-png')` through the same mocked publisher and checking that the version differs from `53d0c513f46b`; keep upload paths free of the query string.

- [x] **Step 2: Run the publisher test and verify RED**

Run:

```bash
node --import tsx --test test/github/image-publisher.test.ts
```

Expected: FAIL because returned raw URLs currently have no `v` query parameter.

- [x] **Step 3: Implement deterministic content versions**

Import `createHash` from `node:crypto` and add:

```ts
function contentVersion(png: Buffer): string {
  return createHash('sha256').update(png).digest('hex').slice(0, 12);
}
```

Change `rawUrl` to accept the PNG buffer and return `${existingRawUrl}?v=${contentVersion(png)}`. Build `first` and `second` from the exact uploaded image buffers. Do not change `imagePath`, GitHub API endpoints, or upload bodies.

- [x] **Step 4: Run focused publisher tests and verify GREEN**

Run:

```bash
node --import tsx --test test/github/image-publisher.test.ts test/chat/image-message.test.ts
```

Expected: publisher and Chat image-card tests pass with URLs preserved verbatim.

---

### Task 3: Verify, publish, inspect, commit, and push

**Files:**
- Modify: `docs/superpowers/plans/2026-08-11-composite-column-image-cache.md` checkboxes only.

**Interfaces:**
- Consumes: the completed renderer and publisher changes.
- Produces: a tested main-branch commit plus a real Google Chat message whose thumbnail and opened image use the same nine-column PNG.

- [x] **Step 1: Run complete verification**

Run:

```bash
npm run typecheck
npm run build
npx -y node@24 --import tsx --test test/*.test.ts test/**/*.test.ts
```

Expected: typecheck and build exit 0; all tests pass with zero failures.

- [x] **Step 2: Force-publish and send the final images**

Run:

```bash
node dist/cli.js --send --force
```

Expected: `funding_job.completed` reports `status: "sent"`; the Chat payload URLs contain content-version query parameters.

- [x] **Step 3: Inspect the public PNG and Chat card**

Download the returned public Top10 image URL, confirm metadata is 1600 pixels wide, and visually verify all nine columns, ten rows, long asset names, and Composite values are legible. Confirm the Google Chat card thumbnail matches the opened image rather than the previously cached eight-column image.

- [x] **Step 4: Commit and push main**

```bash
git add src/image/funding-report.ts test/image/funding-report.test.ts src/github/image-publisher.ts test/github/image-publisher.test.ts docs/superpowers/plans/2026-08-11-composite-column-image-cache.md
git commit -m "feat: show composite APR and version report images"
git push origin main
```
