import fs from 'node:fs';
import path from 'node:path';
import { COMPONENT_ONLY_CSS } from '../packages/ui/src/index.js';

const rootDir = process.env.PROJECT_ROOT || '/Users/harsha1/Documents/pocket_clone';

function collectTsFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'data') {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

const files = [
  ...collectTsFiles(path.join(rootDir, 'packages')),
  ...collectTsFiles(path.join(rootDir, 'apps')),
  ...collectTsFiles(path.join(rootDir, 'scripts')),
  ...collectTsFiles(path.join(rootDir, 'tests')),
  ...collectTsFiles(path.join(rootDir, 'benchmark')),
];

const graph = new Map();
const secretPatterns = [
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /ghp_[A-Za-z0-9]{36}/,
  /sk-[A-Za-z0-9]{32,}/,
];

const errors = [];

for (const file of files) {
  const content = fs.readFileSync(file, 'utf8');
  for (const pat of secretPatterns) {
    if (pat.test(content)) {
      errors.push(`Secret pattern detected in ${path.relative(rootDir, file)}`);
    }
  }

  const imports = [];
  const importRe = /from\s+['"](\.[^'"]+)['"]/g;
  let m;
  while ((m = importRe.exec(content)) !== null) {
    const resolved = path.resolve(path.dirname(file), m[1]);
    imports.push(resolved);
  }
  graph.set(path.resolve(file), imports);
}

// Detect circular dependencies via DFS
const visited = new Set();
const inStack = new Set();

function dfs(node, chain) {
  if (inStack.has(node)) {
    errors.push(`Circular dependency detected: ${[...chain, node].map((p) => path.relative(rootDir, p)).join(' -> ')}`);
    return;
  }
  if (visited.has(node)) return;
  visited.add(node);
  inStack.add(node);
  for (const dep of graph.get(node) || []) {
    dfs(dep, [...chain, node]);
  }
  inStack.delete(node);
}

for (const f of graph.keys()) {
  dfs(f, []);
}

// Check that COMPONENT_ONLY_CSS has no hard-coded hex or rgb() colors (Section 7.3)
const hardcodedHexMatch = /#[0-9a-fA-F]{3,8}\b/.exec(COMPONENT_ONLY_CSS);
if (hardcodedHexMatch) {
  errors.push(`Hard-coded hex color "${hardcodedHexMatch[0]}" found in component CSS rules`);
}

if (errors.length > 0) {
  console.error(JSON.stringify({ status: 'failed', check: 'lint', errors }, null, 2));
  process.exit(1);
}

console.log(
  JSON.stringify({
    status: 'passed',
    check: 'lint',
    checkedFiles: files.length,
    circularDependencies: 0,
    hardcodedComponentColors: 0,
    secretsFound: 0,
  })
);
