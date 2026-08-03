import { randomUUID } from 'node:crypto';
import { mkdir, readdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

const stateFile = process.argv[2];
const mainLockAction = process.argv[3];
if (stateFile === undefined || !['remove', 'keep'].includes(mainLockAction ?? '')) {
  throw new Error('state file and remove|keep arguments are required');
}

const lockDirectory = `${stateFile}.lock`;
await mkdir(lockDirectory, { recursive: true, mode: 0o700 });
const existingContenders = await readdir(lockDirectory);
let maximumSequence = -1n;
for (const entry of existingContenders) {
  const match = /^(\d+)-[A-Za-z0-9_-]+\.ticket$/.exec(entry);
  if (match?.[1] !== undefined) {
    maximumSequence = maximumSequence > BigInt(match[1])
      ? maximumSequence
      : BigInt(match[1]);
  }
}
const token = randomUUID();
const ticketFile = path.join(
  lockDirectory,
  `${(maximumSequence + 1n).toString().padStart(20, '0')}-${token}.ticket`
);
await writeFile(ticketFile, JSON.stringify({
  pid: process.pid,
  token,
  acquiredAtMs: Date.now()
}), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
if (mainLockAction === 'remove') {
  for (const entry of existingContenders) {
    if (entry.endsWith('.choosing') || entry.endsWith('.ticket')) {
      try {
        await unlink(path.join(lockDirectory, entry));
      } catch (error) {
        if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')) {
          throw error;
        }
      }
    }
  }
}
process.stdout.write('recovery-gate-ready\n');
await new Promise<void>(() => {
  setInterval(() => {}, 60_000);
});
