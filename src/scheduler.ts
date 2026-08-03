import type { AppConfig, Logger, RunFundingJobOptions, ScheduledSlot } from './domain.js';
import type { FundingJobDeps } from './job.js';
import { runFundingJob as defaultRunFundingJob } from './job.js';
import { mostRecentElapsedSlot, shouldCatchUp } from './schedule/slots.js';
import { SingleFlight } from './schedule/single-flight.js';

export interface CronTask {
  stop(): void | Promise<void>;
}

export interface CronAdapter {
  schedule(
    expression: string,
    callback: () => void,
    options: { timezone: string }
  ): CronTask;
}

export interface SchedulerHandle {
  stop(): Promise<void>;
}

export interface SchedulerDeps {
  config: AppConfig;
  app: FundingJobDeps;
  cron: CronAdapter;
  now?: () => number;
  singleFlight?: SingleFlight;
  runFundingJob?: (
    app: FundingJobDeps,
    options: RunFundingJobOptions
  ) => ReturnType<typeof defaultRunFundingJob>;
}

function logOverlap(logger: Logger, slot: ScheduledSlot, trigger: RunFundingJobOptions['trigger']): void {
  logger.warn('schedule_overlap_skipped', { slot: slot.key, trigger });
}

function logJobFailure(
  logger: Logger,
  slot: ScheduledSlot,
  trigger: RunFundingJobOptions['trigger'],
  error: unknown
): void {
  logger.error('schedule_job_failed', { slot: slot.key, trigger, error });
}

export async function startScheduler(deps: SchedulerDeps): Promise<SchedulerHandle> {
  const now = deps.now ?? Date.now;
  const singleFlight = deps.singleFlight ?? new SingleFlight();
  const runFundingJob = deps.runFundingJob ?? defaultRunFundingJob;
  let stopped = false;
  let stopPromise: Promise<void> | undefined;
  let activeJob: ReturnType<typeof defaultRunFundingJob> | undefined;

  const invokeJob = (slot: ScheduledSlot, trigger: RunFundingJobOptions['trigger']) => {
    const job = runFundingJob(deps.app, {
      slot,
      trigger,
      dryRun: false,
      force: false
    });
    activeJob = job;
    void job.then(
      () => { if (activeJob === job) activeJob = undefined; },
      () => { if (activeJob === job) activeJob = undefined; }
    );
    return job;
  };

  const run = async (slot: ScheduledSlot, trigger: RunFundingJobOptions['trigger']): Promise<void> => {
    try {
      const result = await singleFlight.run(() => invokeJob(slot, trigger));
      if (!result.started) {
        logOverlap(deps.app.logger, slot, trigger);
      }
    } catch (error) {
      logJobFailure(deps.app.logger, slot, trigger, error);
    }
  };

  const startupNow = now();
  const startupSlot = mostRecentElapsedSlot(startupNow, deps.config.timezone);
  const lastSuccessfulSlot = await deps.app.state.getLastSuccessfulSlot();
  if (shouldCatchUp(
    startupSlot,
    lastSuccessfulSlot,
    startupNow,
    deps.config.catchUpWindowMs
  )) {
    void run(startupSlot, 'startup-catchup');
  }

  const task = deps.cron.schedule(deps.config.schedule, () => {
    if (stopped) return;
    void run(mostRecentElapsedSlot(now(), deps.config.timezone), 'cron');
  }, { timezone: deps.config.timezone });

  return {
    stop: async (): Promise<void> => {
      if (stopPromise !== undefined) return stopPromise;
      stopped = true;
      stopPromise = (async () => {
        await task.stop();
        await activeJob?.catch(() => undefined);
      })();
      return stopPromise;
    }
  };
}
