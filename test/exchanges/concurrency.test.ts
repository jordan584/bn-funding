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
