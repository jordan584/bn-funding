import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';

import { createApp } from '../src/app.js';
import type { BinanceClient } from '../src/binance/client.js';
import { GoogleChatClient } from '../src/chat/client.js';
import { parseCliArgs } from '../src/cli.js';
import type { Logger, ScheduledSlot } from '../src/domain.js';
import { runFundingJob } from '../src/job.js';
import { FileRunStateStore } from '../src/state/store.js';
import { AS_OF, DAY, contract, history, interval, premium } from './helpers/fixtures.js';

const slot: ScheduledSlot = { key: '2026-08-03T16', scheduledAtMs: AS_OF };

function jobData() {
  const symbols = Array.from({ length: 20 }, (_, index) => `ASSET${String(index + 1).padStart(2, '0')}USDT`);
  return {
    contracts: symbols.map((symbol) => contract(symbol)),
    history: symbols.flatMap((symbol) => [
      history(symbol, '0.00010000', AS_OF - DAY + 1),
      history(symbol, '0.00010000', AS_OF - 1)
    ]),
    premiums: symbols.map((symbol) => premium(symbol)),
    intervals: symbols.map((symbol) => interval(symbol, 8))
  };
}

function dependencies(lastSuccessfulSlot: string | null = null) {
  const calls: string[] = [];
  const data = jobData();
  const binance = {
    getServerTime: async () => { calls.push('binance.time'); return AS_OF; },
    getExchangeSymbols: async () => { calls.push('binance.exchange'); return data.contracts; },
    getFundingHistory: async (startTime: number, endTime: number) => {
      calls.push(`binance.history:${startTime}:${endTime}`);
      return { records: data.history, pageCount: 1 };
    },
    getPremiumIndexes: async () => { calls.push('binance.premium'); return data.premiums; },
    getFundingIntervals: async () => { calls.push('binance.intervals'); return data.intervals; }
  } as unknown as BinanceClient;
  const chat = {
    send: async () => { calls.push('chat.send'); }
  } as unknown as GoogleChatClient;
  const state = {
    getLastSuccessfulSlot: async () => { calls.push('state.read'); return lastSuccessfulSlot; },
    markSuccessful: async () => { calls.push('state.write'); }
  } as unknown as FileRunStateStore;
  const logs: Array<{ event: string; fields?: Record<string, unknown> }> = [];
  const logger: Logger = {
    info: (event, fields) => { logs.push({ event, ...(fields === undefined ? {} : { fields }) }); },
    warn: () => {},
    error: () => {}
  };
  return { deps: { binance, chat, state, now: () => AS_OF + 10, logger }, calls, logs };
}

test('skips an already successful slot before touching Binance or Google Chat', async () => {
  const { deps, calls } = dependencies(slot.key);

  const result = await runFundingJob(deps, {
    slot,
    trigger: 'manual',
    dryRun: false,
    force: false
  });

  assert.deepEqual(result, { status: 'skipped', slot: slot.key, reason: 'already-sent' });
  assert.deepEqual(calls, ['state.read']);
});

test('dry-run fetches and formats the real Top20 without reading or writing state or sending Chat', async () => {
  const { deps, calls, logs } = dependencies();

  const result = await runFundingJob(deps, {
    slot,
    trigger: 'manual',
    dryRun: true,
    force: false
  });

  assert.equal(result.status, 'dry-run');
  assert.equal(result.slot, slot.key);
  assert.equal(result.rowCount, 20);
  assert.match(result.text, /^Binance Funding Top20 \(as of 1785744300000\)\n1\. ASSET01/);
  assert.deepEqual(calls, [
    'binance.time',
    'binance.exchange',
    `binance.history:${AS_OF - 7 * DAY + 1}:${AS_OF}`,
    'binance.premium',
    'binance.intervals'
  ]);
  assert.equal(logs.length, 1);
  assert.equal(logs[0]!.event, 'funding_job.completed');
  assert.equal(logs[0]!.fields?.trigger, 'manual');
  assert.equal(logs[0]!.fields?.slot, slot.key);
  assert.equal(logs[0]!.fields?.status, 'dry-run');
  assert.equal(logs[0]!.fields?.rowCount, 20);
  assert.equal(logs[0]!.fields?.eligibleContractCount, 20);
  assert.equal(logs[0]!.fields?.historyRecordCount, 40);
  assert.equal(logs[0]!.fields?.historyPageCount, 1);
  assert.equal(typeof logs[0]!.fields?.durationMs, 'number');
  assert.equal(typeof logs[0]!.fields?.payloadBytes, 'number');
});

test('sends once then records a successful slot and logs operational metadata', async () => {
  const { deps, calls, logs } = dependencies();

  const result = await runFundingJob(deps, {
    slot,
    trigger: 'manual',
    dryRun: false,
    force: false
  });

  assert.deepEqual(result, { status: 'sent', slot: slot.key, rowCount: 20 });
  assert.deepEqual(calls, [
    'state.read',
    'binance.time',
    'binance.exchange',
    `binance.history:${AS_OF - 7 * DAY + 1}:${AS_OF}`,
    'binance.premium',
    'binance.intervals',
    'chat.send',
    'state.write'
  ]);
  const completed = logs.find((entry) => entry.event === 'funding_job.completed');
  assert.equal(completed?.fields?.trigger, 'manual');
  assert.equal(completed?.fields?.slot, slot.key);
  assert.equal(completed?.fields?.status, 'sent');
  assert.equal(completed?.fields?.rowCount, 20);
  assert.equal(typeof completed?.fields?.durationMs, 'number');
  assert.equal(typeof completed?.fields?.payloadBytes, 'number');
  assert.equal(completed?.fields?.eligibleContractCount, 20);
  assert.equal(completed?.fields?.historyRecordCount, 40);
});

test('force bypasses only the duplicate check and still sends a validated run', async () => {
  const { deps, calls } = dependencies(slot.key);

  const result = await runFundingJob(deps, {
    slot,
    trigger: 'manual',
    dryRun: false,
    force: true
  });

  assert.equal(result.status, 'sent');
  assert.deepEqual(calls.slice(0, 3), [
    'state.read',
    'binance.time',
    'binance.exchange'
  ]);
  assert.equal(calls.includes('chat.send'), true);
  assert.equal(calls.includes('state.write'), true);
});

for (const [name, change] of [
  ['Binance schema failure', (deps: ReturnType<typeof dependencies>['deps']) => {
    (deps.binance as unknown as { getServerTime(): Promise<number> }).getServerTime = async () => {
      throw new Error('Binance response validation failed');
    };
  }],
  ['Binance retry failure', (deps: ReturnType<typeof dependencies>['deps']) => {
    (deps.binance as unknown as { getServerTime(): Promise<number> }).getServerTime = async () => {
      throw new Error('Binance network request failed');
    };
  }],
  ['Binance pagination failure', (deps: ReturnType<typeof dependencies>['deps']) => {
    (deps.binance as unknown as { getFundingHistory(start: number, end: number): Promise<unknown> }).getFundingHistory = async () => {
      throw new Error('Funding history pagination stalled');
    };
  }],
  ['fewer than 20 valid rows', (deps: ReturnType<typeof dependencies>['deps']) => {
    (deps.binance as unknown as { getExchangeSymbols(): Promise<unknown[]> }).getExchangeSymbols = async () => jobData().contracts.slice(0, 19);
  }],
  ['an at-limit Chat payload', (deps: ReturnType<typeof dependencies>['deps']) => {
    (deps.binance as unknown as { getExchangeSymbols(): Promise<unknown[]> }).getExchangeSymbols = async () =>
      jobData().contracts.map((item) => ({ ...item, baseAsset: '币'.repeat(2_000) }));
  }],
  ['an explicit Google Chat non-2xx failure', (deps: ReturnType<typeof dependencies>['deps']) => {
    (deps.chat as unknown as { send(): Promise<void> }).send = async () => {
      throw new Error('Google Chat request failed: POST returned 500');
    };
  }],
  ['an ambiguous Google Chat timeout', (deps: ReturnType<typeof dependencies>['deps']) => {
    (deps.chat as unknown as { send(): Promise<void> }).send = async () => {
      throw new Error('Google Chat request timed out; delivery status is ambiguous');
    };
  }]
] as const) {
  test(`${name} does not record the slot as successful`, async () => {
    const { deps, calls } = dependencies(slot.key);
    change(deps);

    await assert.rejects(runFundingJob(deps, {
      slot,
      trigger: 'manual',
      dryRun: false,
      force: true
    }));

    assert.equal(calls.includes('state.write'), false);
  });
}

test('createApp assembles the configured concrete dependencies', () => {
  const app = createApp({
    binanceBaseUrl: new URL('https://fapi.binance.com'),
    googleChatWebhookUrl: new URL('https://chat.googleapis.com/v1/spaces/space/messages?key=k&token=t'),
    stateFile: '/tmp/bn-funding-state.json',
    timezone: 'Asia/Shanghai',
    schedule: '5 0,8,16 * * *',
    catchUpWindowMs: 30 * 60_000,
    binanceTimeoutMs: 10_000,
    chatTimeoutMs: 15_000
  });

  assert.equal(app.binance.constructor.name, 'BinanceClient');
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
