import { BinanceClient } from './binance/client.js';
import { GoogleChatClient } from './chat/client.js';
import type { AppConfig, Logger } from './domain.js';
import type { FundingJobDeps } from './job.js';
import { log } from './logger.js';
import { FileRunStateStore } from './state/store.js';

function createLogger(): Logger {
  return {
    info: (event, fields) => { log('info', event, fields); },
    warn: (event, fields) => { log('warn', event, fields); },
    error: (event, fields) => { log('error', event, fields); }
  };
}

export function createApp(config: AppConfig): FundingJobDeps {
  return {
    binance: new BinanceClient({
      baseUrl: config.binanceBaseUrl,
      timeoutMs: config.binanceTimeoutMs
    }),
    ...(config.googleChatWebhookUrl === undefined
      ? {}
      : { chat: new GoogleChatClient({
        webhookUrl: config.googleChatWebhookUrl,
        timeoutMs: config.chatTimeoutMs
      }) }),
    state: new FileRunStateStore(config.stateFile),
    now: Date.now,
    logger: createLogger()
  };
}
