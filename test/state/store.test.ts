import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import type { RunLockOptions, StateFsAdapter } from '../../src/state/store.js';
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

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

async function within(promise: Promise<unknown>, message: string): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  const outcome = await Promise.race([
    promise.then(() => 'completed' as const),
    new Promise<'timeout'>((resolve) => {
      timeout = setTimeout(() => resolve('timeout'), 1_000);
    })
  ]);
  if (timeout !== undefined) clearTimeout(timeout);
  assert.equal(outcome, 'completed', message);
}

function spawnHelper(name: string, args: string[]): ChildProcess {
  const helper = fileURLToPath(new URL(`../helpers/${name}`, import.meta.url));
  return spawn(process.execPath, ['--import', 'tsx', helper, ...args], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'inherit']
  });
}

async function waitForOutput(child: ChildProcess, expected: string): Promise<void> {
  const stdout = child.stdout;
  assert.ok(stdout !== null);
  stdout.setEncoding('utf8');
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    stdout.once('data', (chunk: string) => {
      if (chunk.includes(expected)) resolve();
      else reject(new Error(`Unexpected helper output: ${chunk}`));
    });
  });
}

async function killAfterOutput(child: ChildProcess, expected: string): Promise<void> {
  await waitForOutput(child, expected);
  child.kill('SIGKILL');
  await once(child, 'exit');
}

async function leaveDeadMainLock(statePath: string): Promise<void> {
  await killAfterOutput(spawnHelper('lock-holder.ts', [statePath]), 'locked');
}

async function runProbe(statePath: string, timeoutArgument?: number): Promise<string> {
  const child = spawnHelper('lock-probe.ts', [
    statePath,
    ...(timeoutArgument === undefined ? [] : [String(timeoutArgument)])
  ]);
  const stdout = child.stdout;
  assert.ok(stdout !== null);
  stdout.setEncoding('utf8');
  let output = '';
  stdout.on('data', (chunk: string) => { output += chunk; });
  let timeout: NodeJS.Timeout | undefined;
  const outcome = await Promise.race([
    once(child, 'exit').then(([code]) => ({ type: 'exit' as const, code })),
    new Promise<{ type: 'timeout'; code: null }>((resolve) => {
      timeout = setTimeout(() => resolve({ type: 'timeout', code: null }), 1_000);
    })
  ]);
  if (timeout !== undefined) clearTimeout(timeout);
  if (outcome.type === 'timeout') {
    child.kill('SIGKILL');
    await once(child, 'exit');
    assert.fail('lock probe did not finish within one second');
  }
  assert.equal(outcome.code, 0);
  return output;
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
      readdir,
      rename,
      stat,
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
      readdir,
      rename,
      stat,
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

for (const mainLockAction of ['remove', 'keep'] as const) {
  test(`recovers when a recovery owner dies after the main lock is ${mainLockAction === 'remove' ? 'removed' : 'left in place'}`, async () => {
    await withTempDir(async (directory) => {
      const statePath = path.join(directory, 'state.json');
      await leaveDeadMainLock(statePath);
      await killAfterOutput(
        spawnHelper('recovery-gate-holder.ts', [statePath, mainLockAction]),
        'recovery-gate-ready'
      );

      assert.match(await runProbe(statePath), /entered/);
    });
  });
}

test('checks the acquisition deadline even while a live recovery gate blocks progress', async () => {
  await withTempDir(async (directory) => {
    const statePath = path.join(directory, 'state.json');
    const recoveryHolder = spawnHelper('recovery-gate-holder.ts', [statePath, 'keep']);
    await waitForOutput(recoveryHolder, 'recovery-gate-ready');
    try {
      assert.match(await runProbe(statePath, 25), /timed-out/);
    } finally {
      recoveryHolder.kill('SIGKILL');
      await once(recoveryHolder, 'exit');
    }
  });
});

test('a delayed second cleaner cannot delete the live ticket that replaced an abandoned ticket', async () => {
  await withTempDir(async (directory) => {
    const statePath = path.join(directory, 'state.json');
    const lockDirectory = `${statePath}.lock`;
    const abandonedTicket = path.join(
      lockDirectory,
      '00000000000000000000-abandoned.ticket'
    );
    await mkdir(lockDirectory, { recursive: true });
    await writeFile(abandonedTicket, JSON.stringify({
      pid: 2_147_483_647,
      token: 'abandoned',
      acquiredAtMs: 1
    }), { mode: 0o600 });

    const selectionReadyA = deferred();
    const selectionReadyB = deferred();
    const releaseSelection = deferred();
    const cleanupReadyA = deferred();
    const cleanupReadyB = deferred();
    const releaseCleanupA = deferred();
    const releaseCleanupB = deferred();
    const cleanupFinishedB = deferred();
    const enteredA = deferred();
    const enteredB = deferred();
    const releaseWorkA = deferred();
    const releaseWorkB = deferred();
    let activeCriticalSections = 0;
    let maximumCriticalSections = 0;

    const barrierFs = (
      label: 'a' | 'b',
      selectionReady: ReturnType<typeof deferred>,
      cleanupReady: ReturnType<typeof deferred>,
      releaseCleanup: ReturnType<typeof deferred>
    ): StateFsAdapter => {
      let capturedSelection = false;
      return {
        mkdir,
        readFile,
        writeFile,
        rename,
        readdir: async (target) => {
          if (target === lockDirectory && !capturedSelection) {
            capturedSelection = true;
            const snapshot = await readdir(target);
            selectionReady.resolve();
            await releaseSelection.promise;
            return snapshot;
          }
          return readdir(target);
        },
        stat,
        unlink: async (target) => {
          if (target === abandonedTicket) {
            cleanupReady.resolve();
            await releaseCleanup.promise;
          }
          try {
            await unlink(target);
          } finally {
            if (label === 'b' && target === abandonedTicket) {
              cleanupFinishedB.resolve();
            }
          }
        }
      };
    };

    const lockOptions = (token: 'a' | 'b') => ({
      tokenFactory: () => token,
      lockRetryDelayMs: 1,
      lockAcquireTimeoutMs: 2_000
    } as RunLockOptions);
    const storeA = new FileRunStateStore(
      statePath,
      barrierFs('a', selectionReadyA, cleanupReadyA, releaseCleanupA),
      lockOptions('a')
    );
    const storeB = new FileRunStateStore(
      statePath,
      barrierFs('b', selectionReadyB, cleanupReadyB, releaseCleanupB),
      lockOptions('b')
    );
    const runCriticalSection = async (
      entered: ReturnType<typeof deferred>,
      release: ReturnType<typeof deferred>
    ): Promise<void> => {
      activeCriticalSections += 1;
      maximumCriticalSections = Math.max(maximumCriticalSections, activeCriticalSections);
      entered.resolve();
      try {
        await release.promise;
      } finally {
        activeCriticalSections -= 1;
      }
    };

    const jobA = storeA.withRunLock(() => runCriticalSection(enteredA, releaseWorkA));
    const jobB = storeB.withRunLock(() => runCriticalSection(enteredB, releaseWorkB));
    try {
      await within(
        Promise.all([selectionReadyA.promise, selectionReadyB.promise]),
        'both contenders must snapshot the abandoned ticket before election'
      );
      releaseSelection.resolve();
      await within(
        Promise.all([cleanupReadyA.promise, cleanupReadyB.promise]),
        'both contenders must begin cleanup from the old snapshot'
      );

      releaseCleanupA.resolve();
      await within(enteredA.promise, 'the first elected contender must enter');
      assert.equal(activeCriticalSections, 1);

      releaseCleanupB.resolve();
      await within(cleanupFinishedB.promise, 'the delayed cleaner must finish');
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(activeCriticalSections, 1);
      assert.equal(maximumCriticalSections, 1);
      assert.equal(
        (await readdir(lockDirectory)).some((entry) => entry.endsWith('-a.ticket')),
        true,
        'the delayed cleanup must not delete the live owner ticket'
      );

      releaseWorkA.resolve();
      await within(enteredB.promise, 'the second contender must enter only after the first exits');
      assert.equal(activeCriticalSections, 1);
      releaseWorkB.resolve();
      await Promise.all([jobA, jobB]);
      assert.equal(maximumCriticalSections, 1);
    } finally {
      releaseSelection.resolve();
      releaseCleanupA.resolve();
      releaseCleanupB.resolve();
      releaseWorkA.resolve();
      releaseWorkB.resolve();
      await Promise.allSettled([jobA, jobB]);
    }
  });
});

test('rescans after a choosing file becomes a ticket instead of entering from the old snapshot', async () => {
  await withTempDir(async (directory) => {
    const statePath = path.join(directory, 'state.json');
    const lockDirectory = `${statePath}.lock`;
    const choosingA = path.join(lockDirectory, 'a.choosing');
    const selectionReadyA = deferred();
    const releaseRenameA = deferred();
    const renamedA = deferred();
    const scanCapturedB = deferred();
    const releaseScanB = deferred();
    const missingChoosingObservedB = deferred();
    const enteredA = deferred();
    const enteredB = deferred();
    const releaseWorkA = deferred();
    const releaseWorkB = deferred();
    let activeCriticalSections = 0;
    let maximumCriticalSections = 0;

    let readsA = 0;
    const fsA: StateFsAdapter = {
      mkdir,
      readFile,
      writeFile,
      readdir: async (target) => {
        const entries = await readdir(target);
        if (target === lockDirectory && readsA++ === 0) selectionReadyA.resolve();
        return entries;
      },
      rename: async (from, to) => {
        if (from === choosingA) await releaseRenameA.promise;
        await rename(from, to);
        if (from === choosingA) renamedA.resolve();
      },
      stat,
      unlink
    };
    let readsB = 0;
    const fsB: StateFsAdapter = {
      mkdir,
      readFile: async (target, encoding) => {
        try {
          return await readFile(target, encoding);
        } catch (error) {
          if (target === choosingA) missingChoosingObservedB.resolve();
          throw error;
        }
      },
      writeFile,
      readdir: async (target) => {
        const entries = await readdir(target);
        if (target === lockDirectory && readsB++ === 1) {
          scanCapturedB.resolve();
          await releaseScanB.promise;
        }
        return entries;
      },
      rename,
      stat,
      unlink
    };
    const options = (token: 'a' | 'b'): RunLockOptions => ({
      tokenFactory: () => token,
      lockRetryDelayMs: 1,
      lockAcquireTimeoutMs: 2_000
    });
    const runCriticalSection = async (
      entered: ReturnType<typeof deferred>,
      release: ReturnType<typeof deferred>
    ): Promise<void> => {
      activeCriticalSections += 1;
      maximumCriticalSections = Math.max(maximumCriticalSections, activeCriticalSections);
      entered.resolve();
      try {
        await release.promise;
      } finally {
        activeCriticalSections -= 1;
      }
    };

    const jobA = new FileRunStateStore(statePath, fsA, options('a'))
      .withRunLock(() => runCriticalSection(enteredA, releaseWorkA));
    await within(selectionReadyA.promise, 'the first contender must choose before B starts');
    const jobB = new FileRunStateStore(statePath, fsB, options('b'))
      .withRunLock(() => runCriticalSection(enteredB, releaseWorkB));
    try {
      await within(
        scanCapturedB.promise,
        'B must capture a scan containing the old choosing path'
      );
      releaseRenameA.resolve();
      await within(renamedA.promise, 'A must publish its ticket after B captures the scan');
      releaseScanB.resolve();
      await within(
        missingChoosingObservedB.promise,
        'B must observe that the choosing path moved after its snapshot'
      );
      await within(enteredA.promise, 'the lower-token ticket must enter first');
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(activeCriticalSections, 1);
      assert.equal(maximumCriticalSections, 1);

      releaseWorkA.resolve();
      await within(enteredB.promise, 'B must enter only after rescanning and seeing A exit');
      releaseWorkB.resolve();
      await Promise.all([jobA, jobB]);
      assert.equal(maximumCriticalSections, 1);
    } finally {
      releaseRenameA.resolve();
      releaseScanB.resolve();
      releaseWorkA.resolve();
      releaseWorkB.resolve();
      await Promise.allSettled([jobA, jobB]);
    }
  });
});

test('does not unlink a contender path when unique ticket creation loses a token collision', async () => {
  await withTempDir(async (directory) => {
    const statePath = path.join(directory, 'state.json');
    const lockDirectory = `${statePath}.lock`;
    const choosingFile = path.join(lockDirectory, 'collision.choosing');
    const existingOwner = JSON.stringify({
      pid: process.pid,
      token: 'collision',
      acquiredAtMs: Date.now()
    });
    await mkdir(lockDirectory, { recursive: true });
    await writeFile(choosingFile, existingOwner, { mode: 0o600, flag: 'wx' });

    const store = new FileRunStateStore(statePath, undefined, {
      tokenFactory: () => 'collision'
    });
    await assert.rejects(
      store.withRunLock(async () => undefined),
      (error: unknown) => typeof error === 'object'
        && error !== null
        && 'code' in error
        && error.code === 'EEXIST'
    );
    assert.equal(await readFile(choosingFile, 'utf8'), existingOwner);
  });
});
