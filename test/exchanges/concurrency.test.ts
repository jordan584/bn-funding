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
