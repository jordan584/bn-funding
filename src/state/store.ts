import { randomUUID } from 'node:crypto';
import {
  mkdir as nativeMkdir,
  readFile as nativeReadFile,
  rm as nativeRm,
  rename as nativeRename,
  stat as nativeStat,
  unlink as nativeUnlink,
  writeFile as nativeWriteFile
} from 'node:fs/promises';
import type { MakeDirectoryOptions, WriteFileOptions } from 'node:fs';
import path from 'node:path';

import type { ScheduledSlot } from '../domain.js';

interface RunStateFile {
  lastSuccessfulSlot: string;
  scheduledAt: string;
  updatedAt: string;
}

interface RunLockOwner {
  pid: number;
  token: string;
  acquiredAtMs: number;
}

const LOCK_RETRY_DELAY_MS = 50;
const LOCK_ACQUIRE_TIMEOUT_MS = 15 * 60_000;
const INCOMPLETE_LOCK_STALE_MS = 30_000;

export interface StateFsAdapter {
  mkdir(target: string, options: MakeDirectoryOptions & { recursive: true }): Promise<string | undefined>;
  readFile(target: string, encoding: BufferEncoding): Promise<string>;
  writeFile(target: string, contents: string, options: WriteFileOptions): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(target: string): Promise<void>;
}

const stateFs: StateFsAdapter = {
  mkdir: nativeMkdir,
  readFile: nativeReadFile,
  writeFile: nativeWriteFile,
  rename: nativeRename,
  unlink: nativeUnlink
};

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function isRunLockOwner(value: unknown): value is RunLockOwner {
  return typeof value === 'object'
    && value !== null
    && Number.isInteger((value as Partial<RunLockOwner>).pid)
    && ((value as Partial<RunLockOwner>).pid ?? 0) > 0
    && typeof (value as Partial<RunLockOwner>).token === 'string'
    && typeof (value as Partial<RunLockOwner>).acquiredAtMs === 'number';
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !hasErrorCode(error, 'ESRCH');
  }
}

function parseState(contents: string): RunStateFile {
  const parsed: unknown = JSON.parse(contents);
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as Partial<RunStateFile>).lastSuccessfulSlot !== 'string' ||
    typeof (parsed as Partial<RunStateFile>).scheduledAt !== 'string' ||
    typeof (parsed as Partial<RunStateFile>).updatedAt !== 'string'
  ) {
    throw new Error('Invalid run state file');
  }
  return parsed as RunStateFile;
}

export class FileRunStateStore {
  constructor(
    private readonly stateFile: string,
    private readonly fsAdapter: StateFsAdapter = stateFs
  ) {}

  async withRunLock<T>(work: () => Promise<T>): Promise<T> {
    const release = await this.acquireRunLock();
    try {
      return await work();
    } finally {
      await release();
    }
  }

  async getLastSuccessfulSlot(): Promise<string | null> {
    let contents: string;
    try {
      contents = await this.fsAdapter.readFile(this.stateFile, 'utf8');
    } catch (error) {
      if (isMissingFile(error)) {
        return null;
      }
      throw error;
    }
    return parseState(contents).lastSuccessfulSlot;
  }

  async markSuccessful(slot: ScheduledSlot, updatedAtMs: number): Promise<void> {
    const directory = path.dirname(this.stateFile);
    const temporaryFile = `${this.stateFile}.${process.pid}.${randomUUID()}.tmp`;
    const contents = JSON.stringify({
      lastSuccessfulSlot: slot.key,
      scheduledAt: new Date(slot.scheduledAtMs).toISOString(),
      updatedAt: new Date(updatedAtMs).toISOString()
    });

    try {
      await this.fsAdapter.mkdir(directory, { recursive: true });
      await this.fsAdapter.writeFile(temporaryFile, contents, { encoding: 'utf8', mode: 0o600 });
      await this.fsAdapter.rename(temporaryFile, this.stateFile);
    } catch (error) {
      try {
        await this.fsAdapter.unlink(temporaryFile);
      } catch (cleanupError) {
        if (!isMissingFile(cleanupError)) {
          throw cleanupError;
        }
      }
      throw error;
    }
  }

  private async acquireRunLock(): Promise<() => Promise<void>> {
    const directory = path.dirname(this.stateFile);
    const lockDirectory = `${this.stateFile}.lock`;
    const recoveryDirectory = `${lockDirectory}.recovery`;
    const ownerFile = path.join(lockDirectory, 'owner.json');
    const startedAtMs = Date.now();
    const owner: RunLockOwner = {
      pid: process.pid,
      token: randomUUID(),
      acquiredAtMs: startedAtMs
    };

    await nativeMkdir(directory, { recursive: true });
    while (true) {
      if (!(await this.pathExists(recoveryDirectory))) {
        try {
          await nativeMkdir(lockDirectory, { mode: 0o700 });
          try {
            await nativeWriteFile(ownerFile, JSON.stringify(owner), {
              encoding: 'utf8',
              mode: 0o600,
              flag: 'wx'
            });
          } catch (error) {
            await nativeRm(lockDirectory, { recursive: true, force: true });
            throw error;
          }
          return async () => {
            const currentOwner = await this.readRunLockOwner(ownerFile);
            if (currentOwner?.token !== owner.token) {
              throw new Error('Run state lock ownership was lost');
            }
            await nativeRm(lockDirectory, { recursive: true, force: false });
          };
        } catch (error) {
          if (!hasErrorCode(error, 'EEXIST')) {
            throw error;
          }
        }
      }

      if (await this.recoverDeadRunLock(lockDirectory, recoveryDirectory, ownerFile)) {
        continue;
      }
      if (Date.now() - startedAtMs >= LOCK_ACQUIRE_TIMEOUT_MS) {
        throw new Error('Timed out waiting for the run state lock');
      }
      await new Promise<void>((resolve) => setTimeout(resolve, LOCK_RETRY_DELAY_MS));
    }
  }

  private async recoverDeadRunLock(
    lockDirectory: string,
    recoveryDirectory: string,
    ownerFile: string
  ): Promise<boolean> {
    const owner = await this.readRunLockOwner(ownerFile);
    if (owner !== null && isProcessAlive(owner.pid)) {
      return false;
    }
    if (owner === null) {
      try {
        const lockStat = await nativeStat(lockDirectory);
        if (Date.now() - lockStat.mtimeMs < INCOMPLETE_LOCK_STALE_MS) {
          return false;
        }
      } catch (error) {
        if (isMissingFile(error)) return true;
        throw error;
      }
    }

    try {
      await nativeMkdir(recoveryDirectory, { mode: 0o700 });
    } catch (error) {
      if (hasErrorCode(error, 'EEXIST')) return false;
      throw error;
    }

    try {
      const currentOwner = await this.readRunLockOwner(ownerFile);
      if (currentOwner !== null && isProcessAlive(currentOwner.pid)) {
        return false;
      }
      if (currentOwner === null) {
        try {
          const lockStat = await nativeStat(lockDirectory);
          if (Date.now() - lockStat.mtimeMs < INCOMPLETE_LOCK_STALE_MS) {
            return false;
          }
        } catch (error) {
          if (isMissingFile(error)) return true;
          throw error;
        }
      }
      await nativeRm(lockDirectory, { recursive: true, force: true });
      return true;
    } finally {
      await nativeRm(recoveryDirectory, { recursive: true, force: true });
    }
  }

  private async readRunLockOwner(ownerFile: string): Promise<RunLockOwner | null> {
    try {
      const parsed: unknown = JSON.parse(await nativeReadFile(ownerFile, 'utf8'));
      return isRunLockOwner(parsed) ? parsed : null;
    } catch (error) {
      if (isMissingFile(error) || error instanceof SyntaxError) {
        return null;
      }
      throw error;
    }
  }

  private async pathExists(target: string): Promise<boolean> {
    try {
      await nativeStat(target);
      return true;
    } catch (error) {
      if (isMissingFile(error)) return false;
      throw error;
    }
  }
}
