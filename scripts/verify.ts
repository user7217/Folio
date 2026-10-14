import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const rootDir = process.env.PROJECT_ROOT || '/Users/harsha1/Documents/pocket_clone';
const logsDir = path.join(rootDir, 'evidence', 'logs');
fs.mkdirSync(logsDir, { recursive: true });

function formatTimestamp(d: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(
    d.getUTCMinutes()
  )}${pad(d.getUTCSeconds())}`;
}

interface StepSpec {
  name: string;
  args: string[];
}

const steps: StepSpec[] = [
  { name: 'lint', args: ['scripts/lint.ts'] },
  { name: 'format-check', args: ['scripts/format-check.ts'] },
  { name: 'typecheck', args: ['scripts/typecheck.ts'] },
  { name: 'unit-tests', args: ['--test', 'tests/unit/core.test.ts'] },
  { name: 'integration-tests', args: ['--test', 'tests/integration/platform.test.ts'] },
  { name: 'e2e-tests', args: ['--test', 'tests/e2e/workflows.test.ts'] },
  { name: 'security-tests', args: ['--test', 'tests/security/adversarial.test.ts'] },
  { name: 'build', args: ['scripts/build.ts'] },
  { name: 'smoke', args: ['scripts/smoke.ts'] },
];

const results: Array<{
  step: string;
  status: 'passed' | 'failed';
  exitCode: number;
  durationMs: number;
  logFile: string;
}> = [];

const tsPrefix = formatTimestamp();
let overallSuccess = true;

for (const step of steps) {
  const start = performance.now();
  const res = spawnSync(process.execPath, step.args, {
    cwd: rootDir,
    encoding: 'utf8',
    env: {
      ...process.env,
      PROJECT_ROOT: rootDir,
      PATH: `${path.join(rootDir, '.cache/bin')}:/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ''}`,
    },
  });
  const durationMs = Math.round(performance.now() - start);
  const logFileName = `${tsPrefix}-${step.name}.log`;
  const logFilePath = path.join(logsDir, logFileName);
  const combinedOutput = [
    `# Command: node ${step.args.join(' ')}`,
    `# Timestamp: ${new Date().toISOString()}`,
    `# Exit Code: ${res.status ?? 1}`,
    `# Duration: ${durationMs} ms`,
    '',
    res.stdout || '',
    res.stderr || '',
  ].join('\n');

  fs.writeFileSync(logFilePath, combinedOutput, 'utf8');
  process.stdout.write(res.stdout || '');
  if (res.stderr) process.stderr.write(res.stderr);

  const passed = res.status === 0;
  if (!passed) overallSuccess = false;

  results.push({
    step: step.name,
    status: passed ? 'passed' : 'failed',
    exitCode: res.status ?? 1,
    durationMs,
    logFile: `evidence/logs/${logFileName}`,
  });

  if (!passed) break;
}

const summary = {
  timestamp: new Date().toISOString(),
  overallStatus: overallSuccess ? 'passed' : 'failed',
  steps: results,
};

fs.writeFileSync(path.join(rootDir, 'evidence', 'verify-summary.json'), JSON.stringify(summary, null, 2), 'utf8');
if (!overallSuccess) {
  process.exit(1);
}
