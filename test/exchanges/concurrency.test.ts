import assert from 'node:assert/strict';
import test from 'node:test';

import { mapWithConcurrency } from '../../src/exchanges/concurrency.js';

test('preserves order while never exceeding the requested concurrency', async () => {
  let active = 0;
  let maximum = 0;
  const result = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (value) => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise<void>((resolve) => setImmediate(resolve));
    active -= 1;
    return value * 2;
  });
  assert.deepEqual(result, [2, 4, 6, 8, 10]);
  assert.equal(maximum, 2);
});

test('rejects when a worker rejects', async () => {
  await assert.rejects(
    mapWithConcurrency([1, 2, 3], 1, async (value) => {
      if (value === 2) {
        throw new Error('worker failed');
      }
      return value;
    }),
    /worker failed/
  );
});

test('stops assigning work after the first failure and waits for already-started work', async () => {
  const started: number[] = [];
  let releaseStartedWork: (() => void) | undefined;
  const startedWork = new Promise<void>((resolve) => { releaseStartedWork = resolve; });
  let settled = false;

  const outcome = mapWithConcurrency([0, 1, 2, 3, 4], 2, async (value) => {
    started.push(value);
    if (value === 0) throw new Error('first failure');
    if (value === 1) await startedWork;
    return value;
  }).then(
    () => new Error('unexpected success'),
    (error: unknown) => error
  ).finally(() => { settled = true; });

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.deepEqual(started, [0, 1]);

  releaseStartedWork?.();
  const error = await outcome;
  assert.match(String(error), /first failure/);
  assert.deepEqual(started, [0, 1]);
});

test('selects the lowest started item index when multiple workers fail', async () => {
  let releaseLowerIndex: (() => void) | undefined;
  const lowerIndexGate = new Promise<void>((resolve) => { releaseLowerIndex = resolve; });

  const outcome = mapWithConcurrency([0, 1], 2, async (value) => {
    if (value === 0) {
      await lowerIndexGate;
      throw new Error('lower-index failure');
    }
    throw new Error('higher-index failure');
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  releaseLowerIndex?.();

  await assert.rejects(outcome, /lower-index failure/);
});

test('rejects zero and non-integer concurrency', async () => {
  await assert.rejects(
    mapWithConcurrency([1], 0, async (value) => value),
    /concurrency must be a positive integer/
  );
  await assert.rejects(
    mapWithConcurrency([1], 1.5, async (value) => value),
    /concurrency must be a positive integer/
  );
});
