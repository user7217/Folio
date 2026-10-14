# Benchmarking & Performance Optimization

See `benchmark/methodology.md` and `benchmark/report.md` for full methodology and raw percentile tables.

## Summary of 10,000-Article Benchmark (Commit `00b4958`)

- **Library First Page (`GET /api/items?view=all&limit=20`)**: `p50 = 2.225 ms`, `p95 = 2.828 ms`, `p99 = 3.780 ms` (Target `< 200 ms` — **PASS**)
- **Full-Text Search (`GET /api/search?q=distributed+consensus`)**: `p50 = 69.888 ms`, `p95 = 73.192 ms`, `p99 = 95.015 ms` (Target `< 300 ms` — **PASS**)
- **Filtered Operator Search**: `p50 = 1.379 ms`, `p95 = 2.160 ms`, `p99 = 4.313 ms` (Target `< 300 ms` — **PASS**)
- **Opening an Article (`GET /api/items/:id`)**: `p50 = 0.651 ms`, `p95 = 1.096 ms`, `p99 = 1.334 ms` (Target `< 150 ms` — **PASS**)
