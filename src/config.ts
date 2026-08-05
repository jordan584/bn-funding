import path from 'node:path';

import type { AppConfig, RunMode } from './domain.js';

const GOOGLE_CHAT_HOST = 'chat.googleapis.com';
const DEFAULT_STATE_FILE = path.resolve('data/state.json');

function isGoogleChatWebhook(url: URL): boolean {
  return url.protocol === 'https:' && url.hostname === GOOGLE_CHAT_HOST;
}

function parseGoogleChatWebhook(value: string): URL {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new Error('GOOGLE_CHAT_WEBHOOK_URL must be a valid HTTPS Google Chat URL');
  }

  if (!isGoogleChatWebhook(url)) {
    throw new Error('GOOGLE_CHAT_WEBHOOK_URL must be a valid HTTPS Google Chat URL');
  }

  return url;
}

export function loadConfig(env: NodeJS.ProcessEnv, mode: RunMode): AppConfig {
  const timezone = env.TZ ?? 'Asia/Shanghai';
  if (timezone !== 'Asia/Shanghai') {
    throw new Error('TZ must be Asia/Shanghai');
  }

  const stateFile = env.STATE_FILE?.trim();
  const webhookValue = env.GOOGLE_CHAT_WEBHOOK_URL?.trim();
  const needsDeliveryConfig = mode === 'daemon' || mode === 'send';

  if (needsDeliveryConfig && !stateFile) {
    throw new Error('STATE_FILE is required in daemon and send modes');
  }
  if (needsDeliveryConfig && stateFile !== undefined && !path.isAbsolute(stateFile)) {
    throw new Error('STATE_FILE must be an absolute path in daemon and send modes');
  }

  if (needsDeliveryConfig && !webhookValue) {
    throw new Error('GOOGLE_CHAT_WEBHOOK_URL is required in daemon and send modes');
  }

  return {
    exchangeBaseUrls: {
      binance: new URL('https://fapi.binance.com'),
      okx: new URL('https://www.okx.com'),
      hyperliquid: new URL('https://api.hyperliquid.xyz'),
      bybit: new URL('https://api.bybit.com'),
      bitget: new URL('https://api.bitget.com')
    },
    ...(webhookValue ? { googleChatWebhookUrl: parseGoogleChatWebhook(webhookValue) } : {}),
    stateFile: stateFile ?? DEFAULT_STATE_FILE,
    timezone,
    schedule: '5 0,8,16 * * *',
    catchUpWindowMs: 30 * 60_000,
    exchangeTimeoutMs: 10_000,
    chatTimeoutMs: 15_000
  };
}
