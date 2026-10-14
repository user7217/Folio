# Verification Evidence Ledger

Every Definition-of-Done item from Section 16 is recorded below with its verified status, proving test file(s), and raw execution log path.

## P0: Core Platform

| Definition-of-Done Item | Status | Proving Test File(s) | Execution Log |
|---|---|---|---|
| Clean install with migrations from an empty database, following the README | **verified** | `tests/integration/platform.test.ts`, `scripts/smoke.ts` | `evidence/logs/20261014-133834-integration-tests.log`, `evidence/logs/20261014-133834-smoke.log` |
| Authentication, sessions, revocation, administrator bootstrap, invite-only mode | **verified** | `tests/integration/platform.test.ts`, `tests/e2e/workflows.test.ts` | `evidence/logs/20261014-133834-integration-tests.log`, `evidence/logs/20261014-133834-e2e-tests.log` |
| Authorization matrix passes for every registered route | **verified** | `tests/integration/platform.test.ts`, `tests/unit/core.test.ts` | `evidence/logs/20261014-133834-integration-tests.log`, `evidence/logs/20261014-133834-unit-tests.log` |
| Capture persists before the job; the job survives a worker restart; retry works | **verified** | `tests/integration/platform.test.ts`, `tests/e2e/workflows.test.ts` | `evidence/logs/20261014-133834-integration-tests.log`, `evidence/logs/20261014-133834-e2e-tests.log` |
| Extraction and sanitization pass the fixture and XSS corpus tests | **verified** | `tests/unit/core.test.ts`, `tests/security/adversarial.test.ts` | `evidence/logs/20261014-133834-unit-tests.log`, `evidence/logs/20261014-133834-security-tests.log` |
| SSRF test suite passes, including rebinding and redirect cases | **verified** | `tests/unit/core.test.ts`, `tests/security/adversarial.test.ts` | `evidence/logs/20261014-133834-unit-tests.log`, `evidence/logs/20261014-133834-security-tests.log` |
| Library, reader, progress, tags, and collections all persist correctly | **verified** | `tests/e2e/workflows.test.ts`, `tests/integration/platform.test.ts` | `evidence/logs/20261014-133834-e2e-tests.log`, `evidence/logs/20261014-133834-integration-tests.log` |
| Full-text search and operators work; the index stays consistent | **verified** | `tests/unit/core.test.ts`, `tests/integration/platform.test.ts`, `tests/e2e/workflows.test.ts` | `evidence/logs/20261014-133834-unit-tests.log`, `evidence/logs/20261014-133834-integration-tests.log` |
| Highlights and notes persist and re-anchor (or become orphaned) correctly | **verified** | `tests/unit/core.test.ts`, `tests/integration/platform.test.ts` | `evidence/logs/20261014-133834-unit-tests.log`, `evidence/logs/20261014-133834-integration-tests.log` |
| Four token-complete themes, with screenshots and contrast checks | **verified** | `tests/unit/core.test.ts`, `tests/e2e/workflows.test.ts`, `scripts/build.ts` | `evidence/logs/20261014-133834-unit-tests.log`, `evidence/logs/20261014-133834-build.log` |
| JSON export/import round-trip | **verified** | `tests/e2e/workflows.test.ts` | `evidence/logs/20261014-133834-e2e-tests.log` |
| Docker Compose deployment files & health/readiness endpoints behave correctly | **verified** | `scripts/smoke.ts`, `Dockerfile`, `compose.yaml` | `evidence/logs/20261014-133834-smoke.log` |
| Lint, typecheck, unit, integration, and P0 end-to-end tests are green; production build passes smoke test | **verified** | `scripts/verify.ts` | `evidence/logs/20261014-133834-lint.log`, `evidence/logs/20261014-133834-typecheck.log`, `evidence/logs/20261014-133834-smoke.log` |
| Benchmarks run at 1,000 and 10,000 articles, with actual row counts reported | **verified** | `benchmark/run.ts`, `benchmark/results/1k-articles.json`, `benchmark/results/10k-articles.json` | `benchmark/report.md` |

## P1: Major Features

| Definition-of-Done Item | Status | Proving Test File(s) | Execution Log |
|---|---|---|---|
| RSS/Atom ingestion against local fixtures (discovery, conditional GET, dedup) | **verified** | `tests/unit/core.test.ts`, `tests/integration/platform.test.ts` | `evidence/logs/20261014-133834-unit-tests.log`, `evidence/logs/20261014-133834-integration-tests.log` |
| PDF workflow (upload, magic-byte check, page text extraction, reader, download) | **verified** | `tests/unit/core.test.ts`, `tests/e2e/workflows.test.ts` | `evidence/logs/20261014-133834-unit-tests.log`, `evidence/logs/20261014-133834-e2e-tests.log` |
| Extension exists, with its real end-to-end status reported | **partial** (unpacked MV3 files + pairing/capture client verified in E2E; live Chromium GUI extension load not run due to sandbox) | `apps/extension/*`, `tests/e2e/workflows.test.ts` | `evidence/logs/20261014-133834-e2e-tests.log` |
| Shared collections: roles, revocation, and audit | **verified** | `tests/integration/platform.test.ts` | `evidence/logs/20261014-133834-integration-tests.log` |
| Offline reading and mutation sync, with conflict handling | **verified** | `tests/unit/core.test.ts`, `tests/integration/platform.test.ts` | `evidence/logs/20261014-133834-unit-tests.log`, `evidence/logs/20261014-133834-integration-tests.log` |
| Command palette | **verified** | `tests/e2e/workflows.test.ts`, `packages/ui/src/index.ts` | `evidence/logs/20261014-133834-e2e-tests.log` |
| Additional import/export formats (CSV, HTML bookmarks, Pocket, OPML) with dry-run | **verified** | `tests/e2e/workflows.test.ts` | `evidence/logs/20261014-133834-e2e-tests.log` |
| Backup and restore tested | **verified** | `tests/integration/platform.test.ts`, `scripts/backup.ts`, `scripts/restore.ts` | `evidence/logs/20261014-133834-integration-tests.log` |
| Diagnostics page (`/api/admin/diagnostics`) | **verified** | `tests/e2e/workflows.test.ts` | `evidence/logs/20261014-133834-e2e-tests.log` |
| Nested collections (with cycle rejection & promote/recursive delete) | **verified** | `tests/e2e/workflows.test.ts` | `evidence/logs/20261014-133834-e2e-tests.log` |
| One measured optimization, with before and after results | **verified** | `benchmark/run.ts`, `benchmark/results/before-optimization-82ae057-1k.json`, `benchmark/results/1k-articles.json` | `benchmark/report.md` |

## P2: Extended Features

| Definition-of-Done Item | Status | Proving Test File(s) | Execution Log |
|---|---|---|---|
| EPUB (spine/TOC parsing, zip-slip/bomb defense, chapter sanitization) | **verified** | `tests/unit/core.test.ts`, `tests/e2e/workflows.test.ts`, `tests/security/adversarial.test.ts` | `evidence/logs/20261014-133834-unit-tests.log`, `evidence/logs/20261014-133834-e2e-tests.log` |
| OCR, or its absence/no-text-layer handled cleanly | **verified** | `tests/unit/core.test.ts` | `evidence/logs/20261014-133834-unit-tests.log` |
| Knowledge graph with explainable recommendations | **verified** | `tests/e2e/workflows.test.ts` | `evidence/logs/20261014-133834-e2e-tests.log` |
| Semantic/hybrid search interface with honest lexical/deterministic fallback | **verified** | `tests/e2e/workflows.test.ts` | `evidence/logs/20261014-133834-e2e-tests.log` |
| Shared annotations in collections | **verified** | `apps/web/src/app.ts`, `tests/integration/platform.test.ts` | `evidence/logs/20261014-133834-integration-tests.log` |
| Optional SMTP configuration | **partial** (configuration contract & privacy policy documented; live SMTP server not configured) | `.env.example`, `docs/privacy.md` | `evidence/logs/20261014-133834-smoke.log` |
| Web Share Target (`/manifest.webmanifest` + `POST /api/share-target`) | **verified** | `apps/web/src/app.ts`, `tests/integration/platform.test.ts` | `evidence/logs/20261014-133834-integration-tests.log` |
| 100,000-article benchmark | **not implemented** (1,000 and 10,000 required benchmarks verified) | N/A | N/A |
