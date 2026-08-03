import { FileRunStateStore } from '../../src/state/store.js';

const stateFile = process.argv[2];
if (stateFile === undefined) {
  throw new Error('state file argument is required');
}

const store = new FileRunStateStore(stateFile);
await store.withRunLock(async () => {
  process.stdout.write('locked\n');
  await new Promise<void>(() => {
    setInterval(() => {}, 60_000);
  });
});
