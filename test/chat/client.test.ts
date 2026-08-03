import assert from 'node:assert/strict';
import test from 'node:test';

import type { GoogleChatMessage } from '../../src/domain.js';
import {
  GoogleChatClient,
  GoogleChatRequestError,
  GoogleChatTimeoutError
} from '../../src/chat/client.js';
import { queuedFetch, type SeenRequest } from '../helpers/fetch.js';

const webhookUrl = new URL('https://chat.googleapis.com/v1/spaces/space/messages?key=secret-key&token=secret-token');
const message: GoogleChatMessage = {
  text: 'fallback',
  cardsV2: [{ cardId: 'top-1-10', card: { sections: [] } }, { cardId: 'top-11-20', card: { sections: [] } }]
};

function captureStdout<T>(run: () => Promise<T>): Promise<{ result?: T; error?: unknown; output: string }> {
  let output = '';
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += String(chunk);
    return true;
  }) as typeof process.stdout.write;

  return run().then(
    (result) => ({ result, output }),
    (error: unknown) => ({ error, output })
  ).finally(() => {
    process.stdout.write = originalWrite;
  });
}

test('posts the exact message once as UTF-8 JSON with a fifteen-second abort signal', async () => {
  const seenRequests: SeenRequest[] = [];
  const client = new GoogleChatClient({
    webhookUrl,
    fetch: queuedFetch([new Response('', { status: 200 })], seenRequests)
  });

  await client.send(message);

  assert.equal(seenRequests.length, 1);
  const request = seenRequests[0]!;
  assert.equal(request.url.origin, 'https://chat.googleapis.com');
  assert.equal(request.init?.method, 'POST');
  assert.equal(new Headers(request.init?.headers).get('content-type'), 'application/json; charset=utf-8');
  assert.equal(request.init?.body, JSON.stringify(message));
  assert.ok(request.init?.signal instanceof AbortSignal);
  assert.equal((request.init?.signal as AbortSignal).aborted, false);
});

for (const status of [400, 429, 500]) {
  test(`throws a non-retryable typed error once for HTTP ${status} without leaking the webhook URL`, async () => {
    const seenRequests: SeenRequest[] = [];
    const client = new GoogleChatClient({
      webhookUrl,
      fetch: queuedFetch([new Response('x'.repeat(600), { status })], seenRequests)
    });
    const captured = await captureStdout(async () => {
      await client.send(message);
    });

    assert.equal(seenRequests.length, 1);
    assert.ok(captured.error instanceof GoogleChatRequestError);
    assert.equal(captured.error.status, status);
    assert.equal(captured.error.retryable, false);
    assert.match(captured.error.message, new RegExp(`returned ${status}`));
    assert.match(captured.error.message, new RegExp(`x{500}`));
    assert.doesNotMatch(captured.error.message, new RegExp(`x{501}`));
    assert.doesNotMatch(captured.error.message, /key=|token=|chat\.googleapis\.com/);
    assert.doesNotMatch(captured.output, /key=|token=/);
  });
}

test('classifies a TimeoutError as an ambiguous non-retryable timeout without leaking the webhook URL', async () => {
  const seenRequests: SeenRequest[] = [];
  const client = new GoogleChatClient({
    webhookUrl,
    timeoutMs: 1,
    fetch: queuedFetch([new DOMException('operation timed out', 'TimeoutError')], seenRequests)
  });
  const captured = await captureStdout(async () => {
    await client.send(message);
  });

  assert.equal(seenRequests.length, 1);
  assert.ok(captured.error instanceof GoogleChatTimeoutError);
  assert.equal(captured.error.retryable, false);
  assert.equal(captured.error.ambiguous, true);
  assert.doesNotMatch(captured.error.message, /key=|token=|chat\.googleapis\.com/);
  assert.doesNotMatch(captured.output, /key=|token=/);
});
