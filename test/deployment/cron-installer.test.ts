import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  buildCronBlock,
  replaceManagedCron
} = require('../../scripts/install-cron.cjs') as {
  buildCronBlock(options: { nodePath: string; projectDir: string }): string;
  replaceManagedCron(existing: string, block: string): string;
};

test('builds a non-resident eight-hour cron using absolute Node and project paths', () => {
  const block = buildCronBlock({
    nodePath: '/home/ubuntu/.nvm/versions/node/v24.6.0/bin/node',
    projectDir: '/home/ubuntu/bn-funding'
  });

  assert.match(block, /^# BEGIN bn-funding$/m);
  assert.match(block, /^5 0,8,16 \* \* \*/m);
  assert.match(block, /TZ=Asia\/Shanghai/);
  assert.match(block, /'\/home\/ubuntu\/.nvm\/versions\/node\/v24\.6\.0\/bin\/node'/);
  assert.match(block, /'\/home\/ubuntu\/bn-funding\/dist\/cli\.js' --send/);
  assert.match(block, />> '\/home\/ubuntu\/bn-funding\/cron\.log' 2>&1/);
  assert.doesNotMatch(block, /--force/);
  assert.match(block, /^# END bn-funding$/m);
});

test('replaces only the managed cron block and preserves unrelated jobs', () => {
  const old = [
    '0 2 * * * /usr/local/bin/backup',
    '# BEGIN bn-funding',
    'old funding command',
    '# END bn-funding',
    '15 3 * * * /usr/local/bin/report',
    ''
  ].join('\n');
  const block = buildCronBlock({ nodePath: '/usr/bin/node', projectDir: '/srv/bn funding' });

  const updated = replaceManagedCron(old, block);

  assert.match(updated, /0 2 \* \* \* \/usr\/local\/bin\/backup/);
  assert.match(updated, /15 3 \* \* \* \/usr\/local\/bin\/report/);
  assert.doesNotMatch(updated, /old funding command/);
  assert.equal((updated.match(/# BEGIN bn-funding/g) ?? []).length, 1);
  assert.match(updated, /cd '\/srv\/bn funding'/);
  assert.equal(updated.endsWith('\n'), true);
});
