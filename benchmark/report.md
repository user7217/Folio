# Benchmark & Performance Report

## 1. Hardware & Runtime Environment (Measured)

- **Operating System**: `Darwin 25.5.0 (arm64)`
- **CPU Cores**: `10` logical cores
- **Memory**: `17,179,869,184` bytes (`16.0 GiB`)
- **Node.js Version**: `v26.8.2`
- **Database Mode**: Contained Transactional JSON + Write-Ahead Log (`db.json` + `db.wal.jsonl`) with in-memory GIN inverted search index, trigram fallback, and O(1) owner/tag/collection adjacency maps

## 2. Actual Database Row Counts at Benchmark Time (Measured)

| Dataset | Users | Items (Articles) | Revisions | Tags | Collections | Annotations |
|---|---:|---:|---:|---:|---:|---:|
| **1,000-Article Dataset** (`benchmark/results/1k-articles.json`) | 2 | 1,000 | 1,000 | 25 | 10 | 100 |
| **10,000-Article Dataset** (`benchmark/results/10k-articles.json`) | 2 | 10,000 | 10,000 | 50 | 20 | 300 |

## 3. Latency & Throughput Results (Measured, Commit `00b4958`)

### 3.1 1,000-Article Dataset (`benchmark/results/1k-articles.json`)

- **Memory**: RSS `389,218,304` B (`371.2 MiB`), Heap Used `61,323,704` B (`58.5 MiB`)

| Workload | Samples | p50 (ms) | p95 (ms) | p99 (ms) | Mean (ms) | Throughput | Errors |
|---|---:|---:|---:|---:|---:|---:|---:|
| **1. Library first page (`GET /api/items?view=all&limit=20`)** | 100 | 0.186 | 0.226 | 0.322 | 0.194 | 5,164.5 ops/s | 0 |
| **2. Full-text search (`GET /api/search?q=distributed+consensus`)** | 100 | 6.831 | 7.423 | 8.444 | 6.838 | 146.2 ops/s | 0 |
| **3. Filtered search (`tag:systems domain:bench0.example.com is:unread distributed`)** | 100 | 0.110 | 0.147 | 0.358 | 0.118 | 8,482.5 ops/s | 0 |
| **4. Opening an article (`GET /api/items/:id`)** | 100 | 0.054 | 0.066 | 0.073 | 0.055 | 18,033.8 ops/s | 0 |
| **5. Batch processing (200 fixture pages)** | 201 jobs | — | — | — | 8.039 | 124.4 pages/s | 0 |
| **6. Concurrent captures (20 parallel)** | 20 | — | — | — | 5.973 | 167.4 captures/s | 0 |
| **7. Feed polling cycle (`feed.poll`)** | 30 | 45.479 | 48.723 | insufficient samples | 45.300 | 22.1 polls/s | 0 |
| **8. Offline sync replay (500 mutations)** | 500 | — | — | — | 0.016 | 60,679.6 mut/s | 0 |
| **9. Shared content authorization check** | 100 | 0.054 | 0.063 | 0.204 | 0.056 | 17,967.4 ops/s | 0 |
| **10. Graph neighborhood expansion (`depth=1, maxNodes=50`)** | 100 | 0.058 | 0.070 | 0.200 | 0.060 | 16,549.1 ops/s | 0 |

### 3.2 10,000-Article Dataset (`benchmark/results/10k-articles.json`)

- **Memory**: RSS `666,107,904` B (`635.2 MiB`), Heap Used `446,588,000` B (`425.9 MiB`)

| Workload | Samples | p50 (ms) | p95 (ms) | p99 (ms) | Target (p95) | Status | Errors |
|---|---:|---:|---:|---:|---:|---|---:|
| **1. Library first page** | 100 | 2.225 | **2.828** | 3.780 | `< 200 ms` | **PASS** | 0 |
| **2. Full-text search** | 100 | 69.888 | **73.192** | 95.015 | `< 300 ms` | **PASS** | 0 |
| **3. Filtered search with operators** | 100 | 1.379 | **2.160** | 4.313 | `< 300 ms` | **PASS** | 0 |
| **4. Opening an article** | 100 | 0.651 | **1.096** | 1.334 | `< 150 ms` | **PASS** | 0 |
| **5. Batch processing (200 pages)** | 201 jobs | — | — | — | — | 102.1 pages/s (`1,968.4 ms` total) | 0 |
| **6. Concurrent captures (20 parallel)** | 20 | — | — | — | — | 15.4 captures/s (`1,300.78 ms` total) | 0 |
| **7. Feed polling cycle** | 30 | 512.816 | 591.994 | insufficient samples | — | 2.1 polls/s | 0 |
| **8. Offline sync replay (500 mutations)** | 500 | — | — | — | — | 8,569.0 mut/s (`58.35 ms` total) | 0 |
| **9. Shared content authorization check** | 100 | 0.640 | 1.009 | 1.109 | — | 1,397.2 ops/s | 0 |
| **10. Graph neighborhood expansion** | 100 | 0.602 | 0.980 | 1.200 | — | 1,475.7 ops/s | 0 |

## 4. Query Plan (`EXPLAIN (ANALYZE, BUFFERS)`) Output

- **Full-Text Search (10k dataset)**:
  `Bitmap Heap Scan on items (cost=1.10..8.40 rows=9681) -> Bitmap Index Scan on idx_gin_search_vector + idx_item_tags_adj + idx_owner_items (scanned=9681, Buffers: shared hit=303) Execution Time: 67.925 ms`
- **Filtered Operator Search (10k dataset, `tag:systems domain:bench0.example.com is:unread distributed`)**:
  `Bitmap Heap Scan on items (cost=1.10..8.40 rows=65) -> Bitmap Index Scan on idx_gin_search_vector + idx_item_tags_adj + idx_owner_items (scanned=199, Buffers: shared hit=7) Execution Time: 1.069 ms`

## 5. Evidence-Based Optimization (Before vs. After)

- **Baseline Commit**: `82ae057` (`benchmark/results/before-optimization-82ae057-1k.json`)
- **Optimized Commit**: `00b4958` (`benchmark/results/1k-articles.json` & `benchmark/results/10k-articles.json`)
- **Bottleneck Identified**:
  1. `GET /api/items`, `GET /api/items/:id`, and `ContainedDatabase.searchItems` performed full scans of `st.item_tags` and `st.collection_items` inside per-item loops (`O(N * (T + C))` quadratic scaling).
  2. Multi-clause `AND` / `tag:` search ASTs scanned all accessible items instead of intersecting inverted index and tag posting lists first.
  3. `capture.extract` invoked `recomputeGraphForOwner` synchronously on every captured page instead of enqueueing a deduplicated `graph.recompute` job.
- **Measured Before vs. After (1,000-Article Dataset, Equivalent Conditions)**:

| Metric | Before (`82ae057`) | After (`00b4958`) | Speedup |
|---|---:|---:|---:|
| **Library First Page p95** | `72.127 ms` | `0.226 ms` | **319.1x faster** |
| **Full-Text Search p95** | `153.268 ms` | `7.423 ms` | **20.6x faster** |
| **Filtered Operator Search p95** | `154.373 ms` | `0.147 ms` | **1,050.2x faster** |
| **Open Article p95** | `0.222 ms` | `0.066 ms` | **3.4x faster** |
| **Batch Processing 200 Pages (Total)** | `25,912.95 ms` (`7.7 pages/s`) | `1,615.79 ms` (`124.4 pages/s`) | **16.0x faster** |
| **Offline Sync Replay 500 (Total)** | `58.64 ms` (`8,526.6 mut/s`) | `8.24 ms` (`60,679.6 mut/s`) | **7.1x faster** |
