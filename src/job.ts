import { BinanceClient, BinanceTimeoutError } from './binance/client.js';
import { buildFundingChatMessage } from './chat/cards.js';
import {
  GoogleChatClient,
  GoogleChatRequestError,
  GoogleChatTimeoutError
} from './chat/client.js';
import type { JobResult, Logger, RunFundingJobOptions } from './domain.js';
import { buildFundingLeaderboard } from './funding/aggregate.js';
import { renderLeaderboardText } from './funding/format.js';
import { FileRunStateStore } from './state/store.js';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1_000;

type JobStage =
  | 'state-lock'
  | 'state-check'
  | 'data-fetch'
  | 'compute'
  | 'card-build'
  | 'webhook'
  | 'state-commit';

interface StageDurations {
  dataFetchDurationMs: number;
  computeDurationMs: number;
  cardBuildDurationMs: number;
  webhookDurationMs: number;
}

export interface FundingJobDeps {
  binance: BinanceClient;
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
  switch (stage) {
    case 'data-fetch':
      return error instanceof BinanceTimeoutError ? 'binance-timeout' : 'binance-request';
    case 'compute':
      return 'funding-compute';
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

export async function runFundingJob(
  deps: FundingJobDeps,
  options: RunFundingJobOptions
): Promise<JobResult> {
  const startedAtMs = deps.now();
  let currentStage: JobStage = options.dryRun ? 'data-fetch' : 'state-lock';
  let asOf: number | undefined;
  let operationalFields: Record<string, unknown> = {};
  const stageDurations: StageDurations = {
    dataFetchDurationMs: 0,
    computeDurationMs: 0,
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

    const [contracts, fundingHistory, premiumIndexes, intervals] = await measureAsync(
      'data-fetch',
      'dataFetchDurationMs',
      async () => {
        asOf = await deps.binance.getServerTime();
        return Promise.all([
          deps.binance.getExchangeSymbols(),
          deps.binance.getFundingHistory(asOf - SEVEN_DAYS_MS + 1, asOf),
          deps.binance.getPremiumIndexes(),
          deps.binance.getFundingIntervals()
        ]);
      }
    );
    const leaderboard = measureSync('compute', 'computeDurationMs', () =>
      buildFundingLeaderboard({
        asOf: asOf!,
        contracts,
        history: fundingHistory.records,
        premiumIndexes,
        intervals
      })
    );
    const message = measureSync('card-build', 'cardBuildDurationMs', () =>
      buildFundingChatMessage(leaderboard)
    );
    const payloadBytes = Buffer.byteLength(JSON.stringify(message), 'utf8');
    operationalFields = {
      rowCount: 20,
      eligibleContractCount: leaderboard.eligibleContractCount,
      historyRecordCount: leaderboard.historyRecordCount,
      historyPageCount: fundingHistory.pageCount,
      payloadBytes
    };

    if (options.dryRun) {
      return {
        status: 'dry-run',
        slot: options.slot.key,
        rowCount: 20,
        text: renderLeaderboardText(leaderboard)
      };
    }

    currentStage = 'webhook';
    if (deps.chat === undefined) {
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
