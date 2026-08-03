import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { schedule } from 'node-cron';

import { createApp as defaultCreateApp } from './app.js';
import { loadConfig as defaultLoadConfig } from './config.js';
import type { AppConfig } from './domain.js';
import type { FundingJobDeps } from './job.js';
import { startScheduler as defaultStartScheduler } from './scheduler.js';
import type { CronAdapter, SchedulerDeps, SchedulerHandle } from './scheduler.js';

interface SignalSource {
  once(signal: NodeJS.Signals, listener: () => void): unknown;
}

export interface DaemonDeps {
  env?: NodeJS.ProcessEnv;
  cron?: CronAdapter;
  signals?: SignalSource;
  exit?: (code: number) => void;
  loadConfig?: (env: NodeJS.ProcessEnv, mode: 'daemon') => AppConfig;
  createApp?: (config: AppConfig) => FundingJobDeps;
  startScheduler?: (deps: SchedulerDeps) => Promise<SchedulerHandle>;
}

export async function startDaemon(deps: DaemonDeps = {}): Promise<SchedulerHandle> {
  const config = (deps.loadConfig ?? defaultLoadConfig)(deps.env ?? process.env, 'daemon');
  const app = (deps.createApp ?? defaultCreateApp)(config);
  const cron: CronAdapter = deps.cron ?? { schedule };
  const handle = await (deps.startScheduler ?? defaultStartScheduler)({ config, app, cron });
  const signals = deps.signals ?? process;
  const exit = deps.exit ?? ((code: number) => { process.exit(code); });
  let stopping: Promise<void> | undefined;

  const stop = (): void => {
    if (stopping !== undefined) return;
    stopping = handle.stop()
      .then(() => { exit(0); })
      .catch((error: unknown) => {
        app.logger.error('daemon_stop_failed', { error });
        exit(1);
      });
  };

  signals.once('SIGTERM', stop);
  signals.once('SIGINT', stop);
  return handle;
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(path.resolve(invokedPath)).href) {
  void startDaemon();
}
