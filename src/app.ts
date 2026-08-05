import { BinanceVenueAdapter } from './binance/adapter.js';
import { BitgetClient } from './bitget/client.js';
import { BybitClient } from './bybit/client.js';
import { GoogleChatClient } from './chat/client.js';
import type { AppConfig, Logger } from './domain.js';
import { HyperliquidClient } from './hyperliquid/client.js';
import type { FundingJobDeps } from './job.js';
import { log } from './logger.js';
import { OkxClient } from './okx/client.js';
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
    venues: {
      binance: new BinanceVenueAdapter({
        baseUrl: config.exchangeBaseUrls.binance,
        timeoutMs: config.exchangeTimeoutMs
      }),
      okx: new OkxClient({
        baseUrl: config.exchangeBaseUrls.okx,
        timeoutMs: config.exchangeTimeoutMs
      }),
      hyperliquid: new HyperliquidClient({
        baseUrl: config.exchangeBaseUrls.hyperliquid,
        timeoutMs: config.exchangeTimeoutMs
      }),
      bybit: new BybitClient({
        baseUrl: config.exchangeBaseUrls.bybit,
        timeoutMs: config.exchangeTimeoutMs
      }),
      bitget: new BitgetClient({
        baseUrl: config.exchangeBaseUrls.bitget,
        timeoutMs: config.exchangeTimeoutMs
      })
    },
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
