import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createApp } from '../src/app.js';
import {
  GoogleChatClient,
  GoogleChatRequestError,
  GoogleChatTimeoutError
} from '../src/chat/client.js';
import { parseCliArgs } from '../src/cli.js';
import {
  VENUE_IDS,
  type FundingVenueAdapter,
  type Logger,
  type ScheduledSlot,
  type VenueFundingSnapshot,
  type VenueHistoryRequest,
  type VenueId,
  type VenueSnapshot
} from '../src/domain.js';
import { VenueRequestError, VenueTimeoutError } from '../src/exchanges/http.js';
import { runFundingJob, type FundingJobDeps } from '../src/job.js';
import { FileRunStateStore } from '../src/state/store.js';
import { AS_OF, DAY } from './helpers/fixtures.js';

const HOUR = 60 * 60 * 1_000;
const JOB_AS_OF = AS_OF + 10;
const slot: ScheduledSlot = { key: '2026-08-03T16', scheduledAtMs: AS_OF };

interface FakeOptions {
  candidateCount?: number;
  assetLength?: number;
}

function assetName(index: number, length?: number): string {
  const suffix = String(index + 1).padStart(2, '0');
  return length === undefined ? `ASSET${suffix}` : `${'A'.repeat(length)}${suffix}`;
}

function market(venue: VenueId, index: number, options: FakeOptions): VenueFundingSnapshot {
  const asset = assetName(index, options.assetLength);
  return {
    venue,
    marketId: `${venue}-${asset}-PERP`,
    rawBaseAsset: asset,
    quoteAsset: venue === 'hyperliquid' ? 'USD' : 'USDT',
    settleAsset: venue === 'hyperliquid' ? 'USDC' : 'USDT',
    nextFundingRate: String(0.001 - index * 0.00001),
    intervalHours: 8,
    nextFundingTime: AS_OF + HOUR
  };
}

function snapshot(venue: VenueId, options: FakeOptions): VenueSnapshot {
  const venueIndex = VENUE_IDS.indexOf(venue);
  const markets = Array.from(
    { length: options.candidateCount ?? 25 },
    (_, index) => market(venue, index, options)
  );
  return {
    venue,
    observedAt: AS_OF,
    markets,
    stats: {
      marketCount: markets.length,
      requestCount: venueIndex + 1,
      pageCount: venueIndex
    }
  };
}

function dependencies(lastSuccessfulSlot: string | null = null, options: FakeOptions = {}) {
  const calls: string[] = [];
  const logs: Array<{ event: string; fields?: Record<string, unknown> }> = [];
  const venues = Object.fromEntries(VENUE_IDS.map((venue) => [venue, {
    id: venue,
    getCurrentSnapshot: async () => {
      calls.push(`${venue}.current`);
      return snapshot(venue, options);
    },
    getFundingHistory: async (request: VenueHistoryRequest) => {
      calls.push(`${venue}.history:${request.market.marketId}`);
      return {
        records: [{
          venue,
          marketId: request.market.marketId,
          fundingRate: '0.0001',
          fundingTime: request.endTime - DAY
        }],
        requestCount: 1,
        pageCount: 1,
        completeFrom: request.startTime
      };
    }
  } satisfies FundingVenueAdapter])) as Record<VenueId, FundingVenueAdapter>;
  const chat = {
    send: async () => { calls.push('chat.send'); }
  } as unknown as GoogleChatClient;
  const state = {
    withRunLock: async <T>(work: () => Promise<T>) => work(),
    getLastSuccessfulSlot: async () => { calls.push('state.read'); return lastSuccessfulSlot; },
    markSuccessful: async () => { calls.push('state.write'); }
  } as unknown as FileRunStateStore;
  const logger: Logger = {
    info: (event, fields) => { logs.push({ event, ...(fields === undefined ? {} : { fields }) }); },
    warn: () => {},
    error: (event, fields) => { logs.push({ event, ...(fields === undefined ? {} : { fields }) }); }
  };
  const deps: FundingJobDeps = { venues, chat, state, now: () => JOB_AS_OF, logger };
  return { deps, calls, logs };
}

function jobOptions(overrides: Partial<Parameters<typeof runFundingJob>[1]> = {}) {
  return {
    slot,
    trigger: 'manual' as const,
    dryRun: false,
    force: false,
    ...overrides
  };
}

test('skips an already successful slot before touching any venue or Google Chat', async () => {
  const { deps, calls } = dependencies(slot.key);

  const result = await runFundingJob(deps, jobOptions());

  assert.deepEqual(result, { status: 'skipped', slot: slot.key, reason: 'already-sent' });
  assert.deepEqual(calls, ['state.read']);
});

test('starts all five current snapshot requests before waiting for any one to resolve', async () => {
  const { deps } = dependencies();
  const started = new Set<VenueId>();
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });

  for (const venue of VENUE_IDS) {
    const original = deps.venues[venue].getCurrentSnapshot.bind(deps.venues[venue]);
    deps.venues[venue].getCurrentSnapshot = async () => {
      started.add(venue);
      await gate;
      return original();
    };
  }

  const run = runFundingJob(deps, jobOptions({ dryRun: true }));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual([...started].sort(), [...VENUE_IDS].sort());
  release?.();
  await run;
});

test('dry-run fetches all current snapshots and only selected Top20 history without state or Chat', async () => {
  const { deps, calls, logs } = dependencies();

  const result = await runFundingJob(deps, jobOptions({ dryRun: true }));

  assert.equal(result.status, 'dry-run');
  assert.equal(result.slot, slot.key);
  assert.equal(result.rowCount, 20);
  assert.match(result.text, new RegExp(`^五交易所 Funding Top20（截至 ${JOB_AS_OF}）\\n#1 ASSET01`));
  assert.deepEqual(
    calls.filter((call) => call.endsWith('.current')).sort(),
    ['binance.current', 'bitget.current', 'bybit.current', 'hyperliquid.current', 'okx.current']
  );
  const historyCalls = calls.filter((call) => call.includes('.history:'));
  assert.equal(historyCalls.length, 100);
  assert.equal(historyCalls.some((call) => /ASSET2[1-5]/.test(call)), false);
  assert.equal(calls.some((call) => call.startsWith('state.') || call === 'chat.send'), false);
  const completed = logs.find((entry) => entry.event === 'funding_job.completed');
  assert.equal(completed?.fields?.status, 'dry-run');
  assert.equal(completed?.fields?.rowCount, 20);
});

test('sends after current-rank-history-card and commits state only after Chat succeeds', async () => {
  const { deps, calls, logs } = dependencies();

  const result = await runFundingJob(deps, jobOptions());

  assert.deepEqual(result, { status: 'sent', slot: slot.key, rowCount: 20 });
  assert.equal(calls[0], 'state.read');
  assert.deepEqual(
    calls.filter((call) => call.endsWith('.current')).sort(),
    ['binance.current', 'bitget.current', 'bybit.current', 'hyperliquid.current', 'okx.current']
  );
  assert.equal(calls.filter((call) => call.includes('.history:')).length, 100);
  assert.deepEqual(calls.slice(-2), ['chat.send', 'state.write']);

  const completed = logs.find((entry) => entry.event === 'funding_job.completed');
  assert.equal(completed?.fields?.trigger, 'manual');
  assert.equal(completed?.fields?.slot, slot.key);
  assert.equal(completed?.fields?.status, 'sent');
  assert.equal(completed?.fields?.asOf, JOB_AS_OF);
  assert.equal(completed?.fields?.candidateCount, 25);
  assert.equal(completed?.fields?.rowCount, 20);
  assert.deepEqual(completed?.fields?.coverageCounts, { two: 0, three: 0, four: 0, five: 20 });
  for (const field of [
    'durationMs',
    'currentFetchDurationMs',
    'rankDurationMs',
    'historyFetchDurationMs',
    'cardBuildDurationMs',
    'webhookDurationMs',
    'payloadBytes'
  ]) {
    assert.equal(typeof completed?.fields?.[field], 'number', field);
  }
  assert.deepEqual(completed?.fields?.venues, {
    binance: { marketCount: 25, currentRequestCount: 1, currentPageCount: 0, historyRequestCount: 20, historyPageCount: 20, historyRecordCount: 20 },
    okx: { marketCount: 25, currentRequestCount: 2, currentPageCount: 1, historyRequestCount: 20, historyPageCount: 20, historyRecordCount: 20 },
    hyperliquid: { marketCount: 25, currentRequestCount: 3, currentPageCount: 2, historyRequestCount: 20, historyPageCount: 20, historyRecordCount: 20 },
    bybit: { marketCount: 25, currentRequestCount: 4, currentPageCount: 3, historyRequestCount: 20, historyPageCount: 20, historyRecordCount: 20 },
    bitget: { marketCount: 25, currentRequestCount: 5, currentPageCount: 4, historyRequestCount: 20, historyPageCount: 20, historyRecordCount: 20 }
  });
});

test('serializes two jobs across the complete duplicate-check-through-send transaction', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'bn-funding-job-lock-'));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  const statePath = path.join(directory, 'state.json');
  let webhookPosts = 0;
  let releaseFirstPost: (() => void) | undefined;
  const holdFirstPost = new Promise<void>((resolve) => { releaseFirstPost = resolve; });
  let markFirstPostStarted: (() => void) | undefined;
  const firstPostStarted = new Promise<void>((resolve) => { markFirstPostStarted = resolve; });

  const makeDeps = (): FundingJobDeps => {
    const { deps } = dependencies();
    return {
      ...deps,
      chat: {
        send: async () => {
          webhookPosts += 1;
          if (webhookPosts === 1) {
            markFirstPostStarted?.();
            await holdFirstPost;
          }
        }
      } as unknown as GoogleChatClient,
      state: new FileRunStateStore(statePath)
    };
  };

  const firstJob = runFundingJob(makeDeps(), jobOptions({ trigger: 'cron' }));
  await firstPostStarted;
  const secondJob = runFundingJob(makeDeps(), jobOptions());
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  const postsWhileFirstWasHeld = webhookPosts;

  releaseFirstPost?.();
  const [firstResult, secondResult] = await Promise.all([firstJob, secondJob]);

  assert.equal(postsWhileFirstWasHeld, 1);
  assert.deepEqual(firstResult, { status: 'sent', slot: slot.key, rowCount: 20 });
  assert.deepEqual(secondResult, { status: 'skipped', slot: slot.key, reason: 'already-sent' });
  assert.equal(webhookPosts, 1);
  assert.equal(JSON.parse(await readFile(statePath, 'utf8')).lastSuccessfulSlot, slot.key);
});

test('force bypasses only the duplicate check and still runs all venue phases', async () => {
  const { deps, calls } = dependencies(slot.key);

  const result = await runFundingJob(deps, jobOptions({ force: true }));

  assert.equal(result.status, 'sent');
  assert.equal(calls[0], 'state.read');
  assert.equal(calls.filter((call) => call.endsWith('.current')).length, 5);
  assert.equal(calls.filter((call) => call.includes('.history:')).length, 100);
  assert.deepEqual(calls.slice(-2), ['chat.send', 'state.write']);
});

test('attributes a lock release failure after a successful transaction to state-lock', async () => {
  const { deps, calls, logs } = dependencies();
  deps.state.withRunLock = async <T>(work: () => Promise<T>) => {
    await work();
    throw new Error('run lock release failed');
  };

  await assert.rejects(runFundingJob(deps, jobOptions()), /run lock release failed/);

  assert.deepEqual(calls.slice(-2), ['chat.send', 'state.write']);
  const failure = logs.find((entry) => entry.event === 'funding_job.failed');
  assert.equal(failure?.fields?.stage, 'state-lock');
  assert.equal(failure?.fields?.errorCategory, 'state-store');
});

for (const [name, expectedStage, change] of [
  ['duplicate state read', 'state-check', (deps: FundingJobDeps) => {
    deps.state.getLastSuccessfulSlot = async () => { throw new Error('state read failed'); };
  }],
  ['successful slot commit', 'state-commit', (deps: FundingJobDeps) => {
    deps.state.markSuccessful = async () => { throw new Error('state commit failed'); };
  }]
] as const) {
  test(`attributes a direct ${name} failure to ${expectedStage}`, async () => {
    const { deps, logs } = dependencies();
    change(deps);

    await assert.rejects(runFundingJob(deps, jobOptions()));

    const failure = logs.find((entry) => entry.event === 'funding_job.failed');
    assert.equal(failure?.fields?.stage, expectedStage);
    assert.equal(failure?.fields?.errorCategory, 'state-store');
  });
}

type FailureCase = readonly [
  name: string,
  expectedStage: string,
  expectedCategory: string,
  expectedAsOf: number | null,
  options: FakeOptions,
  change: (deps: FundingJobDeps) => void
];

const failureCases: FailureCase[] = [
  ['one venue current timeout', 'current-fetch', 'okx-timeout', null, {}, (deps) => {
    deps.venues.okx.getCurrentSnapshot = async () => {
      throw new VenueTimeoutError('okx', 'GET', '/api/v5/public/funding-rate');
    };
  }],
  ['one venue current request failure', 'current-fetch', 'bitget-request', null, {}, (deps) => {
    deps.venues.bitget.getCurrentSnapshot = async () => {
      throw new VenueRequestError('bitget', 'Bitget response validation failed');
    };
  }],
  ['fewer than 20 cross-venue candidates', 'rank', 'funding-compute', JOB_AS_OF, { candidateCount: 19 }, () => {}],
  ['selected history rejection', 'history-fetch', 'bybit-request', JOB_AS_OF, {}, (deps) => {
    deps.venues.bybit.getFundingHistory = async () => {
      throw new VenueRequestError('bybit', 'Bybit funding history failed');
    };
  }],
  ['payload overflow', 'card-build', 'chat-payload', JOB_AS_OF, { assetLength: 1_600 }, () => {}],
  ['Google Chat non-2xx failure', 'webhook', 'google-chat-request', JOB_AS_OF, {}, (deps) => {
    (deps.chat as unknown as { send(): Promise<void> }).send = async () => {
      throw new GoogleChatRequestError('Google Chat request failed: POST returned 500', 500);
    };
  }],
  ['Google Chat timeout', 'webhook', 'google-chat-timeout', JOB_AS_OF, {}, (deps) => {
    (deps.chat as unknown as { send(): Promise<void> }).send = async () => {
      throw new GoogleChatTimeoutError();
    };
  }]
];

for (const [name, expectedStage, expectedCategory, expectedAsOf, options, change] of failureCases) {
  test(`${name} fails the run without sending or committing later phases`, async () => {
    const { deps, calls, logs } = dependencies(null, options);
    change(deps);

    await assert.rejects(runFundingJob(deps, jobOptions({ force: true })));

    if (expectedStage !== 'webhook') {
      assert.equal(calls.includes('chat.send'), false);
    }
    assert.equal(calls.includes('state.write'), false);
    const failures = logs.filter((entry) => entry.event === 'funding_job.failed');
    assert.equal(failures.length, 1);
    assert.deepEqual(failures[0]!.fields, {
      slot: slot.key,
      trigger: 'manual',
      stage: expectedStage,
      errorCategory: expectedCategory,
      asOf: expectedAsOf,
      durationMs: failures[0]!.fields?.durationMs
    });
    assert.equal(typeof failures[0]!.fields?.durationMs, 'number');
  });
}

test('logs expose counts and durations but omit response bodies and webhook secrets', async () => {
  const { deps, logs } = dependencies();
  const webhook = 'https://chat.googleapis.com/v1/spaces/space/messages?key=secret-key&token=secret-token';
  (deps.chat as unknown as { send(): Promise<void> }).send = async () => {
    throw new GoogleChatRequestError(`upstream echoed ${webhook}: ${'x'.repeat(5_000)}`, 500);
  };

  await assert.rejects(runFundingJob(deps, jobOptions({ force: true })), GoogleChatRequestError);

  const serialized = JSON.stringify(logs);
  assert.doesNotMatch(serialized, /chat\.googleapis\.com|secret-key|secret-token|x{100}/);
});

test('createApp assembles all five configured venue adapters', () => {
  const app = createApp({
    exchangeBaseUrls: {
      binance: new URL('https://fapi.binance.com'),
      okx: new URL('https://www.okx.com'),
      hyperliquid: new URL('https://api.hyperliquid.xyz'),
      bybit: new URL('https://api.bybit.com'),
      bitget: new URL('https://api.bitget.com')
    },
    googleChatWebhookUrl: new URL('https://chat.googleapis.com/v1/spaces/space/messages?key=k&token=t'),
    stateFile: '/tmp/bn-funding-state.json',
    timezone: 'Asia/Shanghai',
    schedule: '5 0,8,16 * * *',
    catchUpWindowMs: 30 * 60_000,
    exchangeTimeoutMs: 10_000,
    chatTimeoutMs: 15_000
  });

  assert.equal(app.venues.binance.constructor.name, 'BinanceVenueAdapter');
  assert.equal(app.venues.okx.constructor.name, 'OkxClient');
  assert.equal(app.venues.hyperliquid.constructor.name, 'HyperliquidClient');
  assert.equal(app.venues.bybit.constructor.name, 'BybitClient');
  assert.equal(app.venues.bitget.constructor.name, 'BitgetClient');
  assert.ok(app.chat instanceof GoogleChatClient);
  assert.ok(app.state instanceof FileRunStateStore);
});

test('CLI requires exactly one delivery mode and rejects force without send before network setup', async () => {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', '--force'], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { output += chunk; });

  const [exitCode] = await once(child, 'exit') as [number | null];

  assert.equal(exitCode, 1);
  assert.match(output, /--force is only valid with --send/);
  assert.doesNotMatch(output, /chat\.googleapis\.com|token=/);
});

test('CLI rejects duplicate or conflicting mode flags and accepts force only on send', () => {
  assert.throws(() => parseCliArgs([]), /Exactly one of --dry-run or --send is required/);
  assert.throws(() => parseCliArgs(['--dry-run', '--send']), /Exactly one of --dry-run or --send is required/);
  assert.throws(() => parseCliArgs(['--dry-run', '--dry-run']), /Exactly one of --dry-run or --send is required/);
  assert.throws(() => parseCliArgs(['--dry-run', '--force']), /--force is only valid with --send/);
  assert.deepEqual(parseCliArgs(['--send', '--force']), { mode: 'send', force: true });
  assert.deepEqual(parseCliArgs(['--dry-run']), { mode: 'dry-run', force: false });
});
