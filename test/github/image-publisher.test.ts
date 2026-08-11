import assert from 'node:assert/strict';
import test from 'node:test';

import { GitHubImagePublisher, GitHubImagePublishError } from '../../src/github/image-publisher.js';
import type { FundingReportImage } from '../../src/image/funding-report.js';
import type { ScheduledSlot } from '../../src/domain.js';
import { queuedFetch, type SeenRequest } from '../helpers/fetch.js';

const slot: ScheduledSlot = {
  key: '2026-08-10T16',
  scheduledAtMs: Date.UTC(2026, 7, 10, 8)
};
const images: FundingReportImage[] = [
  { range: '1-10', png: Buffer.from('first-png') },
  { range: '11-20', png: Buffer.from('second-png') }
];

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

test('publishes both immutable paths to an existing branch and returns public raw URLs', async () => {
  const requests: SeenRequest[] = [];
  const fetcher = queuedFetch([
    json({ ref: 'refs/heads/funding-images' }),
    json({ message: 'Not Found' }, 404),
    json({ content: { sha: 'one' } }, 201),
    json({ message: 'Not Found' }, 404),
    json({ content: { sha: 'two' } }, 201)
  ], requests);
  const publisher = new GitHubImagePublisher({
    token: 'github_pat_secret',
    repository: 'jordan584/bn-funding',
    branch: 'funding-images',
    fetch: fetcher
  });

  const published = await publisher.publish(images, slot);

  assert.deepEqual(published, {
    first: 'https://raw.githubusercontent.com/jordan584/bn-funding/funding-images/reports/2026/08/10/2026-08-10T16-top-1-10.png?v=53d0c513f46b',
    second: 'https://raw.githubusercontent.com/jordan584/bn-funding/funding-images/reports/2026/08/10/2026-08-10T16-top-11-20.png?v=64d0262b4609'
  });
  assert.equal(requests.length, 5);
  assert.match(requests[0]!.url.pathname, /git\/ref\/heads\/funding-images$/);
  for (const request of requests) {
    assert.equal(new Headers(request.init?.headers).get('authorization'), 'Bearer github_pat_secret');
  }
  const firstUpload = JSON.parse(String(requests[2]!.init?.body)) as Record<string, unknown>;
  assert.equal(firstUpload.branch, 'funding-images');
  assert.equal(firstUpload.content, Buffer.from('first-png').toString('base64'));
  assert.equal('sha' in firstUpload, false);
});

test('changes the public URL version when image bytes change without changing the upload path', async () => {
  const requests: SeenRequest[] = [];
  const publisher = new GitHubImagePublisher({
    token: 'github_pat_secret',
    repository: 'jordan584/bn-funding',
    branch: 'funding-images',
    fetch: queuedFetch([
      json({ ref: 'refs/heads/funding-images' }),
      json({ message: 'Not Found' }, 404),
      json({ content: { sha: 'one' } }, 201),
      json({ message: 'Not Found' }, 404),
      json({ content: { sha: 'two' } }, 201)
    ], requests)
  });

  const published = await publisher.publish([
    { range: '1-10', png: Buffer.from('changed-png') },
    images[1]!
  ], slot);

  assert.match(published.first, /\.png\?v=837fd9adeda9$/);
  assert.doesNotMatch(published.first, /53d0c513f46b/);
  assert.equal(requests[1]!.url.searchParams.has('v'), false);
  assert.equal(requests[1]!.url.pathname.endsWith('2026-08-10T16-top-1-10.png'), true);
});

test('creates a missing image branch from the default branch before uploading', async () => {
  const requests: SeenRequest[] = [];
  const publisher = new GitHubImagePublisher({
    token: 'github_pat_secret',
    repository: 'jordan584/bn-funding',
    branch: 'funding-images',
    fetch: queuedFetch([
      json({ message: 'Not Found' }, 404),
      json({ default_branch: 'main' }),
      json({ object: { sha: 'main-sha' } }),
      json({ ref: 'refs/heads/funding-images' }, 201),
      json({ message: 'Not Found' }, 404),
      json({ content: { sha: 'one' } }, 201),
      json({ message: 'Not Found' }, 404),
      json({ content: { sha: 'two' } }, 201)
    ], requests)
  });

  await publisher.publish(images, slot);

  assert.match(requests[1]!.url.pathname, /repos\/jordan584\/bn-funding$/);
  assert.match(requests[2]!.url.pathname, /git\/ref\/heads\/main$/);
  assert.deepEqual(JSON.parse(String(requests[3]!.init?.body)), {
    ref: 'refs/heads/funding-images',
    sha: 'main-sha'
  });
});

test('updates an existing slot image with its current content sha', async () => {
  const requests: SeenRequest[] = [];
  const publisher = new GitHubImagePublisher({
    token: 'github_pat_secret',
    repository: 'jordan584/bn-funding',
    branch: 'funding-images',
    fetch: queuedFetch([
      json({ ref: 'refs/heads/funding-images' }),
      json({ sha: 'old-one' }),
      json({ content: { sha: 'new-one' } }),
      json({ sha: 'old-two' }),
      json({ content: { sha: 'new-two' } })
    ], requests)
  });

  await publisher.publish(images, slot);

  assert.equal(JSON.parse(String(requests[2]!.init?.body)).sha, 'old-one');
  assert.equal(JSON.parse(String(requests[4]!.init?.body)).sha, 'old-two');
});

test('rejects malformed repositories and redacts tokens echoed by GitHub errors', async () => {
  assert.throws(
    () => new GitHubImagePublisher({ token: 'x', repository: 'invalid', branch: 'images' }),
    /owner\/repository/
  );
  const publisher = new GitHubImagePublisher({
    token: 'github_pat_top_secret',
    repository: 'jordan584/bn-funding',
    branch: 'funding-images',
    fetch: queuedFetch([json({ message: 'bad github_pat_top_secret' }, 401)], [])
  });

  await assert.rejects(
    publisher.publish(images, slot),
    (error: unknown) => {
      assert.ok(error instanceof GitHubImagePublishError);
      assert.equal(error.status, 401);
      assert.doesNotMatch(error.message, /github_pat_top_secret/);
      return true;
    }
  );
});
