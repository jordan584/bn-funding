import assert from 'node:assert/strict';
import test from 'node:test';

import { DateTime } from 'luxon';

import { mostRecentElapsedSlot, shouldCatchUp } from '../../src/schedule/slots.js';

const zone = 'Asia/Shanghai';

function beijingMs(localTime: string): number {
  const value = DateTime.fromFormat(localTime, 'yyyy-MM-dd HH:mm', { zone });
  assert.equal(value.isValid, true);
  return value.toMillis();
}

test('selects the latest elapsed Beijing schedule slot across midnight and boundaries', () => {
  const cases = [
    ['2026-08-03 00:04', '2026-08-02T16'],
    ['2026-08-03 00:05', '2026-08-03T00'],
    ['2026-08-03 08:34', '2026-08-03T08'],
    ['2026-08-03 08:36', '2026-08-03T08'],
    ['2026-08-03 16:05', '2026-08-03T16']
  ] as const;

  for (const [now, expectedKey] of cases) {
    assert.equal(mostRecentElapsedSlot(beijingMs(now), zone).key, expectedKey, now);
  }
});

test('allows catch-up only through the first thirty minutes after the elapsed slot', () => {
  const cases = [
    ['2026-08-03 00:04', false],
    ['2026-08-03 00:05', true],
    ['2026-08-03 08:34', true],
    ['2026-08-03 08:35', true],
    ['2026-08-03 08:36', false],
    ['2026-08-03 16:05', true]
  ] as const;

  for (const [now, expected] of cases) {
    const nowMs = beijingMs(now);
    const candidate = mostRecentElapsedSlot(nowMs, zone);
    assert.equal(shouldCatchUp(candidate, null, nowMs), expected, now);
  }
});

test('does not catch up a slot that was already successfully sent', () => {
  const nowMs = beijingMs('2026-08-03 08:20');
  const candidate = mostRecentElapsedSlot(nowMs, zone);

  assert.equal(shouldCatchUp(candidate, candidate.key, nowMs), false);
});
