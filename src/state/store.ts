import { randomUUID } from 'node:crypto';
import {
  mkdir as nativeMkdir,
  readFile as nativeReadFile,
  rename as nativeRename,
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
}
