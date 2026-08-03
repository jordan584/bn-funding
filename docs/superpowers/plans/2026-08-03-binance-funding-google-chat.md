# Binance Funding Google Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a PM2-managed Node.js service that ranks Binance USDT-M perpetual contracts by trailing-24-hour settled Funding, then posts two mobile-readable Top10 cards to Google Chat at 00:05, 08:05, and 16:05 Asia/Shanghai.

**Architecture:** A single Node.js daemon owns scheduling and delegates one run to a job orchestrator. The orchestrator obtains validated public Binance data, computes the leaderboard with decimal arithmetic, builds one `cardsV2` payload containing two Top10 cards, posts it through the incoming webhook, and atomically records the successful schedule slot. All external clients and clocks are injected so pagination, retries, time windows, Webhook behavior, and restart catch-up can be tested without live services.

**Tech Stack:** Node.js 24 LTS, TypeScript (strict ESM), PM2, `node-cron`, `decimal.js`, `zod`, `luxon`, Node native `fetch`, Node test runner through `tsx`.

## Global Constraints

- Runtime is Node.js 24 LTS; do not support end-of-life Node.js 20 or earlier.
- Deployment is one PM2 `fork` process with `instances: 1`; do not use PM2 cluster mode.
- Schedule is `5 0,8,16 * * *` in `Asia/Shanghai`, yielding 00:05, 08:05, and 16:05 Beijing time.
- Universe is Binance USDⓈ-M contracts with `quoteAsset=USDT`, `contractType=PERPETUAL`, and `status=TRADING` only.
- Rank exactly 20 assets by settled Funding sum in `(asOf-24h, asOf]`, descending; ties use current Funding descending and symbol ascending.
- Current APR is `rate × (24 ÷ intervalHours) × 365`; 24h APR is `sum × 365`; 7d APR is `sum × (365 ÷ 7)`.
- Funding displays 4 decimal percentage places; APR displays 2 decimal percentage places; round only at presentation time.
- Use Binance Server Time for data windows and include only `rateType=Regular` history.
- Send one Google Chat message with `text`, ranks 1–10 in `cardsV2[0]`, and ranks 11–20 in `cardsV2[1]`.
- Reject, rather than truncate, any Google Chat JSON payload whose UTF-8 size is 32,000 bytes or more.
- Binance requests time out after 10 seconds and retry network errors, 429, and 5xx at most 3 times; Google Chat times out after 15 seconds and does not retry an ambiguous timeout.
- A schedule slot is successful only after Google Chat returns 2xx; state writes use a temporary file and atomic rename.
- Catch up only the most recent elapsed slot when startup occurs within 30 minutes and that slot is not already successful.
- Do not create images, use GCS, require a public domain, listen on an HTTP port, or use a Binance API key.
- Never store or log the full `GOOGLE_CHAT_WEBHOOK_URL`.

---

## File Structure

| Path | Responsibility |
|---|---|
| `package.json` | Runtime dependencies and repeatable build/test/run commands. |
| `tsconfig.json` | Strict type-checking for source and tests. |
| `tsconfig.build.json` | Production-only compilation into `dist/`. |
| `.env.example` | Secret-free configuration contract. |
| `ecosystem.config.cjs` | PM2 single-process production definition. |
| `src/domain.ts` | Shared Binance, leaderboard, card, slot, and job types. |
| `src/config.ts` | Environment parsing and mode-specific validation. |
| `src/logger.ts` | Structured JSON logs with safe error serialization. |
| `src/binance/schemas.ts` | Zod schemas for every Binance response used. |
| `src/binance/client.ts` | GET timeout/retry policy and Funding history pagination. |
| `src/funding/aggregate.ts` | Asset filtering, time-window sums, APRs, validation, and stable Top20 sorting. |
| `src/funding/format.ts` | Percentage and human-readable leaderboard formatting. |
| `src/chat/cards.ts` | Two-card Google Chat payload construction and 32 KB enforcement. |
| `src/chat/client.ts` | One-shot incoming Webhook POST and response classification. |
| `src/state/store.ts` | Durable successful-slot read and atomic write. |
| `src/schedule/slots.ts` | Asia/Shanghai schedule-slot and startup catch-up calculation. |
| `src/schedule/single-flight.ts` | In-process overlapping-run guard. |
| `src/job.ts` | End-to-end Funding run orchestration and state commit ordering. |
| `src/app.ts` | Concrete dependency assembly for CLI and daemon. |
| `src/cli.ts` | `--dry-run`, `--send`, and explicit `--force` manual execution. |
| `src/scheduler.ts` | `node-cron` registration, startup catch-up, and shutdown. |
| `src/index.ts` | PM2 daemon entry point and signal handling. |
| `test/helpers/fetch.ts` | Deterministic fetch queues and response builders. |
| `test/helpers/fixtures.ts` | Reusable Binance and 20-row leaderboard fixtures. |
| `test/config.test.ts` | Configuration validation. |
| `test/binance/client.test.ts` | Response validation, retries, and pagination boundaries. |
| `test/funding/aggregate.test.ts` | Windows, sums, APRs, partial history, and ranking. |
| `test/funding/format.test.ts` | Decimal percentage formatting. |
| `test/chat/cards.test.ts` | Two Top10 cards, copy, layout, and payload size. |
| `test/chat/client.test.ts` | Webhook request, 2xx, non-2xx, and timeout behavior. |
| `test/state/store.test.ts` | Missing, valid, corrupt, and atomic state behavior. |
| `test/schedule/slots.test.ts` | Slot boundaries and 30-minute catch-up. |
| `test/schedule/single-flight.test.ts` | Overlap suppression. |
| `test/job.test.ts` | Orchestration, dry-run, duplicate prevention, and commit ordering. |
| `test/scheduler.test.ts` | Cron options, startup catch-up, and graceful stop. |
| `test/e2e/job-http.test.ts` | Local HTTP Binance/Webhook end-to-end run. |
| `README.md` | Setup, PM2 deployment, secrets, dry-run, send, logs, and recovery. |

---

### Task 1: Bootstrap the strict Node.js project and configuration contract

**Files:**
- Create: `package.json`
- Create: `package-lock.json`
- Create: `tsconfig.json`
- Create: `tsconfig.build.json`
- Create: `.env.example`
- Create: `src/domain.ts`
- Create: `src/config.ts`
- Create: `src/logger.ts`
- Create: `test/config.test.ts`

**Interfaces:**
- Consumes: process environment and execution mode `'daemon' | 'send' | 'dry-run'`.
- Produces: `loadConfig(env, mode): AppConfig`, shared domain interfaces, and `log(level, event, fields)`.

- [ ] **Step 1: Initialize dependencies and scripts**

Run:

```bash
npm init -y
npm install decimal.js luxon node-cron zod
npm install --save-dev @types/luxon @types/node tsx typescript
```

Then set `package.json` to ESM and define these scripts:

```json
{
  "type": "module",
  "engines": { "node": ">=24" },
  "scripts": {
    "clean": "node --input-type=module -e \"import { rmSync } from 'node:fs'; rmSync('dist', { recursive: true, force: true })\"",
    "typecheck": "tsc --noEmit",
    "build": "npm run clean && tsc -p tsconfig.build.json",
    "test": "node --import tsx --test test/*.test.ts test/**/*.test.ts",
    "dry-run": "node dist/cli.js --dry-run",
    "push:once": "node dist/cli.js --send",
    "start": "node dist/index.js"
  }
}
```

- [ ] **Step 2: Add strict compiler configurations**

Use this core in `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

`tsconfig.build.json` must extend it, set `rootDir: "src"`, `outDir: "dist"`, `sourceMap: true`, and include only `src/**/*.ts`.

- [ ] **Step 3: Write failing configuration tests**

Create tests that assert daemon/send modes reject a missing or non-HTTPS Webhook, dry-run permits no Webhook, and constants are exact:

```ts
test('daemon configuration is production-safe', () => {
  const config = loadConfig({
    GOOGLE_CHAT_WEBHOOK_URL: 'https://chat.googleapis.com/v1/spaces/space/messages?key=k&token=t',
    STATE_FILE: '/var/lib/bn-funding/state.json',
    TZ: 'Asia/Shanghai'
  }, 'daemon');
  assert.equal(config.schedule, '5 0,8,16 * * *');
  assert.equal(config.timezone, 'Asia/Shanghai');
  assert.equal(config.binanceTimeoutMs, 10_000);
  assert.equal(config.chatTimeoutMs, 15_000);
  assert.equal(config.catchUpWindowMs, 30 * 60_000);
});
```

- [ ] **Step 4: Run the focused test and verify failure**

Run: `node --import tsx --test test/config.test.ts`

Expected: FAIL because `src/config.ts` and `loadConfig` do not exist.

- [ ] **Step 5: Implement domain types, configuration, and safe logging**

Define the domain boundary in `src/domain.ts` with exact names used later:

```ts
export type RunMode = 'daemon' | 'send' | 'dry-run';
export type TriggerSource = 'cron' | 'startup-catchup' | 'manual';
export interface AppConfig {
  binanceBaseUrl: URL;
  googleChatWebhookUrl?: URL;
  stateFile: string;
  timezone: 'Asia/Shanghai';
  schedule: '5 0,8,16 * * *';
  catchUpWindowMs: number;
  binanceTimeoutMs: number;
  chatTimeoutMs: number;
}
export interface ExchangeSymbol {
  symbol: string; baseAsset: string; quoteAsset: string;
  contractType: string; status: string; onboardDate: number;
}
export interface FundingHistoryRecord {
  symbol: string; fundingRate: string; fundingTime: number;
  rateType: 'Regular' | 'Special';
}
export interface PremiumIndexRecord { symbol: string; lastFundingRate: string; nextFundingTime: number; }
export interface FundingIntervalInfo { symbol: string; fundingIntervalHours: number; }
export interface ScheduledSlot { key: string; scheduledAtMs: number; }
export interface Logger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}
```

`loadConfig` must require `STATE_FILE` and a `https://chat.googleapis.com/` URL in daemon/send modes, default Binance to `https://fapi.binance.com`, and never copy secrets into error messages. Dry-run mode defaults the unused state path to `path.resolve('data/state.json')` and does not read or write it. `logger.ts` emits one JSON object per line and serializes errors as `{name,message}` only.

Create `.env.example` now with no live values:

```dotenv
GOOGLE_CHAT_WEBHOOK_URL=
STATE_FILE=/var/lib/bn-funding/state.json
TZ=Asia/Shanghai
```

- [ ] **Step 6: Run test, typecheck, and build**

Run:

```bash
node --import tsx --test test/config.test.ts
npm run typecheck
npm run build
```

Expected: all commands PASS and `dist/config.js` exists.

- [ ] **Step 7: Commit the bootstrap**

```bash
git add package.json package-lock.json tsconfig.json tsconfig.build.json .env.example src/domain.ts src/config.ts src/logger.ts test/config.test.ts
git commit -m "chore: bootstrap funding monitor service"
```

---

### Task 2: Build the validated Binance client and lossless history pagination

**Files:**
- Create: `src/binance/schemas.ts`
- Create: `src/binance/client.ts`
- Create: `test/helpers/fetch.ts`
- Create: `test/binance/client.test.ts`

**Interfaces:**
- Consumes: `ExchangeSymbol`, `FundingHistoryRecord`, `PremiumIndexRecord`, `FundingIntervalInfo`, injected `fetch`, sleep, and random functions.
- Produces: class `BinanceClient` with `getServerTime()`, `getExchangeSymbols()`, `getFundingHistory(startTime, endTime)`, `getPremiumIndexes()`, and `getFundingIntervals()`.

- [ ] **Step 1: Write failing schema and endpoint tests**

Cover valid parsing and rejection of invalid numbers/status payloads. Assert paths and public requests:

```ts
const client = new BinanceClient({ baseUrl, fetch: queuedFetch([
  jsonResponse({ serverTime: 1_785_715_500_000 })
]) });
assert.equal(await client.getServerTime(), 1_785_715_500_000);
assert.equal(seenRequests[0]?.url.pathname, '/fapi/v1/time');
assert.equal(seenRequests[0]?.init?.method, 'GET');
```

Funding history schema must treat an omitted `rateType` as `Regular` for backward-compatible public responses, while preserving explicit `Special`.

- [ ] **Step 2: Write failing retry-policy tests**

Use injected `sleep` and `random` so no test waits. Cover:

- 429 honors numeric `Retry-After`.
- 500 retries and then succeeds.
- 400 fails immediately.
- three retryable failures produce four total attempts (initial plus 3 retries).
- abort timeout becomes a typed `BinanceRequestError` without leaking response bodies larger than 500 characters.

- [ ] **Step 3: Write the pagination-boundary test**

Construct a client with `historyPageLimit: 3`. Page 1 ends with two records at time `200`; page 2 starts at `200` and repeats them before a record at `300`. Assert the result contains each `symbol:fundingTime:rateType` once and makes a third request only when the second page is full.

```ts
const result = await client.getFundingHistory(101, 400);
assert.deepEqual(result.records.map(r => `${r.symbol}:${r.fundingTime}`), [
  'AAAUSDT:150', 'BBBUSDT:200', 'CCCUSDT:200', 'DDDUSDT:300'
]);
assert.equal(result.pageCount, 3);
```

Add a separate case where a full page produces no new key and no later timestamp; expect `Funding history pagination stalled`.

- [ ] **Step 4: Run the focused tests and verify failure**

Run: `node --import tsx --test test/binance/client.test.ts`

Expected: FAIL because the Binance schemas/client are missing.

- [ ] **Step 5: Implement Zod schemas and the retrying GET helper**

Create schemas for the five official responses. The client constructor is:

```ts
export interface BinanceClientOptions {
  baseUrl: URL;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  maxRetries?: number;
  historyPageLimit?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}
export class BinanceClient {
  constructor(options: BinanceClientOptions);
  getServerTime(): Promise<number>;
  getExchangeSymbols(): Promise<ExchangeSymbol[]>;
  getFundingHistory(startTime: number, endTime: number): Promise<{records: FundingHistoryRecord[]; pageCount: number}>;
  getPremiumIndexes(): Promise<PremiumIndexRecord[]>;
  getFundingIntervals(): Promise<FundingIntervalInfo[]>;
}
```

Use `AbortSignal.timeout(timeoutMs)`. Retry only network errors, 429, and 5xx. Delay is `Retry-After` when present, otherwise `min(500 * 2**retryIndex + random()*250, 10_000)` milliseconds.

- [ ] **Step 6: Implement inclusive-cursor pagination with deduplication**

Request `symbol` omitted, `limit=1000`, and cursor `startTime`. Deduplicate with `symbol + ':' + fundingTime + ':' + rateType`. Continue from the maximum returned `fundingTime`, not `+1`, so same-time records across a boundary are not skipped. Stop on an empty page or a page smaller than the limit. Reject a full page that adds no new key and does not advance beyond the current cursor.

- [ ] **Step 7: Run Binance tests and the full quality gate**

Run:

```bash
node --import tsx --test test/binance/client.test.ts
npm test
npm run typecheck
```

Expected: all commands PASS.

- [ ] **Step 8: Commit the Binance client**

```bash
git add src/binance/schemas.ts src/binance/client.ts test/helpers/fetch.ts test/binance/client.test.ts
git commit -m "feat: add validated Binance funding client"
```

---

### Task 3: Compute the exact Funding leaderboard and presentation values

**Files:**
- Create: `src/funding/aggregate.ts`
- Create: `src/funding/format.ts`
- Create: `test/helpers/fixtures.ts`
- Create: `test/funding/aggregate.test.ts`
- Create: `test/funding/format.test.ts`
- Modify: `src/domain.ts`

**Interfaces:**
- Consumes: validated Binance records from Task 2 and `asOf` in epoch milliseconds.
- Produces: `buildFundingLeaderboard(input): FundingLeaderboard`, `formatFundingPercent`, `formatAprPercent`, and `renderLeaderboardText`.

- [ ] **Step 1: Extend the domain with leaderboard types**

Add exact Decimal-backed types, beginning the file with `import Decimal from 'decimal.js';`:

```ts
export interface FundingRow {
  rank: number; symbol: string; asset: string; exchange: 'Binance';
  intervalHours: number; currentRate: Decimal; currentApr: Decimal;
  funding24h: Decimal; apr24h: Decimal;
  funding7d: Decimal; apr7d: Decimal;
  partialSevenDayHistory: boolean;
}
export interface FundingLeaderboard {
  asOf: number; eligibleContractCount: number; historyRecordCount: number;
  rows: FundingRow[];
}
```

- [ ] **Step 2: Write failing window, APR, and filtering tests**

Use an `asOf` aligned to 08:05 and records exactly before, on, and after each boundary. Assert:

- only `TRADING + PERPETUAL + USDT` contracts are eligible;
- `(start,end]` excludes the exact start and includes `asOf`;
- `Special` is excluded;
- interval map values 1 and 4 override the default 8;
- current APRs for rate `0.0001` are `0.876`, `0.219`, and `0.1095` for 1h, 4h, and 8h;
- 24h and 7d APR formulas use unrounded sums;
- `onboardDate > asOf-7d` sets `partialSevenDayHistory=true`.

- [ ] **Step 3: Write failing stable-ranking and validation tests**

Create 22 eligible assets. Assert primary 24h descending, current-rate tie-break, symbol tie-break, exactly 20 rows, ranks 1–20, and acceptance of negative values after positive values. Assert fewer than 20 complete rows throws `Funding leaderboard has fewer than 20 valid assets`.

- [ ] **Step 4: Write failing formatting tests**

```ts
assert.equal(formatFundingPercent(new Decimal('0.00012549')), '0.0125%');
assert.equal(formatFundingPercent(new Decimal('-0.0001255')), '-0.0126%');
assert.equal(formatAprPercent(new Decimal('0.136875')), '13.69%');
```

Also assert `renderLeaderboardText` includes rank, asset, Binance, current period, 24h, 7d, and partial-history marker without any Webhook data.

- [ ] **Step 5: Run focused tests and verify failure**

Run: `node --import tsx --test test/funding/*.test.ts`

Expected: FAIL because aggregate and formatting modules are missing.

- [ ] **Step 6: Implement aggregation with Decimal arithmetic**

Implement:

```ts
export function buildFundingLeaderboard(input: {
  asOf: number;
  contracts: ExchangeSymbol[];
  history: FundingHistoryRecord[];
  premiumIndexes: PremiumIndexRecord[];
  intervals: FundingIntervalInfo[];
}): FundingLeaderboard;
```

Index data by symbol, filter history to `Regular`, calculate both windows in one pass, use `8` when no adjusted interval exists, validate finite Decimal strings and positive intervals, and sort before assigning ranks. Recheck `rows[i-1].funding24h.gte(rows[i].funding24h)` after ranking.

- [ ] **Step 7: Implement final-only rounding and dry-run text**

Use Decimal `ROUND_HALF_UP`; multiply rates by 100 only for display. Current text is `0.0125%/8h (13.69%)`; cumulative fields are `0.0375% (13.69%)`. Append `*` only to the 7-day value of partial-history assets and add one explanatory footer line when any row is partial.

- [ ] **Step 8: Run tests, typecheck, and commit**

```bash
node --import tsx --test test/funding/*.test.ts
npm test
npm run typecheck
git add src/domain.ts src/funding test/helpers/fixtures.ts test/funding
git commit -m "feat: calculate funding Top20 leaderboard"
```

---

### Task 4: Build and send the two-card Google Chat message

**Files:**
- Create: `src/chat/cards.ts`
- Create: `src/chat/client.ts`
- Create: `test/chat/cards.test.ts`
- Create: `test/chat/client.test.ts`
- Modify: `src/domain.ts`

**Interfaces:**
- Consumes: `FundingLeaderboard`, formatting functions, HTTPS Webhook URL, injected `fetch`.
- Produces: `buildFundingChatMessage(leaderboard): GoogleChatMessage` and `GoogleChatClient.send(message): Promise<void>`.

- [ ] **Step 1: Define the minimal outbound message type and write failing card tests**

Define `GoogleChatMessage` as `{text: string; cardsV2: Array<{cardId: string; card: Record<string, unknown>}>}`. Tests must assert:

- `cardsV2.length === 2`;
- first card contains ranks 1–10 and second 11–20 exactly once;
- each asset row has a two-column widget and a following divider except the final row;
- titles, as-of time, sorting copy, positive-Funding explanation, APR explanation, and partial-history explanation match the spec;
- current fields show `/1h`, `/4h`, or `/8h` from data;
- `Buffer.byteLength(JSON.stringify(message), 'utf8') < 32_000`.

- [ ] **Step 2: Write the explicit oversize failure test**

Make asset labels long enough to exceed the limit and expect `Google Chat message exceeds 32000 bytes`. The builder must never slice text or drop rows.

- [ ] **Step 3: Write failing Webhook client tests**

Assert one POST with `Content-Type: application/json; charset=utf-8`, exact serialized body, and a 15-second abort signal. Cover 200 success, 400/429/500 typed failure without retry, and `TimeoutError` classified as ambiguous with `retryable=false`. Capture logs and assert neither `key=` nor `token=` appears.

- [ ] **Step 4: Run focused tests and verify failure**

Run: `node --import tsx --test test/chat/*.test.ts`

Expected: FAIL because chat modules are missing.

- [ ] **Step 5: Implement cards with compact two-column rows**

For every row construct:

```ts
{
  columns: {
    columnItems: [
      {
        horizontalSizeStyle: 'FILL_MINIMUM_SPACE',
        verticalAlignment: 'TOP',
        widgets: [{ decoratedText: { topLabel: `#${rank} · Binance`, text: `<b>${asset}</b>` } }]
      },
      {
        horizontalSizeStyle: 'FILL_AVAILABLE_SPACE',
        verticalAlignment: 'TOP',
        widgets: [{ textParagraph: { text: metricsHtml } }]
      }
    ]
  }
}
```

Escape `& < > " '` in every dynamic HTML value. Use red for positive Funding, green for negative Funding, and default text color for zero; meaning must remain visible through the sign, not color alone.

- [ ] **Step 6: Implement the one-shot Webhook client**

The client constructor accepts `{webhookUrl, fetch?, timeoutMs?}`. Call fetch exactly once. On 2xx return; on non-2xx throw `GoogleChatRequestError` with status and at most 500 response characters; on timeout throw `GoogleChatTimeoutError`. Never include the URL in either error.

- [ ] **Step 7: Run tests and commit**

```bash
node --import tsx --test test/chat/*.test.ts
npm test
npm run typecheck
git add src/domain.ts src/chat test/chat
git commit -m "feat: add Google Chat funding cards"
```

---

### Task 5: Persist successful slots and calculate restart catch-up safely

**Files:**
- Create: `src/state/store.ts`
- Create: `src/schedule/slots.ts`
- Create: `src/schedule/single-flight.ts`
- Create: `test/state/store.test.ts`
- Create: `test/schedule/slots.test.ts`
- Create: `test/schedule/single-flight.test.ts`

**Interfaces:**
- Consumes: absolute `STATE_FILE`, epoch milliseconds, `Asia/Shanghai`, and async work functions.
- Produces: `FileRunStateStore`, `mostRecentElapsedSlot`, `shouldCatchUp`, and `SingleFlight`.

- [ ] **Step 1: Write failing state-store tests**

Use a fresh `mkdtemp` directory for every test. Assert missing file returns `null`, valid JSON returns the slot, malformed JSON throws, and `markSuccessful` writes mode `0600` JSON with both slot and ISO timestamp.

```ts
const store = new FileRunStateStore(statePath);
assert.equal(await store.getLastSuccessfulSlot(), null);
await store.markSuccessful({ key: '2026-08-03T08', scheduledAtMs }, nowMs);
assert.equal(await store.getLastSuccessfulSlot(), '2026-08-03T08');
```

Inject a filesystem adapter that pauses after the temporary-file write. Assert the old state remains readable before rename and the new state appears only after rename.

- [ ] **Step 2: Write failing slot-boundary and catch-up tests**

Using Luxon-backed production code, cover Beijing local times:

| Now | Most recent elapsed slot | Catch-up eligible |
|---|---|---|
| `2026-08-03 00:04` | `2026-08-02T16` | false |
| `2026-08-03 00:05` | `2026-08-03T00` | true |
| `2026-08-03 08:34` | `2026-08-03T08` | true |
| `2026-08-03 08:36` | `2026-08-03T08` | false |
| `2026-08-03 16:05` | `2026-08-03T16` | true |

Assert `shouldCatchUp` is false when `lastSuccessfulSlot` equals the candidate.

- [ ] **Step 3: Write the failing overlap test**

Start a deferred promise through `SingleFlight.run`. A second call before resolution must return `{started:false, reason:'overlap'}` without invoking its function. After resolving, a third call must start.

- [ ] **Step 4: Run focused tests and verify failure**

Run: `node --import tsx --test test/state/*.test.ts test/schedule/*.test.ts`

Expected: FAIL because the state and schedule modules are missing.

- [ ] **Step 5: Implement atomic state and slot calculations**

Use this state contract:

```ts
interface RunStateFile {
  lastSuccessfulSlot: string;
  scheduledAt: string;
  updatedAt: string;
}
class FileRunStateStore {
  constructor(path: string, fsAdapter?: StateFsAdapter);
  getLastSuccessfulSlot(): Promise<string | null>;
  markSuccessful(slot: ScheduledSlot, updatedAtMs: number): Promise<void>;
}
```

Create the parent directory, write `${stateFile}.${process.pid}.${randomUUID()}.tmp` with mode `0600`, then rename over the target. Remove only the specific temporary file after a failed write; never remove the state directory.

Implement `mostRecentElapsedSlot(nowMs, zone='Asia/Shanghai')` by constructing same-day 00:05, 08:05, and 16:05 Luxon values, selecting the latest not after now, or previous-day 16:05. Key format is `yyyy-MM-dd'T'HH`.

- [ ] **Step 6: Implement the single-flight guard**

Expose:

```ts
class SingleFlight {
  run<T>(work: () => Promise<T>): Promise<
    {started: true; value: T} | {started: false; reason: 'overlap'}
  >;
}
```

Reset the internal running flag in `finally`, including rejected work.

- [ ] **Step 7: Run tests and commit**

```bash
node --import tsx --test test/state/*.test.ts test/schedule/*.test.ts
npm test
npm run typecheck
git add src/state src/schedule test/state test/schedule
git commit -m "feat: add durable schedule slot control"
```

---

### Task 6: Orchestrate one complete run and expose safe manual commands

**Files:**
- Create: `src/job.ts`
- Create: `src/app.ts`
- Create: `src/cli.ts`
- Create: `test/job.test.ts`
- Modify: `src/domain.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: Tasks 2–5 clients/builders/store, a `ScheduledSlot`, trigger source, dry-run flag, and force flag.
- Produces: `runFundingJob(deps, options): Promise<JobResult>`, `createApp(config)`, and CLI exit status.

- [ ] **Step 1: Define orchestration interfaces and write the duplicate-skip test**

Add:

```ts
export type JobResult =
  | { status: 'sent'; slot: string; rowCount: 20 }
  | { status: 'dry-run'; slot: string; rowCount: 20; text: string }
  | { status: 'skipped'; slot: string; reason: 'already-sent' };
export interface RunFundingJobOptions {
  slot: ScheduledSlot;
  trigger: TriggerSource;
  dryRun: boolean;
  force: boolean;
}
```

With state already equal to the requested slot and `force=false`, assert no Binance or Chat method is called.

- [ ] **Step 2: Write failing dry-run and successful-send tests**

Dry-run must fetch and compute real data, return readable Top20 text, and call neither Chat nor `markSuccessful`. A successful send must call in this order: read state → Binance data → build cards → Chat send → mark state. Capture structured logs and assert counts, timings, payload bytes, trigger, and slot are present.

- [ ] **Step 3: Write failure-ordering tests**

Assert each of these leaves state unchanged:

- Binance schema, retry, or pagination failure.
- fewer than 20 valid leaderboard rows.
- card payload at or above 32 KB.
- explicit Google Chat non-2xx.
- ambiguous Google Chat timeout.

Assert `force=true` bypasses only the already-sent check; it does not bypass any data or payload validation.

- [ ] **Step 4: Run the focused test and verify failure**

Run: `node --import tsx --test test/job.test.ts`

Expected: FAIL because `runFundingJob` does not exist.

- [ ] **Step 5: Implement the orchestrator with exact data flow**

The orchestrator must:

1. Read the successful slot unless dry-run.
2. Return `already-sent` unless forced.
3. Read Binance Server Time.
4. Fetch exchange info, `fundingRate` from `asOf-7d+1ms`, premium indexes, and funding intervals; fetch independent endpoints concurrently after `asOf` is known.
5. Build and validate Top20.
6. Build and size-check the Chat message.
7. Return formatted text immediately for dry-run.
8. Send once through Google Chat.
9. Atomically mark the slot successful only after 2xx.
10. Emit a final structured log without secrets.

Dependencies are explicit:

```ts
export interface FundingJobDeps {
  binance: BinanceClient;
  chat?: GoogleChatClient;
  state: FileRunStateStore;
  now: () => number;
  logger: Logger;
}
export function runFundingJob(
  deps: FundingJobDeps,
  options: RunFundingJobOptions
): Promise<JobResult>;
```

- [ ] **Step 6: Implement dependency assembly and CLI parsing**

`createApp(config)` constructs concrete clients and store. CLI rules:

- exactly one of `--dry-run` or `--send` is required;
- `--force` is valid only with `--send`;
- manual slot is `mostRecentElapsedSlot(Date.now())`;
- success exits 0; validation or runtime failure logs a safe error and sets `process.exitCode=1`.

Update scripts so local source commands exist before build:

```json
{
  "dry-run:dev": "tsx src/cli.ts --dry-run",
  "push:once:dev": "tsx src/cli.ts --send"
}
```

- [ ] **Step 7: Run focused and full tests, then commit**

```bash
node --import tsx --test test/job.test.ts
npm test
npm run typecheck
npm run build
git add src/domain.ts src/job.ts src/app.ts src/cli.ts test/job.test.ts package.json package-lock.json
git commit -m "feat: orchestrate funding push runs"
```

---

### Task 7: Add the PM2 daemon, cron registration, and restart catch-up

**Files:**
- Create: `src/scheduler.ts`
- Create: `src/index.ts`
- Create: `ecosystem.config.cjs`
- Create: `test/scheduler.test.ts`

**Interfaces:**
- Consumes: `createApp`, slot/store functions, `SingleFlight`, and an injectable cron adapter.
- Produces: `startScheduler(deps): Promise<SchedulerHandle>` and the PM2 process entry point.

- [ ] **Step 1: Write failing cron-registration and overlap tests**

Inject a fake cron adapter. Assert registration uses expression `5 0,8,16 * * *` and `{timezone:'Asia/Shanghai'}`. Invoke the callback twice while the first job is deferred; assert only one `runFundingJob` call and one `schedule_overlap_skipped` log.

- [ ] **Step 2: Write failing startup-catch-up tests**

At 08:20 with last success 00, startup calls the job once with slot 08 and trigger `startup-catchup`. At 08:40, or with last success 08, it does not. A catch-up and cron callback must share the same `SingleFlight`.

- [ ] **Step 3: Write the graceful-stop test**

Call the returned handle's `stop()`. Assert it stops the cron task and no later fake callback runs. `SIGTERM` and `SIGINT` in `src/index.ts` must call `stop()` once before process exit.

- [ ] **Step 4: Run the focused test and verify failure**

Run: `node --import tsx --test test/scheduler.test.ts`

Expected: FAIL because scheduler code is missing.

- [ ] **Step 5: Implement scheduler and daemon entry point**

Use:

```ts
export interface SchedulerHandle { stop(): Promise<void>; }
export async function startScheduler(deps: SchedulerDeps): Promise<SchedulerHandle>;
```

Perform the startup catch-up check once before registering cron. Cron runs the current elapsed slot with trigger `cron`, `dryRun=false`, and `force=false`. Job errors are logged and swallowed at the scheduler boundary so PM2 keeps the daemon alive; configuration/startup failures escape so PM2 restarts the process.

- [ ] **Step 6: Create the PM2 single-instance configuration**

Use this production shape without secrets:

```js
module.exports = {
  apps: [{
    name: 'bn-funding',
    script: 'dist/index.js',
    exec_mode: 'fork',
    instances: 1,
    autorestart: true,
    restart_delay: 5000,
    max_restarts: 10,
    time: true,
    env: { NODE_ENV: 'production', TZ: 'Asia/Shanghai' }
  }]
};
```

- [ ] **Step 7: Run tests/build and commit**

```bash
node --import tsx --test test/scheduler.test.ts
npm test
npm run typecheck
npm run build
git add src/scheduler.ts src/index.ts ecosystem.config.cjs test/scheduler.test.ts
git commit -m "feat: schedule funding pushes under PM2"
```

---

### Task 8: Prove the HTTP flow end to end and document deployment

**Files:**
- Create: `test/e2e/job-http.test.ts`
- Create: `README.md`
- Modify: `.env.example`

**Interfaces:**
- Consumes: compiled application contract and local HTTP mocks.
- Produces: a reproducible end-to-end test and complete PM2 operator runbook.

- [ ] **Step 1: Write the failing local-HTTP end-to-end test**

Start one `node:http` server on `127.0.0.1` with routes for all five Binance endpoints and `/webhook`. Return at least 20 eligible contracts and enough history for deterministic ordering. Configure `BinanceClient.baseUrl` and `GoogleChatClient.webhookUrl` to this server directly, run a forced manual job, and assert:

- all expected Binance routes were called;
- Webhook was called once;
- payload contains exactly two cards and all 20 fixture assets;
- the state file contains the slot only after Webhook success;
- a second unforced run does not call HTTP.

- [ ] **Step 2: Run the E2E test and verify its initial failure**

Run: `node --import tsx --test test/e2e/job-http.test.ts`

Expected: FAIL until any integration mismatch between clients, job, and state is corrected.

- [ ] **Step 3: Make only the integration corrections required for green**

Keep production validation unchanged. Test-only URLs are passed directly to client constructors rather than through production `loadConfig`, so production still requires the official HTTPS Webhook host. Do not add an HTTP server to application source.

- [ ] **Step 4: Complete secret-free environment and operator documentation**

`.env.example` contains names and safe defaults only:

```dotenv
GOOGLE_CHAT_WEBHOOK_URL=
STATE_FILE=/var/lib/bn-funding/state.json
TZ=Asia/Shanghai
```

`README.md` must include:

1. Node.js 24 and PM2 prerequisites.
2. `npm ci`, `npm run typecheck`, `npm test`, and `npm run build`.
3. Creating `/var/lib/bn-funding` owned by the PM2 user.
4. Supplying the Webhook through PM2/server environment without committing it.
5. `npm run dry-run`, `npm run push:once`, and explicit forced send `npm run push:once -- --force`.
6. `pm2 start ecosystem.config.cjs`, `pm2 save`, `pm2 status`, and `pm2 logs bn-funding`.
7. Expected schedule and 30-minute restart catch-up.
8. Recovery steps for Binance failure, Chat timeout, corrupt state file, and manual resend.
9. Warning that `--force` can intentionally duplicate a message.

- [ ] **Step 5: Run the complete offline verification suite**

Run:

```bash
npm test
npm run typecheck
npm run build
node dist/cli.js --dry-run
```

Expected: tests/typecheck/build PASS. The dry-run calls live public Binance endpoints, prints exactly 20 ranked assets and no secret, and does not call Google Chat or write state. If the execution environment blocks outbound network, record that as the only skipped live check and run the same command on the deployment server before PM2 startup.

- [ ] **Step 6: Validate a test-space Google Chat message**

On the deployment server, inject a test-space Webhook and run:

```bash
npm run push:once -- --force
```

Expected: one message with two Top10 cards; desktop and mobile show all assets, three metrics, Funding periods, APRs, and footnotes. Remove the test Webhook from shell history/environment after validation.

- [ ] **Step 7: Commit the E2E test and runbook**

```bash
git add test/e2e/job-http.test.ts README.md .env.example
git commit -m "docs: add funding monitor deployment runbook"
```

---

## Final Acceptance Gate

- [ ] `npm test` passes with no skipped offline test.
- [ ] `npm run typecheck` passes.
- [ ] `npm run build` passes from a clean `dist/`.
- [ ] Live Binance dry-run prints exactly 20 correctly ordered assets.
- [ ] Test Google Chat message contains two mobile-readable Top10 cards and is below 32 KB.
- [ ] Re-running the same slot without `--force` does not send a second message.
- [ ] PM2 reports exactly one `bn-funding` fork instance.
- [ ] Webhook URL is absent from `git grep`, test output, build output, and PM2 logs.
