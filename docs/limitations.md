# Known Limitations & Environmental Constraints

1. **Sandbox Socket & SysV Shared Memory Restrictions**:
   - The execution sandbox blocks OS TCP/Unix socket `listen()` (`EPERM`) and SysV `shmget()` (`EPERM`), and the user explicitly instructed `"use json no sql no system wide tools local contained systems only"`.
   - Accordingly, `packages/db` implements a contained transactional JSON + WAL storage engine rather than connecting to an external PostgreSQL daemon, and E2E/integration suites invoke the HTTP application pipeline in-process while spawning real OS child processes for `apps/worker` crash-recovery tests.
2. **Playwright Headless Browser & Unpacked Extension**:
   - Because external browser binary downloads and socket bindings are blocked in the sandbox, E2E verification exercises the full SSR HTML/CSS output, accessibility rules, PNG theme snapshot renderer, and `ExtensionCaptureClient` protocol in-process. Loading the unpacked MV3 extension inside a live GUI Chromium window is reported as **not run in sandbox** (per Section 10).
3. **100,000-Article P2 Benchmark**:
   - Benchmarks were executed and verified at **1,000** and **10,000** articles (all P0/P1 requirements). The optional P2 100,000-article dataset was not run.
