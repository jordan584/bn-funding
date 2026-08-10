import assert from 'node:assert/strict';
import test from 'node:test';

import { buildFundingImageChatMessage } from '../../src/chat/image-message.js';

test('builds one compact Chat message with two ordered public image widgets', () => {
  const message = buildFundingImageChatMessage(1_786_349_100_000, {
    first: 'https://raw.githubusercontent.com/jordan/repo/images/top-1-10.png',
    second: 'https://raw.githubusercontent.com/jordan/repo/images/top-11-20.png'
  });

  assert.match(message.text, /五交易所 Funding Top20/);
  assert.deepEqual(message.cardsV2.map(({ cardId }) => cardId), [
    'funding-image-1-10',
    'funding-image-11-20'
  ]);
  const serialized = JSON.stringify(message.cardsV2);
  assert.match(serialized, /top-1-10\.png/);
  assert.match(serialized, /top-11-20\.png/);
  assert.equal((serialized.match(/imageUrl/g) ?? []).length, 2);
  assert.equal((serialized.match(/"openLink"/g) ?? []).length, 4);
  assert.equal((serialized.match(/查看高清原图/g) ?? []).length, 2);
  assert.equal((serialized.match(/top-1-10\.png/g) ?? []).length, 3);
  assert.equal((serialized.match(/top-11-20\.png/g) ?? []).length, 3);
});
