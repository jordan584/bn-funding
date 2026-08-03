import { FileRunStateStore } from '../../src/state/store.js';

const stateFile = process.argv[2];
const timeoutArgument = process.argv[3];
if (stateFile === undefined) {
  throw new Error('state file argument is required');
}

const store = new FileRunStateStore(
  stateFile,
  undefined,
  timeoutArgument === undefined
    ? undefined
    : { lockAcquireTimeoutMs: Number(timeoutArgument) }
);
try {
  await store.withRunLock(async () => {
    process.stdout.write('entered\n');
  });
} catch (error) {
  if (error instanceof Error && error.message === 'Timed out waiting for the run state lock') {
    process.stdout.write('timed-out\n');
  } else {
    throw error;
  }
}
