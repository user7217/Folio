# Folio — Self-Hosted Reading & Knowledge Platform (Pure Node.js Edition)

Folio is a self-hosted, local-first read-later application, bookmark manager, RSS/Atom feed reader, PDF/EPUB document reader, and personal knowledge base. It runs as a **mobile-first React Single-Page Application (SPA)** backed by a zero-dependency **pure Node.js (ESM `.js`)** server and a self-contained transactional JSON + Write-Ahead Log (`.wal.jsonl`) storage engine.

## Project Brief & Core Highlights

- **Pure Node.js (Zero TypeScript Build Step)**: Every server, worker, database, article-processing, UI, test, and script module is written in native ES Module JavaScript (`.js`) and runs directly with `node`.
- **Mobile-First React SPA (`FolioReactApp`)**: Instant `0ms` client-side transitions across Library, Reader, Starred, Search, and Appearance settings with optimistic state updates, a thumb-friendly 5-tab mobile bottom bar, swipeable filter chips, and slide-up bottom sheets.
- **Long-Form Reading Ergonomics**: Calibrated around Matthew Butterick's *Practical Typography* and Edward Tufte's *Tufte CSS* with a `65ch` default line measure (`55ch` / `65ch` / `78ch` selectable), `1.75` line spacing, book serif / humanist sans toggle, live font scaling (`15px–26px`), a sticky left Table of Contents rail, a right Notebook & Marginalia rail, and keyboard-driven **Focus Mode (`F`)**.
- **Four Calibrated Reading Themes**: Instant switching between **Editorial Light** (`#FAF8F5` warm ivory), **Soft Sepia** (`#F4ECD8` archival paper), **Swiss Minimal** (`#F7F7F7`), and **Midnight AMOLED** (`#000000` true black), all verified against WCAG 2.2 AA contrast thresholds.
- **Full Image & Figure Pipeline**: Extracts `<figure>` and `<figcaption>` blocks, promotes lazy-loaded blog image attributes (`data-src`, `data-original`, `data-lazy-src`, `srcset`) to canonical URLs, falls back to the first article image for library card thumbnails, and includes a click/tap-to-zoom lightbox.
- **Zero-Migration Local Storage & Hardened Security**: Auto-initializes its transactional database (`data/db.json` + `data/db.wal.jsonl`) on first boot with no manual migration required, enforces resolve-and-pin SSRF protection against private/loopback IP ranges, and sanitizes all untrusted HTML/SVG/XML inputs.

## How the System Works

Folio runs inside a single Node.js process without needing external database servers like PostgreSQL or Redis. Here is what happens from saving a link to reading it:

1. **Zero-Config Startup (`apps/web`)**: When you open `http://127.0.0.1:3000`, the server checks for `data/db.json`. If it doesn't exist yet, it automatically creates the file, provisions a local user account (`local@localhost`), sets a session cookie in your browser, and seeds two illustrated sample essays so your library is immediately ready to explore.
2. **Saving & Securing a Link (`packages/shared`)**: When you save a URL, Folio strips tracking query parameters (`utm_source`, `fbclid`, etc.) so duplicate links aren't saved twice. Before downloading the page, an SSRF security guard resolves the domain's DNS and blocks private or local network IP addresses (`127.0.0.1`, `192.168.x.x`, etc.).
3. **Cleaning the Article & Recovering Images (`packages/article-processing`)**: The parser strips away ads, navigation bars, popups, and `<script>` tags, keeping only the clean article text, headings, author, and reading-time estimate. It also inspects lazy-loaded blog image attributes (`data-src`, `data-original`, `srcset`) and promotes them to standard `<img src="...">` tags so article illustrations and card thumbnails render reliably.
4. **Crash-Safe Local Storage & Search (`packages/db`)**: Every saved article, tag, and highlight is written to a Write-Ahead Log (`data/db.wal.jsonl`) and atomically saved to `data/db.json` so your library is never corrupted if your Mac loses power. At the same time, article words are tokenized into an in-memory search index for instant keyword lookup (`Cmd+K` or `/`).
5. **Adaptive Reading Interface (`packages/ui`)**: The browser loads a fast React app (`FolioReactApp`) that adapts to your screen—showing a 3-column layout (Library/Sidebar, `65ch` Reader, and Table of Contents / Highlights rail) on desktop, and transforming into a thumb-friendly 5-tab bottom bar with slide-up **Aa** typography and **Notes** sheets on mobile.

## Quick Setup & Run Instructions

### 1. Configure Path & Environment

From the repository root (`/Users/harsha1/Documents/pocket_clone`), add the bundled workspace runner and local binaries to your `PATH`:

```bash
cd /Users/harsha1/Documents/pocket_clone
export PATH="$PWD/.cache/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
```

*(Optional)* Copy `.env.example` to `.env` if you want to customize ports or paths; otherwise sensible local defaults are used automatically:

```bash
cp -n .env.example .env
```

### 2. Start the Application (Zero Migration Required)

Start the web server directly with `node` (it automatically initializes `data/db.json`, seeds two illustrated long-form sample essays on first run, and runs an embedded background extraction worker):

```bash
node apps/web/src/server.js
```

Open **`http://127.0.0.1:3000`** in your desktop or mobile browser.

- **Save any article URL**: Paste a URL into the top **Save URL** bar (or tap **+ Save URL** on the mobile bottom bar) to fetch, sanitize, and extract the article and its figures in the background.
- **Test mobile layout on desktop**: Open browser DevTools (`Cmd+Opt+I` on macOS) and toggle the Device Toolbar (`Cmd+Shift+M`) to interact with the 5-tab mobile bottom bar and slide-up **Aa** / **Notes** / **+ Save** bottom sheets.

### 3. Verification, Build & Maintenance Commands

```bash
# Run the full 9-stage verification pipeline (lint, format, typecheck, unit, integration, e2e, security, build, smoke)
pnpm verify

# Build production manifest & 24 theme visual regression baselines
pnpm build

# Run 1,000-article and 10,000-article search & indexing benchmarks
node benchmark/run.js optimized

# Create a checksummed portable backup archive (0600 permissions)
node scripts/backup.js /Users/harsha1/Documents/pocket_clone/data/backup.zip

# Restore a backup archive into a target directory
node scripts/restore.js /Users/harsha1/Documents/pocket_clone/data/backup.zip /Users/harsha1/Documents/pocket_clone/data-restored
```

## Architecture & Repository Layout

| Path | Purpose |
| :--- | :--- |
| `apps/web/src/server.js` | HTTP server entrypoint, embedded extraction queue worker, and initial sample essay seeder |
| `apps/web/src/app.js` | REST API routes, authentication/session management, CSP headers, and SSR + React state hydration |
| `apps/worker/src/worker.js` | Background job processor for URL capture, RSS polling, and PDF/EPUB extraction |
| `apps/extension/` | Browser extension manifest and one-click URL capture popup (`extension-client.js`) |
| `packages/ui/src/index.js` | Mobile-first React SPA (`FolioReactApp`), theme token CSS generator, and bottom-sheet components |
| `packages/article-processing/src/index.js` | Readability extractor, lazy-image promoter (`data-src`/`srcset`), HTML sanitizer, RSS/Atom parser, and PDF/EPUB parsers |
| `packages/db/src/index.js` | Transactional JSON + Write-Ahead Log (`.wal.jsonl`) database engine and inverted full-text search index |
| `packages/shared/src/` | URL canonicalization (`url.js`), SSRF DNS pinning (`ssrf.js`), 3-tier fuzzy quote anchoring (`anchoring.js`), delta sync (`sync.js`), and WCAG theme definitions (`themes.js`) |

## Environment Variables (Matches `.env.example`)

| Variable | Default | Description |
| :--- | :--- | :--- |
| `PROJECT_ROOT` | `/Users/harsha1/Documents/pocket_clone` | Absolute path to repository root |
| `DATA_DIR` | `/Users/harsha1/Documents/pocket_clone/data` | Directory for database, WAL, and blobs |
| `DB_PATH` | `/Users/harsha1/Documents/pocket_clone/data/db.json` | Primary JSON snapshot file |
| `WAL_PATH` | `/Users/harsha1/Documents/pocket_clone/data/db.wal.jsonl` | Write-Ahead Log file |
| `BLOB_DIR` | `/Users/harsha1/Documents/pocket_clone/data/blobs` | Opaque binary blob directory |
| `PORT` | `3000` | HTTP server port |
| `HOST` | `127.0.0.1` | HTTP bind address |
| `NODE_ENV` | `development` | Runtime environment (`development` or `production`) |
| `SESSION_SECRET` | `change-me-in-production-32-bytes-minimum-secret` | Secret for session signing |
| `REGISTRATION_MODE` | `invite_only` | Account registration mode (`invite_only` or `open`) |
| `MAX_UPLOAD_BYTES` | `52428800` | Maximum PDF/EPUB upload size (50 MB) |
| `TRASH_RETENTION_DAYS` | `30` | Soft-delete trash retention window |
| `WORKER_POLL_INTERVAL_MS` | `500` | Worker queue polling interval |
| `WORKER_STALE_TIMEOUT_MS` | `30000` | Stale job lock recovery threshold |
| `OCR_BINARY_PATH` | `/opt/homebrew/bin/tesseract` | Optional local Tesseract OCR binary path |
| `SMTP_ENABLED` | `false` | Enable optional outbound SMTP |
| `SMTP_HOST` | `` | Optional SMTP server hostname |
| `SMTP_PORT` | `587` | Optional SMTP server port |
| `EMBEDDING_PROVIDER` | `lexical_fallback` | Pluggable semantic embedding provider |
