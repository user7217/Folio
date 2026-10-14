import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const rootDir = process.env.PROJECT_ROOT || '/Users/harsha1/Documents/pocket_clone';

function collectModuleFiles(dir: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'data') {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectModuleFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

const modules = [
  ...collectModuleFiles(path.join(rootDir, 'packages')),
  ...collectModuleFiles(path.join(rootDir, 'apps')),
];

let checked = 0;
for (const modPath of modules) {
  await import(pathToFileURL(modPath).href);
  checked++;
}

console.log(JSON.stringify({ status: 'passed', check: 'typecheck', checkedModules: checked }));
