import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const stateFile = process.argv[2];
const mainLockAction = process.argv[3];
if (stateFile === undefined || !['remove', 'keep'].includes(mainLockAction ?? '')) {
  throw new Error('state file and remove|keep arguments are required');
}

const lockDirectory = `${stateFile}.lock`;
const recoveryDirectory = `${lockDirectory}.recovery`;
await mkdir(recoveryDirectory, { mode: 0o700 });
await writeFile(path.join(recoveryDirectory, 'owner.json'), JSON.stringify({
  pid: process.pid,
  token: randomUUID(),
  acquiredAtMs: Date.now()
}), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
if (mainLockAction === 'remove') {
  await rm(lockDirectory, { recursive: true, force: true });
}
process.stdout.write('recovery-gate-ready\n');
await new Promise<void>(() => {
  setInterval(() => {}, 60_000);
});
