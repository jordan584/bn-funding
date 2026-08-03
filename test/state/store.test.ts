import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { StateFsAdapter } from '../../src/state/store.js';
import { FileRunStateStore } from '../../src/state/store.js';

const scheduledAtMs = Date.parse('2026-08-03T00:05:00.000Z');
const updatedAtMs = Date.parse('2026-08-03T00:06:00.000Z');

async function withTempDir(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), 'bn-funding-state-'));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('returns null when the state file has not been created', async () => {
  await withTempDir(async (directory) => {
    const store = new FileRunStateStore(path.join(directory, 'state.json'));

    assert.equal(await store.getLastSuccessfulSlot(), null);
  });
});

test('returns the recorded successful slot from valid state JSON', async () => {
  await withTempDir(async (directory) => {
    const statePath = path.join(directory, 'state.json');
    await writeFile(
      statePath,
      JSON.stringify({
        lastSuccessfulSlot: '2026-08-03T00',
        scheduledAt: '2026-08-03T00:05:00.000Z',
        updatedAt: '2026-08-03T00:06:00.000Z'
      })
    );

    const store = new FileRunStateStore(statePath);
    assert.equal(await store.getLastSuccessfulSlot(), '2026-08-03T00');
  });
});

test('throws when the persisted state is malformed instead of treating it as missing', async () => {
  await withTempDir(async (directory) => {
    const statePath = path.join(directory, 'state.json');
    await writeFile(statePath, '{ definitely not JSON');

    const store = new FileRunStateStore(statePath);
    await assert.rejects(store.getLastSuccessfulSlot(), SyntaxError);
  });
});

test('writes a private state file containing slot and ISO timestamps', async () => {
  await withTempDir(async (directory) => {
    const statePath = path.join(directory, 'nested', 'state.json');
    const store = new FileRunStateStore(statePath);

    await store.markSuccessful({ key: '2026-08-03T08', scheduledAtMs }, updatedAtMs);

    assert.equal(await store.getLastSuccessfulSlot(), '2026-08-03T08');
    assert.equal((await stat(statePath)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(statePath, 'utf8')), {
      lastSuccessfulSlot: '2026-08-03T08',
      scheduledAt: '2026-08-03T00:05:00.000Z',
      updatedAt: '2026-08-03T00:06:00.000Z'
    });
  });
});

test('keeps the previous state visible until the completed temporary file is renamed', async () => {
  await withTempDir(async (directory) => {
    const statePath = path.join(directory, 'state.json');
    await writeFile(
      statePath,
      JSON.stringify({
        lastSuccessfulSlot: '2026-08-03T00',
        scheduledAt: '2026-08-03T00:05:00.000Z',
        updatedAt: '2026-08-03T00:06:00.000Z'
      })
    );

    let releaseTemporaryWrite: (() => void) | undefined;
    const temporaryWriteComplete = new Promise<void>((resolve) => {
      releaseTemporaryWrite = resolve;
    });
    let pauseAfterTemporaryWrite: (() => void) | undefined;
    const resumeRename = new Promise<void>((resolve) => {
      pauseAfterTemporaryWrite = resolve;
    });

    const fsAdapter: StateFsAdapter = {
      mkdir: async (target, options) => {
        await mkdir(target, options);
      },
      readFile,
      writeFile: async (target, contents, options) => {
        await writeFile(target, contents, options);
        if (target !== statePath) {
          releaseTemporaryWrite?.();
          await resumeRename;
        }
      },
      rename,
      unlink
    };
    const store = new FileRunStateStore(statePath, fsAdapter);
    const pendingWrite = store.markSuccessful(
      { key: '2026-08-03T08', scheduledAtMs },
      updatedAtMs
    );

    await temporaryWriteComplete;
    assert.equal(await store.getLastSuccessfulSlot(), '2026-08-03T00');

    pauseAfterTemporaryWrite?.();
    await pendingWrite;
    assert.equal(await store.getLastSuccessfulSlot(), '2026-08-03T08');
  });
});

test('removes only its temporary state file when writing the replacement fails', async () => {
  await withTempDir(async (directory) => {
    const statePath = path.join(directory, 'nested', 'state.json');
    let temporaryFile = '';
    const fsAdapter: StateFsAdapter = {
      mkdir,
      readFile,
      writeFile: async (target, contents, options) => {
        temporaryFile = target;
        await writeFile(target, contents, options);
        throw new Error('simulated disk failure');
      },
      rename,
      unlink
    };
    const store = new FileRunStateStore(statePath, fsAdapter);

    await assert.rejects(
      store.markSuccessful({ key: '2026-08-03T08', scheduledAtMs }, updatedAtMs),
      /simulated disk failure/
    );

    assert.equal((await readdir(path.dirname(statePath))).length, 0);
    assert.notEqual(temporaryFile, '');
  });
});
