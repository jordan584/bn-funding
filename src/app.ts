import { BinanceVenueAdapter } from './binance/adapter.js';
import { BinanceBStocksClient } from './binance/bstocks.js';
import { BitgetClient } from './bitget/client.js';
import { BybitClient } from './bybit/client.js';
import { GoogleChatClient } from './chat/client.js';
import type { AppConfig, Logger } from './domain.js';
import { HyperliquidClient } from './hyperliquid/client.js';
import type { FundingJobDeps } from './job.js';
import { log } from './logger.js';
import { OkxClient } from './okx/client.js';
import { FileRunStateStore } from './state/store.js';
import { GitHubImagePublisher } from './github/image-publisher.js';
import { renderFundingReportImages } from './image/funding-report.js';

function createLogger(): Logger {
  return {
    info: (event, fields) => { log('info', event, fields); },
    warn: (event, fields) => { log('warn', event, fields); },
    error: (event, fields) => { log('error', event, fields); }
  };
}

export function createApp(config: AppConfig): FundingJobDeps {
  return {
    stockUniverse: new BinanceBStocksClient({
      baseUrl: config.bStocksBaseUrl,
      timeoutMs: config.exchangeTimeoutMs
    }),
    venues: {
      binance: new BinanceVenueAdapter({
        baseUrl: config.exchangeBaseUrls.binance,
        timeoutMs: config.exchangeTimeoutMs,
        stocksOnly: true
      }),
      okx: new OkxClient({
        baseUrl: config.exchangeBaseUrls.okx,
        timeoutMs: config.exchangeTimeoutMs,
        stocksOnly: true
      }),
      hyperliquid: new HyperliquidClient({
        baseUrl: config.exchangeBaseUrls.hyperliquid,
        timeoutMs: config.exchangeTimeoutMs,
        dex: 'xyz'
      }),
      bybit: new BybitClient({
        baseUrl: config.exchangeBaseUrls.bybit,
        timeoutMs: config.exchangeTimeoutMs,
        stocksOnly: true
      }),
      bitget: new BitgetClient({
        baseUrl: config.exchangeBaseUrls.bitget,
        timeoutMs: config.exchangeTimeoutMs,
        stocksOnly: true
      })
    },
    ...(config.googleChatWebhookUrl === undefined
      ? {}
      : { chat: new GoogleChatClient({
        webhookUrl: config.googleChatWebhookUrl,
        timeoutMs: config.chatTimeoutMs
      }) }),
    ...(config.github === undefined
      ? {}
      : { imagePublisher: new GitHubImagePublisher({
        token: config.github.token,
        repository: config.github.repository,
        branch: config.github.branch
      }) }),
    renderImages: renderFundingReportImages,
    state: new FileRunStateStore(config.stateFile),
    now: Date.now,
    logger: createLogger()
  };
}
