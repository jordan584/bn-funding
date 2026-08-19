const { execFileSync, spawnSync } = require('node:child_process');
const { existsSync } = require('node:fs');
const path = require('node:path');

const BEGIN_MARKER = '# BEGIN bn-funding';
const END_MARKER = '# END bn-funding';
const PROJECT_DIR = path.resolve(__dirname, '..');

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function buildCronBlock({ nodePath, projectDir }) {
  const cliPath = path.join(projectDir, 'dist', 'cli.js');
  const logPath = path.join(projectDir, 'cron.log');
  return [
    BEGIN_MARKER,
    `5 0,8,16 * * * cd ${shellQuote(projectDir)} && TZ=Asia/Shanghai ${shellQuote(nodePath)} ${shellQuote(cliPath)} --send >> ${shellQuote(logPath)} 2>&1`,
    END_MARKER
  ].join('\n');
}

function replaceManagedCron(existing, block) {
  const managedBlock = /^# BEGIN bn-funding\n[\s\S]*?^# END bn-funding\n?/gmu;
  const preserved = existing.replace(managedBlock, '').trim();
  return `${preserved === '' ? '' : `${preserved}\n\n`}${block}\n`;
}

function readCrontab() {
  try {
    return execFileSync('crontab', ['-l'], { encoding: 'utf8' });
  } catch (error) {
    if (error && typeof error === 'object' && error.status === 1) return '';
    throw error;
  }
}

function writeCrontab(content) {
  execFileSync('crontab', ['-'], { input: content, encoding: 'utf8' });
}

function install() {
  const cliPath = path.join(PROJECT_DIR, 'dist', 'cli.js');
  if (!existsSync(cliPath)) {
    throw new Error('dist/cli.js is missing; run npm run build first');
  }
  const block = buildCronBlock({ nodePath: process.execPath, projectDir: PROJECT_DIR });
  writeCrontab(replaceManagedCron(readCrontab(), block));
  process.stdout.write('Installed bn-funding cron for 00:05, 08:05, and 16:05 Beijing time.\n');
  process.stdout.write('Running the initial forced delivery now.\n');
  const result = spawnSync(process.execPath, [cliPath, '--send', '--force'], {
    cwd: PROJECT_DIR,
    env: { ...process.env, TZ: 'Asia/Shanghai' },
    stdio: 'inherit'
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Initial funding delivery failed with exit code ${result.status ?? 'unknown'}`);
  }
}

function remove() {
  const current = readCrontab();
  const managedBlock = /^# BEGIN bn-funding\n[\s\S]*?^# END bn-funding\n?/gmu;
  const updated = current.replace(managedBlock, '').trim();
  writeCrontab(updated === '' ? '' : `${updated}\n`);
  process.stdout.write('Removed the bn-funding cron entry.\n');
}

if (require.main === module) {
  try {
    const command = process.argv[2];
    if (command === '--install') install();
    else if (command === '--remove') remove();
    else throw new Error('Usage: node scripts/install-cron.cjs --install|--remove');
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

module.exports = { buildCronBlock, replaceManagedCron };
