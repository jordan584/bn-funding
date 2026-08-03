import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { createApp } from './app.js';
import { loadConfig } from './config.js';
import type { RunMode } from './domain.js';
import { runFundingJob } from './job.js';
import { log } from './logger.js';
import { mostRecentElapsedSlot } from './schedule/slots.js';

interface CliOptions {
  mode: Extract<RunMode, 'dry-run' | 'send'>;
  force: boolean;
}

export function parseCliArgs(args: string[]): CliOptions {
  const known = new Set(['--dry-run', '--send', '--force']);
  const unknown = args.find((arg) => !known.has(arg));
  if (unknown !== undefined) {
    throw new Error(`Unknown argument: ${unknown}`);
  }
  const dryRunCount = args.filter((arg) => arg === '--dry-run').length;
  const sendCount = args.filter((arg) => arg === '--send').length;
  const forceCount = args.filter((arg) => arg === '--force').length;
  if (forceCount > 1) {
    throw new Error('Duplicate argument: --force');
  }
  if (forceCount === 1 && sendCount !== 1) {
    throw new Error('--force is only valid with --send');
  }
  if (dryRunCount + sendCount !== 1) {
    throw new Error('Exactly one of --dry-run or --send is required');
  }
  const dryRun = dryRunCount === 1;
  const send = sendCount === 1;
  const force = forceCount === 1;
  return { mode: dryRun ? 'dry-run' : 'send', force };
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  try {
    const options = parseCliArgs(args);
    const app = createApp(loadConfig(process.env, options.mode));
    const result = await runFundingJob(app, {
      slot: mostRecentElapsedSlot(Date.now()),
      trigger: 'manual',
      dryRun: options.mode === 'dry-run',
      force: options.force
    });
    if (result.status === 'dry-run') {
      process.stdout.write(`${result.text}\n`);
    }
  } catch (error) {
    log('error', 'cli.failed', { error });
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(path.resolve(invokedPath)).href) {
  void main();
}
