# System Architecture

## 1. Monorepo Layout

- `apps/web`: HTTP application server (`apps/web/src/server.ts`) and request dispatcher (`apps/web/src/app.ts`) implementing all 52 registered routes, CSRF/Origin checks, rate limiting, and SSR UI rendering.
- `apps/worker`: Durable background job queue processor (`apps/worker/src/worker.ts`) with stale-lock recovery, exponential backoff retries, dead-letter handling, and worker heartbeats.
- `apps/extension`: Manifest V3 unpacked Chromium extension (`apps/extension/manifest.json`, `background.js`, `popup.html`, `extension-client.ts`) using short-lived pairing codes and capture-scoped bearer tokens.
- `packages/shared`: Domain types, UUIDv7 generator (`packages/shared/src/index.ts`), central authorization policy (`authz.ts`), route registry (`ROUTE_REGISTRY`), SSRF-safe validator/fetcher (`ssrf.ts`), URL normalizer (`url.ts`), search operator parser (`search-parser.ts`), highlight anchoring (`anchoring.ts`), offline sync merge rules (`sync.ts`), and token-complete themes (`themes.ts`).
- `packages/article-processing`: Readability-style article extractor, server-side allowlist HTML sanitizer, RSS/Atom feed discovery & XML parser (XXE-hardened), PDF parser, and ZIP/EPUB parser with zip-slip and zip-bomb defenses.
- `packages/db`: Contained transactional JSON + Write-Ahead Log (`db.json` + `db.wal.jsonl`) storage engine with cross-process directory locks, versioned migrations, explicit `ON DELETE` cascades, inverted GIN search index, trigram fallback, vector embeddings store, and opaque filesystem blob store.
- `packages/ui`: Design-token stylesheet generator, inline flash-prevention bootstrap script, accessible SSR screen templates, and deterministic PNG visual-regression renderer.

## 2. Orthogonal State Machines

- **Processing Status** (`processing_status`): `queued` -> `fetching` -> `extracting` -> `ready` | `partial` | `failed`.
- **Per-User Lifecycle** (`lifecycle`): `active` <-> `archived` <-> `trashed` (soft delete, restorable for 30 days) -> permanent delete.
  An archived item can have a failed extraction, and a ready item can be in the trash.
