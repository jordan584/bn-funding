import { BinanceRequestError, BinanceTimeoutError } from './binance/client.js';
import { buildFundingChatMessage } from './chat/multi-venue-cards.js';
import {
  GoogleChatClient,
  GoogleChatRequestError,
  GoogleChatTimeoutError
} from './chat/client.js';
import {
  VENUE_IDS,
  type FundingVenueAdapter,
  type JobResult,
  type Logger,
  type RunFundingJobOptions,
  type VenueId
} from './domain.js';
import { VenueRequestError, VenueTimeoutError } from './exchanges/http.js';
import { buildCompositeFundingLeaderboard } from './funding/composite.js';
import { hydrateSevenDayFunding } from './funding/history.js';
import { renderLeaderboardText } from './funding/multi-venue-format.js';
import { FileRunStateStore } from './state/store.js';

type JobStage =
  | 'state-lock'
  | 'state-check'
  | 'current-fetch'
  | 'rank'
  | 'history-fetch'
  | 'card-build'
  | 'webhook'
  | 'state-commit';

interface StageDurations {
  currentFetchDurationMs: number;
  rankDurationMs: number;
  historyFetchDurationMs: number;
  cardBuildDurationMs: number;
  webhookDurationMs: number;
}

export interface FundingJobDeps {
  venues: Record<VenueId, FundingVenueAdapter>;
  chat?: GoogleChatClient;
  state: FileRunStateStore;
  now: () => number;
  logger: Logger;
}

function completedLog(
  logger: Logger,
  options: RunFundingJobOptions,
  startedAtMs: number,
  finishedAtMs: number,
  fields: Record<string, unknown>
): void {
  logger.info('funding_job.completed', {
    trigger: options.trigger,
    slot: options.slot.key,
    durationMs: Math.max(0, finishedAtMs - startedAtMs),
    ...fields
  });
}

function failureCategory(stage: JobStage, error: unknown): string {
  if (error instanceof VenueTimeoutError) return `${error.venue}-timeout`;
  if (error instanceof VenueRequestError) return `${error.venue}-request`;
  if (error instanceof BinanceTimeoutError) return 'binance-timeout';
  if (error instanceof BinanceRequestError) return 'binance-request';

  switch (stage) {
    case 'current-fetch':
      return 'funding-current';
    case 'rank':
      return 'funding-compute';
    case 'history-fetch':
      return 'funding-history';
    case 'card-build':
      return 'chat-payload';
    case 'webhook':
      if (error instanceof GoogleChatTimeoutError) return 'google-chat-timeout';
      if (error instanceof GoogleChatRequestError) return 'google-chat-request';
      return 'google-chat-request';
    case 'state-lock':
    case 'state-check':
    case 'state-commit':
      return 'state-store';
  }
}

function coverageCounts(rows: Array<{ coverageCount: number }>): {
  two: number;
  three: number;
  four: number;
  five: number;
} {
  const counts = { two: 0, three: 0, four: 0, five: 0 };
  for (const row of rows) {
    if (row.coverageCount === 2) counts.two += 1;
    if (row.coverageCount === 3) counts.three += 1;
    if (row.coverageCount === 4) counts.four += 1;
    if (row.coverageCount === 5) counts.five += 1;
  }
  return counts;
}

export async function runFundingJob(
  deps: FundingJobDeps,
  options: RunFundingJobOptions
): Promise<JobResult> {
  const startedAtMs = deps.now();
  let currentStage: JobStage = options.dryRun ? 'current-fetch' : 'state-lock';
  let asOf: number | undefined;
  let operationalFields: Record<string, unknown> = {};
  const stageDurations: StageDurations = {
    currentFetchDurationMs: 0,
    rankDurationMs: 0,
    historyFetchDurationMs: 0,
    cardBuildDurationMs: 0,
    webhookDurationMs: 0
  };

  const measureAsync = async <T>(
    stage: JobStage,
    durationField: keyof StageDurations,
    work: () => Promise<T>
  ): Promise<T> => {
    currentStage = stage;
    const stageStartedAtMs = deps.now();
    try {
      return await work();
    } finally {
      stageDurations[durationField] = Math.max(0, deps.now() - stageStartedAtMs);
    }
  };

  const measureSync = <T>(
    stage: JobStage,
    durationField: keyof StageDurations,
    work: () => T
  ): T => {
    currentStage = stage;
    const stageStartedAtMs = deps.now();
    try {
      return work();
    } finally {
      stageDurations[durationField] = Math.max(0, deps.now() - stageStartedAtMs);
    }
  };

  const runTransaction = async (): Promise<JobResult> => {
    if (!options.dryRun) {
      currentStage = 'state-check';
      const lastSuccessfulSlot = await deps.state.getLastSuccessfulSlot();
      if (!options.force && lastSuccessfulSlot === options.slot.key) {
        return {
          status: 'skipped',
          slot: options.slot.key,
          reason: 'already-sent'
        };
      }
    }

    const snapshots = await measureAsync(
      'current-fetch',
      'currentFetchDurationMs',
      () => Promise.all(VENUE_IDS.map((venue) => deps.venues[venue].getCurrentSnapshot()))
    );
    asOf = deps.now();
    const ranked = measureSync('rank', 'rankDurationMs', () =>
      buildCompositeFundingLeaderboard({ asOf: asOf!, snapshots })
    );
    const hydrated = await measureAsync('history-fetch', 'historyFetchDurationMs', () =>
      hydrateSevenDayFunding({
        asOf: asOf!,
        leaderboard: ranked,
        adapters: deps.venues
      })
    );
    const message = measureSync('card-build', 'cardBuildDurationMs', () =>
      buildFundingChatMessage(hydrated.leaderboard)
    );
    const payloadBytes = Buffer.byteLength(JSON.stringify(message), 'utf8');
    operationalFields = {
      candidateCount: ranked.candidateCount,
      rowCount: 20,
      coverageCounts: coverageCounts(hydrated.leaderboard.rows),
      payloadBytes,
      venues: Object.fromEntries(VENUE_IDS.map((venue) => {
        const current = ranked.venueStats[venue];
        const history = hydrated.venueStats[venue];
        return [venue, {
          marketCount: current.marketCount,
          currentRequestCount: current.requestCount,
          currentPageCount: current.pageCount,
          historyRequestCount: history.requestCount,
          historyPageCount: history.pageCount,
          historyRecordCount: history.recordCount
        }];
      }))
    };

    if (options.dryRun) {
      return {
        status: 'dry-run',
        slot: options.slot.key,
        rowCount: 20,
        text: renderLeaderboardText(hydrated.leaderboard)
      };
    }

    if (deps.chat === undefined) {
      currentStage = 'webhook';
      throw new Error('Google Chat client is required when sending');
    }
    await measureAsync('webhook', 'webhookDurationMs', () => deps.chat!.send(message));
    currentStage = 'state-commit';
    await deps.state.markSuccessful(options.slot, deps.now());
    return {
      status: 'sent',
      slot: options.slot.key,
      rowCount: 20
    };
  };

  try {
    const result = options.dryRun
      ? await runTransaction()
      : await deps.state.withRunLock(runTransaction);
    completedLog(deps.logger, options, startedAtMs, deps.now(), {
      status: result.status,
      asOf: asOf ?? null,
      ...stageDurations,
      ...operationalFields
    });
    return result;
  } catch (error) {
    deps.logger.error('funding_job.failed', {
      slot: options.slot.key,
      trigger: options.trigger,
      stage: currentStage,
      errorCategory: failureCategory(currentStage, error),
      asOf: asOf ?? null,
      durationMs: Math.max(0, deps.now() - startedAtMs)
    });
    throw error;
  }
}
