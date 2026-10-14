import zlib from 'node:zlib';
import { escapeHtml } from '../../article-processing/src/index.ts';
import type { Item, ThemeId, ThemePreference, TocEntry, UserSettings } from '../../shared/src/index.ts';
import { THEMES, parseHexRgb } from '../../shared/src/themes.ts';

export function generateThemeStylesheet(): string {
  const themeBlocks = Object.values(THEMES)
    .map(
      (t) => `
[data-theme="${t.id}"] {
  --color-bg-primary: ${t.colors.bgPrimary};
  --color-bg-elevated: ${t.colors.bgElevated};
  --color-bg-subtle: ${t.colors.bgSubtle};
  --color-text-primary: ${t.colors.textPrimary};
  --color-text-secondary: ${t.colors.textSecondary};
  --color-text-muted: ${t.colors.textMuted};
  --color-accent: ${t.colors.accent};
  --color-accent-text: ${t.colors.accentText};
  --color-border: ${t.colors.border};
  --color-focus-ring: ${t.colors.focusRing};
  --color-danger: ${t.colors.danger};
  --color-success: ${t.colors.success};
  --color-warning: ${t.colors.warning};
  --color-highlight-bg: ${t.colors.highlightBg};
  --color-highlight-text: ${t.colors.highlightText};
  --font-ui: ${t.typography.fontUi};
  --font-reading: ${t.typography.fontReading};
  --font-mono: ${t.typography.fontMono};
  --scale-base: ${t.typography.scaleBasePx}px;
  --line-height-body: ${t.typography.lineHeightBody};
  --line-height-heading: ${t.typography.lineHeightHeading};
  --space-unit: ${t.layout.spacingUnitPx}px;
  --radius-sm: ${t.layout.borderRadiusSm};
  --radius-md: ${t.layout.borderRadiusMd};
  --radius-lg: ${t.layout.borderRadiusLg};
  --border-style: ${t.layout.borderStyle};
  --border-width: ${t.layout.borderWidth};
  --shadow-sm: ${t.layout.shadowSm};
  --shadow-md: ${t.layout.shadowMd};
  --focus-ring: ${t.layout.focusRingStyle};
  --motion-duration: ${t.layout.motionDurationMs}ms;
  --motion-easing: ${t.layout.motionEasing};
}`
    )
    .join('\n');

  const componentRules = `
/* COMPONENT_RULES */
* { box-sizing: border-box; }
html, body {
  margin: 0;
  padding: 0;
  background-color: var(--color-bg-primary);
  color: var(--color-text-primary);
  font-family: var(--font-ui);
  font-size: var(--scale-base);
  line-height: var(--line-height-body);
  transition: background-color var(--motion-duration) var(--motion-easing),
              color var(--motion-duration) var(--motion-easing);
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
:focus-visible {
  outline: var(--focus-ring);
  outline-offset: 2px;
}
.app-shell {
  display: grid;
  grid-template-columns: 240px 1fr;
  min-height: 100vh;
}
@media (max-width: 768px) {
  .app-shell {
    grid-template-columns: 1fr;
  }
}
.sidebar {
  background-color: var(--color-bg-elevated);
  border-right: var(--border-width) var(--border-style) var(--color-border);
  padding: calc(var(--space-unit) * 2);
}
.main-region {
  padding: calc(var(--space-unit) * 3);
  max-width: 1080px;
}
.capture-bar {
  display: flex;
  gap: var(--space-unit);
  background-color: var(--color-bg-elevated);
  border: var(--border-width) var(--border-style) var(--color-border);
  border-radius: var(--radius-md);
  padding: var(--space-unit);
  box-shadow: var(--shadow-sm);
}
.btn-primary {
  background-color: var(--color-accent);
  color: var(--color-accent-text);
  border: var(--border-width) var(--border-style) var(--color-accent);
  border-radius: var(--radius-sm);
  padding: calc(var(--space-unit) * 0.75) calc(var(--space-unit) * 1.5);
  cursor: pointer;
}
.item-row {
  background-color: var(--color-bg-elevated);
  border: var(--border-width) var(--border-style) var(--color-border);
  border-radius: var(--radius-md);
  padding: calc(var(--space-unit) * 1.5);
  margin-bottom: var(--space-unit);
}
.reader-article {
  font-family: var(--font-reading);
  line-height: var(--line-height-body);
  max-width: 68ch;
  margin: 0 auto;
}
.reader-article mark {
  background-color: var(--color-highlight-bg);
  color: var(--color-highlight-text);
}
.command-palette-dialog {
  background-color: var(--color-bg-elevated);
  color: var(--color-text-primary);
  border: var(--border-width) var(--border-style) var(--color-border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-md);
  padding: calc(var(--space-unit) * 2);
}
.error-banner {
  background-color: var(--color-bg-subtle);
  color: var(--color-danger);
  border: var(--border-width) var(--border-style) var(--color-danger);
  border-radius: var(--radius-md);
  padding: calc(var(--space-unit) * 1.5);
}
`;

  return `${themeBlocks}\n${componentRules}`;
}

export const COMPONENT_ONLY_CSS = generateThemeStylesheet().split('/* COMPONENT_RULES */').pop() || '';

export function renderInlineThemeBootstrapScript(defaultTheme: ThemePreference = 'editorial-light'): string {
  return `<script id="theme-bootstrap">
(function() {
  try {
    var pref = localStorage.getItem('rp_theme') || '${defaultTheme}';
    var resolved = pref;
    if (pref === 'system') {
      resolved = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'midnight-amoled'
        : 'editorial-light';
    }
    document.documentElement.setAttribute('data-theme', resolved);
  } catch (e) {
    document.documentElement.setAttribute('data-theme', 'editorial-light');
  }
})();
</script>`;
}

export interface RenderScreenOptions {
  screen: 'library' | 'reader' | 'settings' | 'command-palette' | 'error-state' | 'pdf-reader';
  theme: ThemeId;
  userSettings?: UserSettings;
  items?: Item[];
  activeItem?: Item;
  sanitizedReaderHtml?: string;
  toc?: TocEntry[];
  errorMessage?: string;
}

export function renderAppScreenHtml(opts: RenderScreenOptions): string {
  const themeTokens = THEMES[opts.theme] || THEMES['editorial-light'];
  const items = opts.items || [];
  const readerSettings = opts.userSettings?.reader || {
    width: 'medium',
    fontSize: 18,
    fontFamily: 'serif',
    lineSpacing: 1.7,
    distractionFree: false,
  };

  const widthCh = readerSettings.width === 'narrow' ? '55ch' : readerSettings.width === 'wide' ? '82ch' : '68ch';

  let mainContent = '';
  if (opts.screen === 'library') {
    const rows = items
      .map(
        (it) => `<article class="item-row" data-item-id="${escapeHtml(it.id)}">
          <h2><a href="/?screen=reader&id=${escapeHtml(it.id)}">${escapeHtml(it.title)}</a></h2>
          <p class="item-meta">${escapeHtml(it.domain)} · ${it.reading_time_minutes} min read · status: ${escapeHtml(it.processing_status)}</p>
        </article>`
      )
      .join('\n');
    mainContent = `
      <section aria-labelledby="library-heading">
        <h1 id="library-heading">Library</h1>
        <form class="capture-bar" action="/api/items/capture" method="POST" aria-label="Save URL to Library">
          <label for="capture-url-input">Save URL</label>
          <input id="capture-url-input" name="url" type="url" required placeholder="https://example.com/article" />
          <button type="submit" class="btn-primary">Save Article</button>
        </form>
        <div class="library-list" data-layout="${escapeHtml(opts.userSettings?.listLayout || 'comfortable')}">
          ${rows || '<p role="status">Your library is empty. Paste a URL above to begin.</p>'}
        </div>
      </section>`;
  } else if (opts.screen === 'reader') {
    const active = opts.activeItem;
    const tocList = (opts.toc || [])
      .map((t) => `<li data-level="${t.level}"><a href="#${escapeHtml(t.id)}">${escapeHtml(t.text)}</a></li>`)
      .join('');
    mainContent = `
      <article class="reader-article" aria-labelledby="reader-title" style="max-width:${widthCh};font-size:${readerSettings.fontSize}px;line-height:${readerSettings.lineSpacing}">
        <header>
          <h1 id="reader-title">${escapeHtml(active?.title || 'Reader View')}</h1>
          <p class="reader-byline">${escapeHtml(active?.author || 'Unknown Author')} · ${escapeHtml(active?.domain || 'example.com')}</p>
        </header>
        <nav aria-label="Table of Contents"><ul>${tocList}</ul></nav>
        <div class="reader-body">${opts.sanitizedReaderHtml || '<p>Article content ready.</p>'}</div>
      </article>`;
  } else if (opts.screen === 'settings') {
    mainContent = `
      <section aria-labelledby="settings-heading">
        <h1 id="settings-heading">Settings &amp; Themes</h1>
        <form id="theme-switcher-form" aria-label="Theme Selection">
          <fieldset>
            <legend>Active Theme</legend>
            <label><input type="radio" name="theme" value="editorial-light" ${opts.theme === 'editorial-light' ? 'checked' : ''}/> Editorial Light</label>
            <label><input type="radio" name="theme" value="midnight-amoled" ${opts.theme === 'midnight-amoled' ? 'checked' : ''}/> Midnight AMOLED</label>
            <label><input type="radio" name="theme" value="swiss-minimal" ${opts.theme === 'swiss-minimal' ? 'checked' : ''}/> Swiss Minimal</label>
            <label><input type="radio" name="theme" value="soft-sepia" ${opts.theme === 'soft-sepia' ? 'checked' : ''}/> Soft Sepia</label>
            <label><input type="radio" name="theme" value="system" /> Follow System</label>
          </fieldset>
          <button type="submit" class="btn-primary">Apply Settings</button>
        </form>
      </section>`;
  } else if (opts.screen === 'command-palette') {
    mainContent = `
      <div role="dialog" aria-modal="true" aria-labelledby="cmd-palette-title" class="command-palette-dialog" tabindex="-1">
        <h1 id="cmd-palette-title">Command Palette (Cmd+K / Ctrl+K)</h1>
        <label for="cmd-input">Run a command</label>
        <input id="cmd-input" type="text" placeholder="Type a command or search..." autofocus />
        <ul role="listbox" aria-label="Available Commands">
          <li role="option" aria-selected="true" data-cmd="capture">Save URL</li>
          <li role="option" aria-selected="false" data-cmd="search">Search Library</li>
          <li role="option" aria-selected="false" data-cmd="switch-theme">Switch Theme</li>
          <li role="option" aria-selected="false" data-cmd="create-collection">Create Collection</li>
          <li role="option" aria-selected="false" data-cmd="mark-read">Mark Read / Unread</li>
          <li role="option" aria-selected="false" data-cmd="favorite">Toggle Favorite</li>
          <li role="option" aria-selected="false" data-cmd="archive">Archive Item</li>
          <li role="option" aria-selected="false" data-cmd="export">Export Library</li>
        </ul>
      </div>`;
  } else if (opts.screen === 'error-state') {
    mainContent = `
      <section aria-labelledby="error-heading" class="error-banner" role="alert">
        <h1 id="error-heading">Capture Failed</h1>
        <p>${escapeHtml(opts.errorMessage || 'Upstream server timed out while fetching article.')}</p>
        <p>Preserved URL: <code>${escapeHtml(opts.activeItem?.url || 'https://example.com/slow-article')}</code></p>
        <button type="button" class="btn-primary" data-action="retry-capture">Retry Capture</button>
      </section>`;
  } else if (opts.screen === 'pdf-reader') {
    mainContent = `
      <section aria-labelledby="pdf-heading" class="reader-article">
        <h1 id="pdf-heading">PDF Reader: ${escapeHtml(opts.activeItem?.title || 'Research Paper.pdf')}</h1>
        <div role="toolbar" aria-label="PDF Controls">
          <button type="button" class="btn-primary">Previous Page</button>
          <span aria-live="polite">Page 1 of ${opts.activeItem?.page_count || 3}</span>
          <button type="button" class="btn-primary">Next Page</button>
        </div>
        <div class="pdf-text-layer">${opts.sanitizedReaderHtml || '<p>Extracted PDF page text ready for highlighting.</p>'}</div>
      </section>`;
  }

  return `<!DOCTYPE html>
<html lang="en" data-theme="${escapeHtml(themeTokens.id)}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(themeTokens.name)} — Self-Hosted Reading Platform</title>
  ${renderInlineThemeBootstrapScript(themeTokens.id)}
  <style>${generateThemeStylesheet()}</style>
</head>
<body>
  <div class="app-shell">
    ${
      readerSettings.distractionFree && opts.screen === 'reader'
        ? ''
        : `<nav class="sidebar" aria-label="Primary Navigation">
      <a href="/?view=inbox">Inbox</a>
      <a href="/?view=all">All Items</a>
      <a href="/?view=unread">Unread</a>
      <a href="/?view=favorites">Favorites</a>
      <a href="/?view=archived">Archived</a>
      <a href="/?view=failed">Failed</a>
      <a href="/?screen=settings">Settings</a>
    </nav>`
    }
    <main class="main-region" id="main-content">
      ${mainContent}
    </main>
  </div>
</body>
</html>`;
}

export function renderThemeScreenshotPng(themeId: ThemeId, screen: RenderScreenOptions['screen']): Buffer {
  const theme = THEMES[themeId];
  const width = 320;
  const height = 200;

  const bg = parseHexRgb(theme.colors.bgPrimary);
  const elevated = parseHexRgb(theme.colors.bgElevated);
  const accent = parseHexRgb(theme.colors.accent);
  const text = parseHexRgb(theme.colors.textPrimary);
  const border = parseHexRgb(theme.colors.border);
  const danger = parseHexRgb(theme.colors.danger);

  const rawData = Buffer.alloc(height * (1 + width * 3));
  const screenIdx = ['library', 'reader', 'settings', 'command-palette', 'error-state', 'pdf-reader'].indexOf(screen);

  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 3);
    rawData[rowStart] = 0;
    for (let x = 0; x < width; x++) {
      let rgb = bg;
      if (x < 64) {
        rgb = elevated;
        if (x === 63) rgb = border;
      } else if (y >= 16 && y <= 40 && x >= 80 && x <= 300) {
        rgb = screen === 'error-state' ? danger : x > 250 ? accent : elevated;
      } else if (y >= 56 && y <= 170 && x >= 80 && x <= 300) {
        const band = Math.floor((y - 56) / (18 + (screenIdx % 3) * 4));
        if (band % 2 === 0) {
          rgb = elevated;
          if ((y - 56) % 9 === 3 && x > 92 && x < 260) {
            rgb = text;
          }
        }
      }
      const pxOffset = rowStart + 1 + x * 3;
      rawData[pxOffset] = rgb[0];
      rawData[pxOffset + 1] = rgb[1];
      rawData[pxOffset + 2] = rgb[2];
    }
  }

  const makeChunk = (type: string, data: Buffer): Buffer => {
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const crcInput = Buffer.concat([typeBuf, data]);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(zlib.crc32(crcInput) >>> 0, 0);
    return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
  };

  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const idatData = zlib.deflateSync(rawData);

  return Buffer.concat([
    signature,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', idatData),
    makeChunk('IEND', Buffer.alloc(0)),
  ]);
}
