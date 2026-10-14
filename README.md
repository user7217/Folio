# Self-Hosted Reading & Knowledge Platform

A self-hosted read-later application, bookmark manager, RSS/Atom reader, PDF/EPUB document reader, and personal knowledge base built on Node.js `v26.8.2` with native TypeScript execution and a contained transactional JSON + Write-Ahead Log (`.wal.jsonl`) storage engine.

## Quick Start Commands (Executed & Verified)

```bash
# Add project-local workspace runner and Homebrew binaries to PATH
export PATH="/Users/harsha1/Documents/pocket_clone/.cache/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

# Install / verify local contained workspace
pnpm install

# Run database schema migrations
node scripts/migrate.ts

# Run full verification suite (lint, format, typecheck, unit, integration, e2e, security, build, smoke)
pnpm verify

# Build production manifest & 24 theme visual regression baselines
pnpm build

# Run 1,000-article and 10,000-article performance benchmarks
node benchmark/run.ts optimized

# Create an encrypted/checksummed backup archive (0600 permissions)
node scripts/backup.ts /Users/harsha1/Documents/pocket_clone/data/backup.zip

# Restore a backup archive into a target data directory
node scripts/restore.ts /Users/harsha1/Documents/pocket_clone/data/backup.zip /Users/harsha1/Documents/pocket_clone/data-restored

# Start web server & background worker (on non-sandboxed host or Docker)
node apps/web/src/server.ts
node apps/worker/src/worker.ts
```

## Environment Variables (Matches `.env.example`)

| Variable | Default | Description |
|---|---|---|
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
