# Testing & Accessibility Verification

## 1. Unified Verification (`pnpm verify`)

`pnpm verify` executes `scripts/verify.ts`, running all 9 verification stages and saving raw logs to `evidence/logs/<YYYYMMDD-HHMMSS>-<step>.log`:

1. `lint` (`scripts/lint.ts`)
2. `format:check` (`scripts/format-check.ts`)
3. `typecheck` (`scripts/typecheck.ts`)
4. `unit-tests` (`tests/unit/core.test.ts`)
5. `integration-tests` (`tests/integration/platform.test.ts`)
6. `e2e-tests` (`tests/e2e/workflows.test.ts`)
7. `security-tests` (`tests/security/adversarial.test.ts`)
8. `build` (`scripts/build.ts`)
9. `smoke` (`scripts/smoke.ts`)

## 2. Accessibility & Keyboard Flows Recorded

- Automated WCAG 2.2 AA contrast checks pass on all 4 themes (`Editorial Light`, `Midnight AMOLED`, `Swiss Minimal`, `Soft Sepia`) for primary, secondary, muted, elevated, accent, focus-ring, and highlight tokens.
- Semantic HTML landmarks (`<main id="main-content">`, `<nav aria-label="...">`, `<h1>`), explicit `<label for="...">` bindings on inputs, `role="dialog" aria-modal="true"` on the Command Palette, and `role="alert"` on error states are verified across all rendered screens.
