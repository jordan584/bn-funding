import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import test from 'node:test';

import type { AppConfig, Logger, RunFundingJobOptions } from '../src/domain.js';
import type { FundingJobDeps } from '../src/job.js';
import { startDaemon } from '../src/index.js';
import {
  startScheduler,
  type CronAdapter,
  type SchedulerDeps
} from '../src/scheduler.js';
import { DateTime } from 'luxon';

const zone = 'Asia/Shanghai';
const require = createRequire(import.meta.url);

function beijingMs(localTime: string): number {
  const value = DateTime.fromFormat(localTime, 'yyyy-MM-dd HH:mm', { zone });
  assert.equal(value.isValid, true);
  return value.toMillis();
}

async function drain(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

class FakeCron implements CronAdapter {
  expression: string | undefined;
  timezone: string | undefined;
  callback: (() => void) | undefined;
  stopCalls = 0;

  schedule(expression: string, callback: () => void, options: { timezone: string }) {
    this.expression = expression;
    this.callback = callback;
    this.timezone = options.timezone;
    return { stop: async () => { this.stopCalls += 1; } };
  }

  fire(): void {
    this.callback?.();
  }
}

function config(): AppConfig {
  return {
    exchangeBaseUrls: {
      binance: new URL('https://fapi.binance.com'),
      okx: new URL('https://www.okx.com'),
      hyperliquid: new URL('https://api.hyperliquid.xyz'),
      bybit: new URL('https://api.bybit.com'),
      bitget: new URL('https://api.bitget.com')
    },
    googleChatWebhookUrl: new URL('https://chat.googleapis.com/v1/spaces/example/messages?key=k&token=t'),
    stateFile: '/tmp/bn-funding-scheduler-test.json',
    timezone: 'Asia/Shanghai',
    schedule: '5 0,8,16 * * *',
    catchUpWindowMs: 30 * 60_000,
    exchangeTimeoutMs: 10_000,
    chatTimeoutMs: 15_000
  };
}

function schedulerFixture(overrides: { now?: () => number } = {}) {
  const events: string[] = [];
  const logs: Array<{ event: string; fields?: Record<string, unknown> }> = [];
  const logger: Logger = {
    info: (event, fields) => { logs.push({ event, ...(fields === undefined ? {} : { fields }) }); },
    warn: (event, fields) => { logs.push({ event, ...(fields === undefined ? {} : { fields }) }); },
    error: (event, fields) => { logs.push({ event, ...(fields === undefined ? {} : { fields }) }); }
  };
  const state = {
    getLastSuccessfulSlot: async () => { events.push('state.read'); return '2026-08-03T08'; }
  };
  const app = { state, logger } as unknown as FundingJobDeps;
  const cron = new FakeCron();
  const options: RunFundingJobOptions[] = [];
  const runFundingJob: NonNullable<SchedulerDeps['runFundingJob']> = async (_app, runOptions) => {
    events.push('job');
    options.push(runOptions);
    return { status: 'sent' as const, slot: runOptions.slot.key, rowCount: 20 };
  };
  const deps: SchedulerDeps = {
    config: config(),
    app,
    cron,
    now: overrides.now ?? (() => beijingMs('2026-08-03 08:40')),
    runFundingJob
  };
  return {
    events,
    logs,
    cron,
    options,
    deps
  };
}

test('registers the Beijing funding cron and suppresses overlapping callbacks', async () => {
  const fixture = schedulerFixture();
  const waiting = deferred<{ status: 'sent'; slot: string; rowCount: 20 }>();
  fixture.deps.runFundingJob = async (_app, options) => {
    fixture.options.push(options);
    return waiting.promise;
  };

  await startScheduler(fixture.deps);
  fixture.cron.fire();
  fixture.cron.fire();
  await drain();

  assert.equal(fixture.cron.expression, '5 0,8,16 * * *');
  assert.equal(fixture.cron.timezone, 'Asia/Shanghai');
  assert.equal(fixture.options.length, 1);
  assert.equal(fixture.logs.filter(({ event }) => event === 'schedule_overlap_skipped').length, 1);

  waiting.resolve({ status: 'sent', slot: fixture.options[0]!.slot.key, rowCount: 20 });
});

test('starts an 08:00 catch-up before cron registration when the prior slot succeeded', async () => {
  const fixture = schedulerFixture({ now: () => beijingMs('2026-08-03 08:20') });
  fixture.deps.app = {
    state: {
      getLastSuccessfulSlot: async () => { fixture.events.push('state.read'); return '2026-08-03T00'; }
    },
    logger: (fixture.deps.app as FundingJobDeps).logger
  } as unknown as FundingJobDeps;
  fixture.deps.cron = {
    schedule: (expression, callback, options) => {
      fixture.events.push('cron.register');
      return fixture.cron.schedule(expression, callback, options);
    }
  };

  await startScheduler(fixture.deps);

  assert.deepEqual(fixture.events, ['state.read', 'job', 'cron.register']);
  assert.deepEqual(fixture.options, [{
    slot: { key: '2026-08-03T08', scheduledAtMs: beijingMs('2026-08-03 08:05') },
    trigger: 'startup-catchup',
    dryRun: false,
    force: false
  }]);
});

test('immediately runs an unsent startup slot even outside the old catch-up window', async () => {
  const fixture = schedulerFixture({ now: () => beijingMs('2026-08-03 15:59') });
  fixture.deps.app = {
    state: { getLastSuccessfulSlot: async () => '2026-08-03T00' },
    logger: (fixture.deps.app as FundingJobDeps).logger
  } as FundingJobDeps;

  await startScheduler(fixture.deps);

  assert.equal(fixture.options.length, 1);
  assert.equal(fixture.options[0]!.slot.key, '2026-08-03T08');
  assert.equal(fixture.options[0]!.trigger, 'startup-catchup');
});

test('does not resend the current slot when it already succeeded', async () => {
  const fixture = schedulerFixture({ now: () => beijingMs('2026-08-03 15:59') });
  fixture.deps.app = {
    state: { getLastSuccessfulSlot: async () => '2026-08-03T08' },
    logger: (fixture.deps.app as FundingJobDeps).logger
  } as FundingJobDeps;

  await startScheduler(fixture.deps);

  assert.equal(fixture.options.length, 0);
});

test('uses one flight guard for startup catch-up and a cron callback', async () => {
  const fixture = schedulerFixture({ now: () => beijingMs('2026-08-03 08:20') });
  const waiting = deferred<{ status: 'sent'; slot: string; rowCount: 20 }>();
  fixture.deps.app = {
    state: { getLastSuccessfulSlot: async () => '2026-08-03T00' },
    logger: (fixture.deps.app as FundingJobDeps).logger
  } as unknown as FundingJobDeps;
  fixture.deps.runFundingJob = async (_app, options) => {
    fixture.options.push(options);
    return waiting.promise;
  };

  await startScheduler(fixture.deps);
  fixture.cron.fire();
  await drain();

  assert.equal(fixture.options.length, 1);
  assert.equal(fixture.options[0]!.trigger, 'startup-catchup');
  assert.equal(fixture.logs.filter(({ event }) => event === 'schedule_overlap_skipped').length, 1);

  waiting.resolve({ status: 'sent', slot: fixture.options[0]!.slot.key, rowCount: 20 });
});

test('logs and swallows job failures so later cron callbacks still run', async () => {
  const fixture = schedulerFixture();
  let attempts = 0;
  fixture.deps.runFundingJob = async (_app, options) => {
    fixture.options.push(options);
    attempts += 1;
    if (attempts === 1) throw new Error('network failure');
    return { status: 'sent', slot: options.slot.key, rowCount: 20 };
  };

  await startScheduler(fixture.deps);
  fixture.cron.fire();
  await drain();
  fixture.cron.fire();
  await drain();

  assert.equal(fixture.options.length, 2);
  assert.equal(fixture.logs.filter(({ event }) => event === 'schedule_job_failed').length, 1);
});

test('leaves startup state failures visible instead of registering a daemon', async () => {
  const fixture = schedulerFixture({ now: () => beijingMs('2026-08-03 08:20') });
  fixture.deps.app = {
    state: { getLastSuccessfulSlot: async () => { throw new Error('state unavailable'); } },
    logger: (fixture.deps.app as FundingJobDeps).logger
  } as unknown as FundingJobDeps;

  await assert.rejects(startScheduler(fixture.deps), /state unavailable/);
  assert.equal(fixture.cron.expression, undefined);
});

test('stops once and ignores callbacks after shutdown', async () => {
  const fixture = schedulerFixture();
  const handle = await startScheduler(fixture.deps);

  await handle.stop();
  await handle.stop();
  fixture.cron.fire();
  await drain();

  assert.equal(fixture.cron.stopCalls, 1);
  assert.equal(fixture.options.length, 0);
});

test('waits for an active funding job to settle before shutdown completes', async () => {
  const fixture = schedulerFixture();
  const waiting = deferred<{ status: 'sent'; slot: string; rowCount: 20 }>();
  fixture.deps.runFundingJob = async (_app, options) => {
    fixture.options.push(options);
    return waiting.promise;
  };
  const handle = await startScheduler(fixture.deps);
  fixture.cron.fire();

  let stopped = false;
  const stopping = handle.stop().then(() => { stopped = true; });
  await drain();

  assert.equal(fixture.cron.stopCalls, 1);
  assert.equal(stopped, false);

  waiting.resolve({ status: 'sent', slot: fixture.options[0]!.slot.key, rowCount: 20 });
  await stopping;
  assert.equal(stopped, true);
});

test('daemon lets configuration failures escape and stops once for either termination signal', async () => {
  await assert.rejects(startDaemon({
    loadConfig: () => { throw new Error('invalid daemon config'); }
  }), /invalid daemon config/);

  const signals = new EventEmitter();
  const calls: string[] = [];
  const allowStop = deferred<void>();
  await startDaemon({
    loadConfig: () => config(),
    createApp: () => ({}) as FundingJobDeps,
    startScheduler: async () => ({ stop: async () => {
      calls.push('stop');
      await allowStop.promise;
    } }),
    signals,
    exit: () => { calls.push('exit'); }
  });

  signals.emit('SIGTERM');
  signals.emit('SIGINT');
  await drain();

  assert.deepEqual(calls, ['stop']);
  allowStop.resolve();
  await drain();

  assert.deepEqual(calls, ['stop', 'exit']);
});

test('daemon reports a stop failure and exits unsuccessfully', async () => {
  const signals = new EventEmitter();
  const logs: Array<{ event: string; fields?: Record<string, unknown> }> = [];
  const exits: number[] = [];
  const logger: Logger = {
    info: () => {},
    warn: () => {},
    error: (event, fields) => { logs.push({ event, ...(fields === undefined ? {} : { fields }) }); }
  };

  await startDaemon({
    loadConfig: () => config(),
    createApp: () => ({ logger }) as unknown as FundingJobDeps,
    startScheduler: async () => ({ stop: async () => { throw new Error('cron stop failed'); } }),
    signals,
    exit: (code) => { exits.push(code); }
  });
  signals.emit('SIGTERM');
  await drain();

  assert.equal(logs[0]?.event, 'daemon_stop_failed');
  assert.equal(exits[0], 1);
});

test('PM2 compatibility entry runs one send and exits without restarting', () => {
  const pm2 = require('../ecosystem.config.cjs') as {
    apps: Array<Record<string, unknown>>;
  };

  assert.deepEqual(pm2.apps, [{
    name: 'bn-funding',
    script: 'dist/cli.js',
    args: '--send',
    exec_mode: 'fork',
    instances: 1,
    autorestart: false,
    time: true,
    env: { NODE_ENV: 'production', TZ: 'Asia/Shanghai' }
  }]);
});
