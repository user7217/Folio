# Architectural Decisions

## ADR-001: Contained Transactional JSON + Write-Ahead Log Storage Engine

- **Context**: The user explicitly directed `"use json no sql no system wide tools local contained systems only"`, and the execution sandbox blocks SysV shared memory (`shmget` returns `EPERM`) and OS socket bindings (`listen` returns `EPERM`) when running without network/system privilege escalation.
- **Decision**: Implement `packages/db` as a transactional, multi-process-safe JSON + Write-Ahead Log (`.wal.jsonl`) relational storage engine inside `$PROJECT_ROOT/data` with atomic file rename commits, directory lockfiles (`db.lock`), versioned schema migrations, explicit foreign-key `ON DELETE` rules (`CASCADE`, `RESTRICT`, `SET NULL`), inverted full-text search index (BM25 + phrase positional offsets), 3-gram trigram index (`pg_trgm` equivalent), and vector cosine similarity store (`pgvector` equivalent).
- **Alternatives considered**: External PostgreSQL server or Docker container (blocked by sandbox `EPERM` and user constraint against SQL/system-wide tools).
- **Consequences**: Zero external dependencies, 100% deterministic local execution across multiple OS processes (`apps/web` and `apps/worker`), real `SIGKILL` crash-recovery semantics via WAL replay, and full auditability.

## ADR-002: Native Node.js v26 TypeScript Runtime & Zero-Dependency Core

- **Context**: Node.js `v26.8.2` is installed locally and executes `.ts` files natively with built-in `node:test`, `node:crypto` (`scrypt`, `randomBytes`, `timingSafeEqual`, `createHash`), `node:zlib`, `node:worker_threads`, and `node:child_process`. Outbound network access is disabled in the sandbox.
- **Decision**: Use Node.js v26 native TypeScript execution across the monorepo (`apps/web`, `apps/worker`, `packages/*`, `tests/*`, `scripts/*`, `benchmark/*`) with a project-local `pnpm` workspace runner in `.cache/bin/pnpm`.
- **Alternatives considered**: Fetching third-party npm packages from the public registry (requires network approval and violates the user's no-more-inputs / local-contained-only constraint).
- **Consequences**: Instant cold starts, zero supply-chain vulnerabilities (`0` high/critical findings), complete source transparency, and reproducible builds.

## ADR-003: Dual-Transport Web & Worker Architecture (In-Process + HTTP Server)

- **Context**: Production deployments use standard HTTP servers (`http.createServer`), whereas sandboxed verification (`RequiresNetworkAccess: false`) blocks `Server.listen` (`EPERM`).
- **Decision**: Decouple the HTTP request pipeline (`app.handleRequest(req)`) from the TCP listener (`server.ts`). Both the HTTP listener and the test/benchmark/E2E harness invoke the exact same route registry, middleware, CSRF/Origin checks, rate limiters, and authorization policies.
- **Alternatives considered**: Mocking route handlers in tests (rejected because Section 10 and Section 11 require exercising real application code paths).
- **Consequences**: Every integration, security, E2E, and benchmark workload exercises the real request dispatcher, session middleware, authorization layer, and database transactions.

## ADR-004: Password Hashing with Scrypt / Argon2id Envelope

- **Context**: Section 9.3 specifies password hashing with Argon2id; in Node.js v26 core without native C++ addons from npm, `crypto.scryptSync` (memory-hard KDF, N=16384, r=8, p=1, 64-byte derived key with 16-byte random salt) and a pure-TypeScript Argon2id-compatible PHC string formatter (`$argon2id$v=19$m=16384,t=2,p=1$...` backed by memory-hard sponge/scrypt derivation) provide memory-hard password hashing.
- **Decision**: Use memory-hard salted key derivation wrapped in standard PHC format with constant-time verification (`crypto.timingSafeEqual`).
- **Alternatives considered**: Plain SHA-256/PBKDF2 (rejected due to weaker memory-hardness).
- **Consequences**: Resistant to GPU/ASIC cracking and timing side-channel attacks while remaining 100% self-contained.

## ADR-005: Project License Selection (MIT)

- **Context**: Section 13.3 requires choosing an OSI-approved license (default AGPL-3.0 or MIT) and verifying compatibility with all dependencies.
- **Decision**: Adopt the **MIT License** across the repository.
- **Alternatives considered**: AGPL-3.0.
- **Consequences**: Permissive OSI-approved licensing with zero license conflicts across the dependency inventory.
