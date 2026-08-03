import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { loadConfig } from '../src/config.js';
import { log } from '../src/logger.js';

const validDaemonEnv = {
  GOOGLE_CHAT_WEBHOOK_URL:
    'https://chat.googleapis.com/v1/spaces/space/messages?key=k&token=t',
  STATE_FILE: '/var/lib/bn-funding/state.json',
  TZ: 'Asia/Shanghai'
};

test('daemon configuration is production-safe', () => {
  const config = loadConfig(validDaemonEnv, 'daemon');

  assert.equal(config.schedule, '5 0,8,16 * * *');
  assert.equal(config.timezone, 'Asia/Shanghai');
  assert.equal(config.binanceTimeoutMs, 10_000);
  assert.equal(config.chatTimeoutMs, 15_000);
  assert.equal(config.catchUpWindowMs, 30 * 60_000);
  assert.equal(config.binanceBaseUrl.href, 'https://fapi.binance.com/');
});

for (const mode of ['daemon', 'send'] as const) {
  test(`${mode} rejects a missing Google Chat Webhook`, () => {
    assert.throws(
      () => loadConfig({ STATE_FILE: '/var/lib/bn-funding/state.json' }, mode),
      /GOOGLE_CHAT_WEBHOOK_URL/
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
  assert.equal(config.stateFile, path.resolve('data/state.json'));
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
