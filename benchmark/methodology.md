# Benchmark Methodology

## 1. Environment & Isolation

- **Hardware**: Apple Silicon ARM64 (`Darwin 25.5.0`), 10 logical CPUs, 16.0 GiB RAM (`17,179,869,184` bytes).
- **Runtime**: Node.js `v26.8.2` (native TypeScript execution).
- **Storage Mode**: Contained Transactional JSON + Write-Ahead Log (`db.json` + `db.wal.jsonl`) with atomic rename commits and in-memory secondary indexes (`idx_gin_search_vector`, `idx_item_tags_adj`, `idx_owner_items`).
- **Network Isolation**: Zero external network requests. All HTTP routes, worker extractions, and RSS polls execute against deterministic local fixtures.

## 2. Seeded Dataset Generation

`benchmark/run.ts` uses a Mulberry32 PRNG seeded with `seed = 42` to generate deterministic datasets:

- **1,000-Article Dataset**: 2 users, 1,000 articles (120 words each), 1,000 content revisions, 25 tags, 10 collections, 100 annotations.
- **10,000-Article Dataset**: 2 users, 10,000 articles (120 words each), 10,000 content revisions, 50 tags, 20 collections, 300 annotations.

Actual row counts are queried directly from the database state immediately prior to running workloads.

## 3. Measurement Protocol

1. **Warm-up**: 5 unmeasured warm-up iterations precede latency measurements on each dataset.
2. **Sample Counts**:
   - Read, search, authorization, and graph workloads execute **100 measured repetitions** each (enabling statistically valid `p50`, `p95`, and `p99` reporting).
   - Feed polling executes **30 measured repetitions** (`p50` and `p95` reported; `p99` labelled `"insufficient samples"` per Section 11.4).
3. **Code Paths**: Every workload invokes `ReadingPlatformApp.handleRequest()` or `WorkerEngine.processNextJob()`, exercising the production route registry, session authenticator, authorization policy, and database engine.
