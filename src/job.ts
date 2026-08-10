import { BinanceRequestError, BinanceTimeoutError } from './binance/client.js';
import { buildFundingImageChatMessage } from './chat/image-message.js';
import {
  GoogleChatClient,
  GoogleChatRequestError,
  GoogleChatTimeoutError
} from './chat/client.js';
import {
  VENUE_IDS,
  type CompositeFundingLeaderboard,
  type CompositeFundingRow,
  type FundingVenueAdapter,
  type JobResult,
  type Logger,
  type RunFundingJobOptions,
  type VenueId,
  type VenueRequestTelemetry
} from './domain.js';
import { VenueRequestError, VenueTimeoutError } from './exchanges/http.js';
import {
  assertCompleteVenueSnapshots,
  buildCompositeFundingLeaderboard,
  type CoverageCountsTelemetry,
  type NormalizationTelemetry
} from './funding/composite.js';
import {
  hydrateSevenDayFunding,
  type HistoryHydrationVenueStats
} from './funding/history.js';
import { renderLeaderboardText } from './funding/multi-venue-format.js';
import { FileRunStateStore } from './state/store.js';
import type { GitHubImagePublisher } from './github/image-publisher.js';
import type { FundingReportImage } from './image/funding-report.js';

type JobStage =
  | 'state-lock'
  | 'state-check'
  | 'current-fetch'
  | 'rank'
  | 'history-fetch'
  | 'card-build'
  | 'image-upload'
  | 'webhook'
  | 'state-commit';

interface StageDurations {
  currentFetchDurationMs: number;
  rankDurationMs: number;
  historyFetchDurationMs: number;
  cardBuildDurationMs: number;
  imageUploadDurationMs: number;
  webhookDurationMs: number;
}

interface VenueOperationalFields {
  marketCount: number;
  currentFundingCount: number;
  currentRequestCount: number;
  currentPageCount: number;
  currentRetryCount: number;
  currentDurationMs: number;
  historySelectedMarketCount: number;
  historyRequestCount: number;
  historyPageCount: number;
  historyRetryCount: number;
  historyRecordCount: number;
  historyCoverageDays: { minimum: string | null; maximum: string | null; average: string | null };
  historyStageDurationMs: number;
}

interface JobOperationalFields {
  candidateCount: number | null;
  rowCount: number | null;
  normalization: NormalizationTelemetry;
  candidateCoverageCounts: CoverageCountsTelemetry;
  top20CoverageCounts: CoverageCountsTelemetry;
  top20: Array<Record<string, unknown>>;
  payloadBytes: number | null;
  pushResult: 'not-attempted' | 'attempted' | 'failed' | 'sent' | 'skipped-dry-run';
  slotState: 'unknown' | 'eligible' | 'already-sent' | 'dry-run-isolated' | 'commit-pending' | 'commit-failed' | 'committed';
  venues: Record<VenueId, VenueOperationalFields>;
}

export interface FundingJobDeps {
  venues: Record<VenueId, FundingVenueAdapter>;
  chat?: GoogleChatClient;
  renderImages?: (leaderboard: CompositeFundingLeaderboard) => Promise<FundingReportImage[]>;
  imagePublisher?: Pick<GitHubImagePublisher, 'publish'>;
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
    case 'image-upload':
      return 'github-image-upload';
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

function coverageCounts(rows: readonly { coverageCount: number }[]): CoverageCountsTelemetry {
  const counts = { two: 0, three: 0, four: 0, five: 0 };
  for (const row of rows) {
    if (row.coverageCount === 2) counts.two += 1;
    if (row.coverageCount === 3) counts.three += 1;
    if (row.coverageCount === 4) counts.four += 1;
    if (row.coverageCount === 5) counts.five += 1;
  }
  return counts;
}

function initialOperationalFields(dryRun: boolean): JobOperationalFields {
  return {
    candidateCount: null,
    rowCount: null,
    normalization: {
      beforeAssetCount: 0,
      afterAssetCount: 0,
      explicitAliasCount: 0,
      conflictCount: 0
    },
    candidateCoverageCounts: { two: 0, three: 0, four: 0, five: 0 },
    top20CoverageCounts: { two: 0, three: 0, four: 0, five: 0 },
    top20: [],
    payloadBytes: null,
    pushResult: 'not-attempted',
    slotState: dryRun ? 'dry-run-isolated' : 'unknown',
    venues: Object.fromEntries(VENUE_IDS.map((venue) => [venue, {
      marketCount: 0,
      currentFundingCount: 0,
      currentRequestCount: 0,
      currentPageCount: 0,
      currentRetryCount: 0,
      currentDurationMs: 0,
      historySelectedMarketCount: 0,
      historyRequestCount: 0,
      historyPageCount: 0,
      historyRetryCount: 0,
      historyRecordCount: 0,
      historyCoverageDays: { minimum: null, maximum: null, average: null },
      historyStageDurationMs: 0
    }])) as Record<VenueId, VenueOperationalFields>
  };
}

function top20Telemetry(rows: readonly CompositeFundingRow[]): Array<Record<string, unknown>> {
  return rows.map((row) => ({
    rank: row.rank,
    asset: row.asset,
    compositeNextApr: row.compositeNextApr.toString(),
    coverageCount: row.coverageCount,
    venues: Object.fromEntries(VENUE_IDS.map((venue) => [venue,
      row.venues[venue] === undefined
        ? { status: 'missing', reason: 'not-listed' }
        : { status: 'present' }
    ]))
  }));
}

function applyRequestTelemetry(
  fields: JobOperationalFields,
  telemetry: VenueRequestTelemetry
): void {
  const venue = fields.venues[telemetry.venue];
  if (telemetry.operation === 'current') {
    venue.currentRequestCount += 1;
    venue.currentRetryCount += telemetry.retries;
    return;
  }
  venue.historyRequestCount += 1;
  venue.historyRetryCount += telemetry.retries;
}

function applyHistoryProgress(
  fields: JobOperationalFields,
  stats: Record<VenueId, HistoryHydrationVenueStats>
): void {
  for (const venue of VENUE_IDS) {
    const source = stats[venue];
    const target = fields.venues[venue];
    target.historySelectedMarketCount = source.selectedMarketCount;
    target.historyRequestCount = Math.max(target.historyRequestCount, source.requestCount);
    target.historyPageCount = source.pageCount;
    target.historyRecordCount = source.recordCount;
    target.historyCoverageDays = {
      minimum: source.coverageDays.minimum?.toString() ?? null,
      maximum: source.coverageDays.maximum?.toString() ?? null,
      average: source.coverageDays.average?.toString() ?? null
    };
    target.historyStageDurationMs = source.stageDurationMs;
  }
}

export async function runFundingJob(
  deps: FundingJobDeps,
  options: RunFundingJobOptions
): Promise<JobResult> {
  const startedAtMs = deps.now();
  let currentStage: JobStage = options.dryRun ? 'current-fetch' : 'state-lock';
  let asOf: number | undefined;
  const operationalFields = initialOperationalFields(options.dryRun);
  const stageDurations: StageDurations = {
    currentFetchDurationMs: 0,
    rankDurationMs: 0,
    historyFetchDurationMs: 0,
    cardBuildDurationMs: 0,
    imageUploadDurationMs: 0,
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
        operationalFields.slotState = 'already-sent';
        return {
          status: 'skipped',
          slot: options.slot.key,
          reason: 'already-sent'
        };
      }
      operationalFields.slotState = 'eligible';
    }

    const snapshots = await measureAsync(
      'current-fetch',
      'currentFetchDurationMs',
      async () => {
        const settled = await Promise.allSettled(
          VENUE_IDS.map(async (venue) => {
            const venueStartedAt = deps.now();
            try {
              const snapshot = await deps.venues[venue].getCurrentSnapshot((telemetry) => {
                applyRequestTelemetry(operationalFields, telemetry);
              });
              const fields = operationalFields.venues[venue];
              fields.marketCount = snapshot.stats.marketCount;
              fields.currentFundingCount = snapshot.markets.length;
              fields.currentRequestCount = Math.max(fields.currentRequestCount, snapshot.stats.requestCount);
              fields.currentPageCount = snapshot.stats.pageCount;
              return snapshot;
            } finally {
              operationalFields.venues[venue].currentDurationMs = Math.max(
                0,
                deps.now() - venueStartedAt
              );
            }
          })
        );
        return settled.map((result) => {
          if (result.status === 'rejected') throw result.reason;
          return result.value;
        });
      }
    );
    asOf = deps.now();
    assertCompleteVenueSnapshots(snapshots, asOf);
    const ranked = measureSync('rank', 'rankDurationMs', () =>
      buildCompositeFundingLeaderboard({
        asOf: asOf!,
        snapshots,
        onTelemetry: (telemetry) => {
          operationalFields.normalization = telemetry.normalization;
          operationalFields.candidateCoverageCounts = telemetry.candidateCoverageCounts;
        }
      })
    );
    operationalFields.candidateCount = ranked.candidateCount;
    operationalFields.rowCount = ranked.rows.length;
    operationalFields.top20CoverageCounts = coverageCounts(ranked.rows);
    operationalFields.top20 = top20Telemetry(ranked.rows);
    const hydrated = await measureAsync('history-fetch', 'historyFetchDurationMs', () =>
      hydrateSevenDayFunding({
        asOf: asOf!,
        leaderboard: ranked,
        adapters: deps.venues,
        now: deps.now,
        onRequestTelemetry: (telemetry) => {
          applyRequestTelemetry(operationalFields, telemetry);
        },
        onProgress: (stats) => {
          applyHistoryProgress(operationalFields, stats);
        }
      })
    );
    if (options.dryRun) {
      operationalFields.pushResult = 'skipped-dry-run';
      return {
        status: 'dry-run',
        slot: options.slot.key,
        rowCount: 20,
        text: renderLeaderboardText(hydrated.leaderboard)
      };
    }

    if (deps.chat === undefined || deps.renderImages === undefined || deps.imagePublisher === undefined) {
      currentStage = 'webhook';
      throw new Error('Image renderer, GitHub publisher, and Google Chat client are required when sending');
    }
    const renderedImages = await measureAsync('card-build', 'cardBuildDurationMs', () =>
      deps.renderImages!(hydrated.leaderboard)
    );
    const publishedImages = await measureAsync('image-upload', 'imageUploadDurationMs', () =>
      deps.imagePublisher!.publish(renderedImages, options.slot)
    );
    const message = buildFundingImageChatMessage(hydrated.leaderboard.asOf, publishedImages);
    operationalFields.payloadBytes = Buffer.byteLength(JSON.stringify(message), 'utf8');
    operationalFields.pushResult = 'attempted';
    try {
      await measureAsync('webhook', 'webhookDurationMs', () => deps.chat!.send(message));
      operationalFields.pushResult = 'sent';
    } catch (error) {
      operationalFields.pushResult = 'failed';
      throw error;
    }
    currentStage = 'state-commit';
    operationalFields.slotState = 'commit-pending';
    try {
      await deps.state.markSuccessful(options.slot, deps.now());
      operationalFields.slotState = 'committed';
    } catch (error) {
      operationalFields.slotState = 'commit-failed';
      throw error;
    }
    return {
      status: 'sent',
      slot: options.slot.key,
      rowCount: 20
    };
  };

  try {
    const result = options.dryRun
      ? await runTransaction()
      : await deps.state.withRunLock(async () => {
        const transactionResult = await runTransaction();
        currentStage = 'state-lock';
        return transactionResult;
      });
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
      durationMs: Math.max(0, deps.now() - startedAtMs),
      ...stageDurations,
      ...operationalFields
    });
    throw error;
  }
}
