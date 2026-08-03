import { DateTime } from 'luxon';

import type { ScheduledSlot } from '../domain.js';

const SLOT_HOURS = [0, 8, 16] as const;
const SLOT_MINUTE = 5;
const DEFAULT_CATCH_UP_WINDOW_MS = 30 * 60_000;

function toSlot(value: DateTime): ScheduledSlot {
  return {
    key: value.toFormat("yyyy-MM-dd'T'HH"),
    scheduledAtMs: value.toMillis()
  };
}

export function mostRecentElapsedSlot(nowMs: number, zone = 'Asia/Shanghai'): ScheduledSlot {
  const now = DateTime.fromMillis(nowMs, { zone });
  const today = now.startOf('day');
  const latestToday = [...SLOT_HOURS]
    .reverse()
    .map((hour) => today.set({ hour, minute: SLOT_MINUTE }))
    .find((slot) => slot <= now);

  return toSlot(latestToday ?? today.minus({ days: 1 }).set({ hour: 16, minute: SLOT_MINUTE }));
}

export function shouldCatchUp(
  candidate: ScheduledSlot,
  lastSuccessfulSlot: string | null,
  nowMs: number,
  catchUpWindowMs = DEFAULT_CATCH_UP_WINDOW_MS
): boolean {
  return (
    candidate.key !== lastSuccessfulSlot &&
    nowMs >= candidate.scheduledAtMs &&
    nowMs - candidate.scheduledAtMs <= catchUpWindowMs
  );
}
