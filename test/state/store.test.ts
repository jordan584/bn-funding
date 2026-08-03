import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

test('serializes work across two independent stores that share a state path', async () => {
  await withTempDir(async (directory) => {
    const statePath = path.join(directory, 'state.json');
    const firstStore = new FileRunStateStore(statePath);
    const secondStore = new FileRunStateStore(statePath);
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const holdFirst = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let firstEntered: (() => void) | undefined;
    const firstIsHoldingLock = new Promise<void>((resolve) => { firstEntered = resolve; });

    const first = firstStore.withRunLock(async () => {
      order.push('first-enter');
      firstEntered?.();
      await holdFirst;
      order.push('first-exit');
      return 'first';
    });
    await firstIsHoldingLock;

    const second = secondStore.withRunLock(async () => {
      order.push('second-enter');
      return 'second';
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(order, ['first-enter']);

    releaseFirst?.();
    assert.deepEqual(await Promise.all([first, second]), ['first', 'second']);
    assert.deepEqual(order, ['first-enter', 'first-exit', 'second-enter']);
  });
});

test('releases the run lock when protected work throws', async () => {
  await withTempDir(async (directory) => {
    const statePath = path.join(directory, 'state.json');
    const firstStore = new FileRunStateStore(statePath);
    const secondStore = new FileRunStateStore(statePath);

    await assert.rejects(
      firstStore.withRunLock(async () => { throw new Error('job failed'); }),
      /job failed/
    );
    assert.equal(await secondStore.withRunLock(async () => 'reacquired'), 'reacquired');
  });
});

test('recovers a run lock left behind by a dead owner process', async () => {
  await withTempDir(async (directory) => {
    const statePath = path.join(directory, 'state.json');
    const helper = fileURLToPath(new URL('../helpers/lock-holder.ts', import.meta.url));
    const child = spawn(process.execPath, ['--import', 'tsx', helper, statePath], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'inherit']
    });
    child.stdout.setEncoding('utf8');
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.stdout.once('data', (chunk: string) => {
        if (chunk.includes('locked')) resolve();
        else reject(new Error(`Unexpected lock-holder output: ${chunk}`));
      });
    });

    child.kill('SIGKILL');
    await once(child, 'exit');

    const recoveredStore = new FileRunStateStore(statePath);
    assert.equal(await recoveredStore.withRunLock(async () => 'recovered'), 'recovered');
  });
});
