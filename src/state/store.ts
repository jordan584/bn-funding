import { randomUUID } from 'node:crypto';
import {
  mkdir as nativeMkdir,
  readFile as nativeReadFile,
  readdir as nativeReaddir,
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
const LOCK_TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/;
const CHOOSING_FILE_PATTERN = /^([A-Za-z0-9_-]+)\.choosing$/;
const TICKET_FILE_PATTERN = /^(\d+)-([A-Za-z0-9_-]+)\.ticket$/;
const TICKET_SEQUENCE_WIDTH = 20;

interface RunLockTicket {
  file: string;
  sequence: bigint;
  token: string;
}

export interface RunLockOptions {
  lockRetryDelayMs?: number;
  lockAcquireTimeoutMs?: number;
  incompleteLockStaleMs?: number;
  tokenFactory?: () => string;
}

export interface StateFsAdapter {
  mkdir(target: string, options: MakeDirectoryOptions & { recursive: true }): Promise<string | undefined>;
  readFile(target: string, encoding: BufferEncoding): Promise<string>;
  writeFile(target: string, contents: string, options: WriteFileOptions): Promise<void>;
  readdir(target: string): Promise<string[]>;
  rename(from: string, to: string): Promise<void>;
  stat(target: string): Promise<{ mtimeMs: number }>;
  unlink(target: string): Promise<void>;
}

const stateFs: StateFsAdapter = {
  mkdir: nativeMkdir,
  readFile: nativeReadFile,
  writeFile: nativeWriteFile,
  readdir: nativeReaddir,
  rename: nativeRename,
  stat: nativeStat,
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
    private readonly fsAdapter: StateFsAdapter = stateFs,
    private readonly lockOptions: RunLockOptions = {}
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
    const startedAtMs = Date.now();
    const token = (this.lockOptions.tokenFactory ?? randomUUID)();
    if (!LOCK_TOKEN_PATTERN.test(token)) {
      throw new Error('Run state lock token contains unsafe characters');
    }
    const owner: RunLockOwner = {
      pid: process.pid,
      token,
      acquiredAtMs: startedAtMs
    };
    const choosingFile = path.join(lockDirectory, `${token}.choosing`);
    let contenderFile = choosingFile;
    let ownsContenderFile = false;

    try {
      await this.fsAdapter.mkdir(directory, { recursive: true });
      await this.fsAdapter.mkdir(lockDirectory, { recursive: true, mode: 0o700 });
      this.assertRunLockDeadline(startedAtMs);
      await this.fsAdapter.writeFile(choosingFile, JSON.stringify(owner), {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx'
      });
      ownsContenderFile = true;
      const sequence = await this.nextTicketSequence(lockDirectory);
      const ticketFile = path.join(
        lockDirectory,
        `${sequence.toString().padStart(TICKET_SEQUENCE_WIDTH, '0')}-${token}.ticket`
      );
      await this.fsAdapter.rename(choosingFile, ticketFile);
      contenderFile = ticketFile;

      while (true) {
        this.assertRunLockDeadline(startedAtMs);
        const contenders = await this.collectLiveContenders(lockDirectory);
        const ownTicket = contenders.tickets.find((ticket) => ticket.file === ticketFile);
        if (ownTicket === undefined) {
          throw new Error('Run state lock ownership was lost');
        }
        if (!contenders.hasChoosing && contenders.tickets[0]?.file === ticketFile) {
          return async () => {
            const currentOwner = await this.readRunLockOwner(ticketFile);
            if (currentOwner?.token !== owner.token) {
              throw new Error('Run state lock ownership was lost');
            }
            await this.unlinkUniqueContender(ticketFile);
          };
        }
        await this.waitBeforeLockRetry();
      }
    } catch (error) {
      if (ownsContenderFile) await this.unlinkUniqueContender(contenderFile);
      throw error;
    }
  }

  private async nextTicketSequence(lockDirectory: string): Promise<bigint> {
    const entries = await this.fsAdapter.readdir(lockDirectory);
    let maximum = -1n;
    for (const entry of entries) {
      const ticket = this.parseTicket(entry, lockDirectory);
      if (ticket !== null && ticket.sequence > maximum) {
        maximum = ticket.sequence;
      }
    }
    return maximum + 1n;
  }

  private async collectLiveContenders(
    lockDirectory: string
  ): Promise<{ hasChoosing: boolean; tickets: RunLockTicket[] }> {
    const entries = await this.fsAdapter.readdir(lockDirectory);
    const tickets: RunLockTicket[] = [];
    let hasChoosing = false;

    for (const entry of entries) {
      const choosingMatch = CHOOSING_FILE_PATTERN.exec(entry);
      if (choosingMatch !== null) {
        const token = choosingMatch[1];
        hasChoosing = true;
        if (token !== undefined) {
          await this.isLiveContender(path.join(lockDirectory, entry), token);
        }
        continue;
      }

      const ticket = this.parseTicket(entry, lockDirectory);
      if (ticket !== null && await this.isLiveContender(ticket.file, ticket.token)) {
        tickets.push(ticket);
      }
    }

    tickets.sort((left, right) => {
      if (left.sequence < right.sequence) return -1;
      if (left.sequence > right.sequence) return 1;
      if (left.token < right.token) return -1;
      if (left.token > right.token) return 1;
      return 0;
    });
    return { hasChoosing, tickets };
  }

  private parseTicket(entry: string, lockDirectory: string): RunLockTicket | null {
    const match = TICKET_FILE_PATTERN.exec(entry);
    const sequence = match?.[1];
    const token = match?.[2];
    if (sequence === undefined || token === undefined) return null;
    return { file: path.join(lockDirectory, entry), sequence: BigInt(sequence), token };
  }

  private async isLiveContender(contenderFile: string, expectedToken: string): Promise<boolean> {
    const owner = await this.readRunLockOwner(contenderFile);
    if (owner !== null) {
      if (owner.token === expectedToken && isProcessAlive(owner.pid)) {
        return true;
      }
      await this.unlinkUniqueContender(contenderFile);
      return false;
    }

    try {
      const contenderStat = await this.fsAdapter.stat(contenderFile);
      if (Date.now() - contenderStat.mtimeMs < this.incompleteLockStaleMs()) {
        return true;
      }
    } catch (error) {
      if (isMissingFile(error)) return false;
      throw error;
    }
    await this.unlinkUniqueContender(contenderFile);
    return false;
  }

  private async unlinkUniqueContender(contenderFile: string): Promise<void> {
    try {
      await this.fsAdapter.unlink(contenderFile);
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
  }

  private assertRunLockDeadline(startedAtMs: number): void {
    if (Date.now() - startedAtMs >= (this.lockOptions.lockAcquireTimeoutMs ?? LOCK_ACQUIRE_TIMEOUT_MS)) {
      throw new Error('Timed out waiting for the run state lock');
    }
  }

  private incompleteLockStaleMs(): number {
    return this.lockOptions.incompleteLockStaleMs ?? INCOMPLETE_LOCK_STALE_MS;
  }

  private async waitBeforeLockRetry(): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(
      resolve,
      this.lockOptions.lockRetryDelayMs ?? LOCK_RETRY_DELAY_MS
    ));
  }

  private async readRunLockOwner(ownerFile: string): Promise<RunLockOwner | null> {
    try {
      const parsed: unknown = JSON.parse(await this.fsAdapter.readFile(ownerFile, 'utf8'));
      return isRunLockOwner(parsed) ? parsed : null;
    } catch (error) {
      if (isMissingFile(error) || error instanceof SyntaxError) {
        return null;
      }
      throw error;
    }
  }

}
