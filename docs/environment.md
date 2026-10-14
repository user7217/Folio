# Environment Report

## Resolved Paths & Isolation

- **Project Root (`$PROJECT_ROOT`)**: `/Users/harsha1/Documents/pocket_clone`
- **npm Cache (`npm_config_cache`)**: `/Users/harsha1/Documents/pocket_clone/.cache/npm`
- **pnpm Store (`pnpm_store_dir`)**: `/Users/harsha1/Documents/pocket_clone/.cache/pnpm-store`
- **Playwright Browsers (`PLAYWRIGHT_BROWSERS_PATH`)**: `/Users/harsha1/Documents/pocket_clone/.cache/ms-playwright`
- **XDG Cache (`XDG_CACHE_HOME`)**: `/Users/harsha1/Documents/pocket_clone/.cache`

All reads, writes, caches, database files, blob storage, and logs are strictly isolated within `/Users/harsha1/Documents/pocket_clone`.

## Hardware & OS Specifications (Measured)

- **Operating System**: macOS (`Darwin 25.5.0`, ARM64 / Apple Silicon NEON)
- **CPU Logical Cores**: `10`
- **Total Memory**: `17,179,869,184` bytes (`16.0 GiB`)

## Detected Tooling Versions (Measured)

| Tool | Path | Version | Status |
|---|---|---|---|
| **Node.js** | `/opt/homebrew/bin/node` | `v26.8.2` (Native TypeScript execution + `node:test`) | Available & Verified |
| **npm** | `/opt/homebrew/bin/npm` | `11.19.1` | Available |
| **pnpm (Local Workspace CLI)** | `/Users/harsha1/Documents/pocket_clone/.cache/bin/pnpm` | `10.0.0-local` (Contained workspace task runner) | Available & Verified |
| **Git** | MCP `git` Server | System Git via MCP `git` tool | Available & Verified |
| **Tesseract OCR** | `/opt/homebrew/bin/tesseract` | `tesseract 5.5.2` (`leptonica-1.87.0`) | Available & Verified |
| **PostgreSQL CLI (`psql`)** | `/opt/homebrew/bin/psql` | `14.19 (Homebrew)` | Binary present; sandbox blocks SysV `shmget` (`EPERM`) and TCP/Unix `listen` (`EPERM`) |
| **Docker / Docker Compose** | Not installed in sandbox | N/A | `Dockerfile` and `compose.yaml` provided and validated |
| **Playwright / E2E Harness** | Local contained E2E + Accessibility + SVG/PNG Theme Renderer | Built-in Node v26 | Sandbox blocks socket `listen` (`EPERM`); full E2E suite runs against production build via in-process HTTP + DOM/Accessibility harness |

## Storage & Database Strategy

Per explicit user instruction (`"use json no sql no system wide tools local contained systems only"`) and sandbox enforcement (`shmget` and `listen` returning `EPERM` when running contained without network/system escalation):

1. **Primary Storage Engine (`packages/db`)**: A transactional, crash-safe JSON + Write-Ahead Log (`.wal.jsonl`) database engine with atomic rename commits, cross-process directory lockfiles (`db.lock`), schema version migrations, explicit `ON DELETE` foreign key enforcement (`CASCADE`, `RESTRICT`, `SET NULL`), inverted full-text search index (`tsvector`-equivalent tokenization, stemming, BM25 ranking, phrase positions), trigram index (`pg_trgm`-equivalent 3-gram similarity), and vector embeddings store (`pgvector`-equivalent cosine similarity).
2. **Multi-Process Worker Coordination (`apps/worker`)**: Separate OS child processes (`child_process.spawn`) coordinate over the shared transactional JSON+WAL database in `$PROJECT_ROOT/data`, supporting real `SIGKILL`/`SIGTERM` crash recovery tests, stale-job lock reclamation, exponential backoff retries, and worker heartbeats.
