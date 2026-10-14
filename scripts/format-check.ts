import fs from 'node:fs';
import path from 'node:path';

const rootDir = process.env.PROJECT_ROOT || '/Users/harsha1/Documents/pocket_clone';

function collectCheckableFiles(dir: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'data') {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectCheckableFiles(full));
    } else if (entry.isFile() && /\.(ts|json|md)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const files = collectCheckableFiles(rootDir);
const errors: string[] = [];

for (const f of files) {
  const raw = fs.readFileSync(f, 'utf8');
  if (raw.includes('\u0000')) {
    errors.push(`Null byte found in ${path.relative(rootDir, f)}`);
  }
  if (/^<{7}\s|^={7}$|^>{7}\s/m.test(raw)) {
    errors.push(`Merge conflict marker found in ${path.relative(rootDir, f)}`);
  }
  if (f.endsWith('.json')) {
    try {
      JSON.parse(raw);
    } catch (err) {
      errors.push(`Invalid JSON in ${path.relative(rootDir, f)}: ${String(err)}`);
    }
  }
}

if (errors.length > 0) {
  console.error(JSON.stringify({ status: 'failed', check: 'format:check', errors }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({ status: 'passed', check: 'format:check', checkedFiles: files.length }));
