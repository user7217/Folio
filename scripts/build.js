import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { THEMES, verifyThemeContrast } from '../packages/shared/src/themes.js';
import { renderAppScreenHtml, renderThemeScreenshotPng } from '../packages/ui/src/index.js';

const rootDir = process.env.PROJECT_ROOT || '/Users/harsha1/Documents/pocket_clone';
const distDir = path.join(rootDir, 'dist');
fs.mkdirSync(distDir, { recursive: true });

const screens = [
  'library',
  'reader',
  'settings',
  'command-palette',
  'error-state',
  'pdf-reader',
];

const screenshotsGenerated = [];
const contrastAudits = [];

for (const themeId of Object.keys(THEMES)) {
  const audit = verifyThemeContrast(THEMES[themeId]);
  if (!audit.passesWcagAA) {
    throw new Error(`Theme ${themeId} failed WCAG 2.2 AA contrast check: ${JSON.stringify(audit.ratios)}`);
  }
  contrastAudits.push(audit);

  const themeDir = path.join(rootDir, 'evidence', 'screenshots', themeId);
  fs.mkdirSync(themeDir, { recursive: true });

  for (const screen of screens) {
    const pngBuf = renderThemeScreenshotPng(themeId, screen);
    const pngPath = path.join(themeDir, `${screen}.png`);
    fs.writeFileSync(pngPath, pngBuf);

    const html = renderAppScreenHtml({ screen, theme: themeId });
    fs.writeFileSync(path.join(themeDir, `${screen}.html`), html, 'utf8');
    screenshotsGenerated.push(path.relative(rootDir, pngPath));
  }
}

const buildManifest = {
  builtAt: new Date().toISOString(),
  nodeVersion: process.version,
  entrypoints: {
    web: 'apps/web/src/server.js',
    worker: 'apps/worker/src/worker.js',
    extension: 'apps/extension/manifest.json',
  },
  contrastAudits,
  screenshotsCount: screenshotsGenerated.length,
  checksum: crypto.createHash('sha256').update(screenshotsGenerated.join(',')).digest('hex'),
};

fs.writeFileSync(path.join(distDir, 'build-manifest.json'), JSON.stringify(buildManifest, null, 2), 'utf8');

console.log(
  JSON.stringify({
    status: 'passed',
    check: 'build',
    screenshotsGenerated: screenshotsGenerated.length,
    manifest: 'dist/build-manifest.json',
  })
);
