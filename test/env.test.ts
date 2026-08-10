import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadProjectEnv } from '../src/env.js';

test('loads a project env file without overriding values already supplied by the shell', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'bn-funding-env-'));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  const envFile = path.join(directory, '.env');
  await writeFile(envFile, "FUNDING_ENV_NEW='from file'\nFUNDING_ENV_KEEP='from file'\n", 'utf8');
  const previousNew = process.env.FUNDING_ENV_NEW;
  const previousKeep = process.env.FUNDING_ENV_KEEP;
  process.env.FUNDING_ENV_KEEP = 'from shell';
  delete process.env.FUNDING_ENV_NEW;
  t.after(() => {
    if (previousNew === undefined) delete process.env.FUNDING_ENV_NEW;
    else process.env.FUNDING_ENV_NEW = previousNew;
    if (previousKeep === undefined) delete process.env.FUNDING_ENV_KEEP;
    else process.env.FUNDING_ENV_KEEP = previousKeep;
  });

  loadProjectEnv(envFile);

  assert.equal(process.env.FUNDING_ENV_NEW, 'from file');
  assert.equal(process.env.FUNDING_ENV_KEEP, 'from shell');
});

test('silently permits a missing project env file', () => {
  assert.doesNotThrow(() => loadProjectEnv('/definitely/missing/bn-funding.env'));
});
