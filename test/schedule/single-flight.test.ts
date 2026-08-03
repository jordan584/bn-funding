import assert from 'node:assert/strict';
import test from 'node:test';

import { SingleFlight } from '../../src/schedule/single-flight.js';

test('rejects overlapping work and accepts new work after the first run settles', async () => {
  const singleFlight = new SingleFlight();
  let resolveFirst: ((value: string) => void) | undefined;
  const firstWork = new Promise<string>((resolve) => {
    resolveFirst = resolve;
  });
  let secondInvocations = 0;

  const first = singleFlight.run(async () => firstWork);
  const overlapping = await singleFlight.run(async () => {
    secondInvocations += 1;
    return 'second';
  });

  assert.deepEqual(overlapping, { started: false, reason: 'overlap' });
  assert.equal(secondInvocations, 0);

  resolveFirst?.('first');
  assert.deepEqual(await first, { started: true, value: 'first' });
  assert.deepEqual(await singleFlight.run(async () => 'third'), { started: true, value: 'third' });
});

test('releases the guard after work rejects', async () => {
  const singleFlight = new SingleFlight();

  await assert.rejects(singleFlight.run(async () => Promise.reject(new Error('failed run'))), /failed run/);

  assert.deepEqual(await singleFlight.run(async () => 'recovered'), {
    started: true,
    value: 'recovered'
  });
});
