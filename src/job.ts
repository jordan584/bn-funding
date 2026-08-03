import { BinanceClient } from './binance/client.js';
import { buildFundingChatMessage } from './chat/cards.js';
import { GoogleChatClient } from './chat/client.js';
import type { JobResult, Logger, RunFundingJobOptions } from './domain.js';
import { buildFundingLeaderboard } from './funding/aggregate.js';
import { renderLeaderboardText } from './funding/format.js';
import { FileRunStateStore } from './state/store.js';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1_000;

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
  fields: Record<string, unknown>
): void {
  logger.info('funding_job.completed', {
    trigger: options.trigger,
    slot: options.slot.key,
    durationMs: Date.now() - startedAtMs,
    ...fields
  });
}

export async function runFundingJob(
  deps: FundingJobDeps,
  options: RunFundingJobOptions
): Promise<JobResult> {
  const startedAtMs = Date.now();

  if (!options.dryRun) {
    const lastSuccessfulSlot = await deps.state.getLastSuccessfulSlot();
    if (!options.force && lastSuccessfulSlot === options.slot.key) {
      const result: JobResult = {
        status: 'skipped',
        slot: options.slot.key,
        reason: 'already-sent'
      };
      completedLog(deps.logger, options, startedAtMs, { status: result.status });
      return result;
    }
  }

  const asOf = await deps.binance.getServerTime();
  const [contracts, fundingHistory, premiumIndexes, intervals] = await Promise.all([
    deps.binance.getExchangeSymbols(),
    deps.binance.getFundingHistory(asOf - SEVEN_DAYS_MS + 1, asOf),
    deps.binance.getPremiumIndexes(),
    deps.binance.getFundingIntervals()
  ]);
  const leaderboard = buildFundingLeaderboard({
    asOf,
    contracts,
    history: fundingHistory.records,
    premiumIndexes,
    intervals
  });
  const message = buildFundingChatMessage(leaderboard);
  const payloadBytes = Buffer.byteLength(JSON.stringify(message), 'utf8');

  if (options.dryRun) {
    const result: JobResult = {
      status: 'dry-run',
      slot: options.slot.key,
      rowCount: 20,
      text: renderLeaderboardText(leaderboard)
    };
    completedLog(deps.logger, options, startedAtMs, {
      status: result.status,
      rowCount: result.rowCount,
      eligibleContractCount: leaderboard.eligibleContractCount,
      historyRecordCount: leaderboard.historyRecordCount,
      historyPageCount: fundingHistory.pageCount,
      payloadBytes
    });
    return result;
  }

  if (deps.chat === undefined) {
    throw new Error('Google Chat client is required when sending');
  }
  await deps.chat.send(message);
  await deps.state.markSuccessful(options.slot, deps.now());
  const result: JobResult = { status: 'sent', slot: options.slot.key, rowCount: 20 };
  completedLog(deps.logger, options, startedAtMs, {
    status: result.status,
    rowCount: result.rowCount,
    eligibleContractCount: leaderboard.eligibleContractCount,
    historyRecordCount: leaderboard.historyRecordCount,
    historyPageCount: fundingHistory.pageCount,
    payloadBytes
  });
  return result;
}
