import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { loadConfig } from '../src/config.js';
import { log } from '../src/logger.js';

const validDaemonEnv = {
  GOOGLE_CHAT_WEBHOOK_URL:
    'https://chat.googleapis.com/v1/spaces/space/messages?key=k&token=t',
  GITHUB_TOKEN: 'github_pat_test',
  GITHUB_REPOSITORY: 'jordan584/bn-funding',
  GITHUB_IMAGE_BRANCH: 'funding-images',
  TZ: 'Asia/Shanghai'
};

test('daemon configuration is production-safe', () => {
  const config = loadConfig(validDaemonEnv, 'daemon');

  assert.equal(config.schedule, '5 0,8,16 * * *');
  assert.equal(config.timezone, 'Asia/Shanghai');
  assert.deepEqual(Object.fromEntries(
    Object.entries(config.exchangeBaseUrls).map(([venue, url]) => [venue, url.origin])
  ), {
    binance: 'https://fapi.binance.com',
    okx: 'https://www.okx.com',
    hyperliquid: 'https://api.hyperliquid.xyz',
    bybit: 'https://api.bybit.com',
    bitget: 'https://api.bitget.com'
  });
  assert.equal(config.bStocksBaseUrl.origin, 'https://www.binance.com');
  assert.equal(config.exchangeTimeoutMs, 10_000);
  assert.equal(config.chatTimeoutMs, 15_000);
  assert.equal(config.catchUpWindowMs, 30 * 60_000);
  assert.equal(config.stateFile, path.resolve('state.json'));
  assert.equal(config.github?.repository, 'jordan584/bn-funding');
  assert.equal(config.github?.branch, 'funding-images');
});

for (const mode of ['daemon', 'send'] as const) {
  test(`${mode} defaults state to the current project directory`, () => {
    const config = loadConfig(validDaemonEnv, mode);

    assert.equal(config.stateFile, path.resolve('state.json'));
  });

  test(`${mode} rejects a relative state file`, () => {
    assert.throws(
      () => loadConfig({ ...validDaemonEnv, STATE_FILE: 'custom-state.json' }, mode),
      /STATE_FILE must be an absolute path/
    );
  });

  test(`${mode} rejects a missing Google Chat Webhook`, () => {
    assert.throws(
      () => loadConfig({}, mode),
      /GOOGLE_CHAT_WEBHOOK_URL/
    );
  });

  test(`${mode} rejects missing GitHub image credentials`, () => {
    assert.throws(
      () => loadConfig({ GOOGLE_CHAT_WEBHOOK_URL: validDaemonEnv.GOOGLE_CHAT_WEBHOOK_URL }, mode),
      /GITHUB_TOKEN/
    );
  });

  test(`${mode} rejects a non-HTTPS Google Chat Webhook without leaking it`, () => {
    const webhook = 'http://chat.googleapis.com/v1/spaces/space/messages?token=secret';

    assert.throws(
      () => loadConfig({ ...validDaemonEnv, GOOGLE_CHAT_WEBHOOK_URL: webhook }, mode),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /GOOGLE_CHAT_WEBHOOK_URL/);
        assert.doesNotMatch(error.message, /secret/);
        return true;
      }
    );
  });
}

test('dry-run configuration permits no Webhook and uses its isolated state default', () => {
  const config = loadConfig({ TZ: 'Asia/Shanghai' }, 'dry-run');

  assert.equal(config.googleChatWebhookUrl, undefined);
  assert.equal(config.github, undefined);
  assert.equal(config.stateFile, path.resolve('state.json'));
});

test('log emits one JSON line and safely serializes errors', () => {
  const originalWrite = process.stdout.write;
  let output = '';
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += String(chunk);
    return true;
  }) as typeof process.stdout.write;

  try {
    log('error', 'binance.request.failed', {
      error: new Error('network failed'),
      retryable: true
    });
  } finally {
    process.stdout.write = originalWrite;
  }

  assert.equal(output.endsWith('\n'), true);
  assert.deepEqual(JSON.parse(output), {
    level: 'error',
    event: 'binance.request.failed',
    error: { name: 'Error', message: 'network failed' },
    retryable: true
  });
});

test('log redacts Google Chat Webhooks in explicit fields and nested values', () => {
  const webhook =
    'https://chat.googleapis.com/v1/spaces/space/messages?key=key-secret&token=token-secret';
  const originalWrite = process.stdout.write;
  let output = '';
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += String(chunk);
    return true;
  }) as typeof process.stdout.write;

  try {
    log('info', 'config.loaded', {
      GOOGLE_CHAT_WEBHOOK_URL: webhook,
      googleChatWebhookUrl: new URL(webhook),
      nested: {
        config: {
          destination: webhook,
          endpoint: new URL(webhook)
        }
      }
    });
  } finally {
    process.stdout.write = originalWrite;
  }

  assert.doesNotMatch(output, /chat\.googleapis\.com|key-secret|token-secret/);
  assert.deepEqual(JSON.parse(output), {
    level: 'info',
    event: 'config.loaded',
    GOOGLE_CHAT_WEBHOOK_URL: '[REDACTED]',
    googleChatWebhookUrl: '[REDACTED]',
    nested: {
      config: {
        destination: '[REDACTED]',
        endpoint: '[REDACTED]'
      }
    }
  });
});

test('log redacts Google Chat Webhooks with query or fragment after the hostname', () => {
  const originalWrite = process.stdout.write;
  let output = '';
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += String(chunk);
    return true;
  }) as typeof process.stdout.write;

  try {
    log('info', 'config.loaded', {
      nested: {
        queryOnly: 'https://chat.googleapis.com?key=query-secret',
        fragmentOnly: 'https://chat.googleapis.com#fragment-secret'
      }
    });
  } finally {
    process.stdout.write = originalWrite;
  }

  assert.doesNotMatch(output, /chat\.googleapis\.com|query-secret|fragment-secret/);
  assert.deepEqual(JSON.parse(output), {
    level: 'info',
    event: 'config.loaded',
    nested: {
      queryOnly: '[REDACTED]',
      fragmentOnly: '[REDACTED]'
    }
  });
});
