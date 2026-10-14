# Threat Model & Security Controls

## 1. Assets & Trust Boundaries

### Assets
- User credentials (Argon2id/scrypt PHC password hashes), session tokens, CSRF tokens, invitation codes, and extension pairing tokens.
- Private user library items, reading progress, personal tags, private annotations/notes, and export archives.
- Shared collection memberships and role grants (`owner`, `editor`, `viewer`).
- Host filesystem, internal loopback/RFC1918 networks, and cloud metadata endpoints.

### Trust Boundaries
1. **Browser / Extension <-> Web Server (`apps/web`)**: Untrusted HTTP requests validated via route registry policies, rate limiters, request-size limits, and CSRF/Origin checks.
2. **Worker Fetcher (`apps/worker`) <-> Untrusted Upstream Sites/Feeds**: Untrusted URLs, DNS responses, HTTP redirects, compressed bodies, HTML/XML/PDF/EPUB payloads.
3. **Multi-User Boundary**: Strict per-request ownership and collection-membership predicates; non-sequential UUIDv7 identifiers; 404 responses for unauthorized private resources to prevent existence enumeration.

## 2. Threats, Mitigations, and Verification Tests

| Threat | Mitigation | Covering Test File(s) |
|---|---|---|
| **Server-Side Request Forgery (SSRF) & DNS Rebinding** | Single canonical URL parser (`parseAndNormalizeUrl`); blocks loopback, RFC1918, link-local (`169.254.0.0/16`), CGNAT, multicast, broadcast, IPv6 ULA/link-local/mapped/NAT64/6to4/Teredo, decimal/octal/hex/shortened IPv4 literals, and cloud metadata hostnames; DNS resolve-and-pin validates all resolved IPs and pins connection; revalidates every redirect hop (max 5). | `tests/unit/core.test.ts`, `tests/security/adversarial.test.ts` |
| **Stored Cross-Site Scripting (XSS) in Reader / Snippets** | Server-side allowlist sanitizer (`sanitizeHtml`) strips `<script>`, `<svg>`, `<math>`, `<iframe>`, `<style>`, `<form>`, `on*` attributes, and `javascript:`/`data:`/`file:` URIs; enforces `rel="noopener noreferrer"`; strict response `Content-Security-Policy`. | `tests/unit/core.test.ts`, `tests/security/adversarial.test.ts` |
| **Broken Access Control / IDOR / Cross-User Leakage** | Central `can(actor, policy, resource)` module; `ROUTE_REGISTRY` policy enforcement on every route; generated authorization matrix across 5 identities; search, graph, export, and recommendations filter strictly by `canUserReadItem`. | `tests/integration/platform.test.ts`, `tests/security/adversarial.test.ts` |
| **XML External Entities (XXE) & Hostile Feeds** | `parseFeedXml` rejects `<!ENTITY` and `<!DOCTYPE ... SYSTEM` declarations and enforces a 5 MB byte cap. | `tests/unit/core.test.ts`, `tests/security/adversarial.test.ts` |
| **Decompression Bombs, Zip-Slip, & Malformed Archives** | Streaming byte caps in `safeFetch`, `maxOutputLength` on gzip/deflate/brotli decompression, magic-byte checks (`%PDF-`, `PK\x03\x04`), entry-count caps, and `..`/absolute path rejection in `extractZipSafely`. | `tests/unit/core.test.ts`, `tests/security/adversarial.test.ts` |
| **Blob & Backup Path Traversal** | `FilesystemBlobStore` requires strict UUIDv7 format and verifies resolved path stays inside `DATA_DIR/blobs`; backups written with `0o600` permissions and SHA-256 manifest verification. | `tests/security/adversarial.test.ts`, `tests/integration/platform.test.ts` |
| **CSRF, Session Fixation, & Credential Brute Force** | Session rotation at login; `HttpOnly; SameSite=Lax` cookies; Origin and `X-CSRF-Token` verification on state-mutating session requests; per-route rate limiting (`429`). | `tests/integration/platform.test.ts`, `tests/security/adversarial.test.ts` |

## 3. Supply-Chain & Dependency Audit

- Zero third-party runtime npm packages are installed; the platform runs exclusively on Node.js `v26.8.2` built-in modules.
- **High / Critical Vulnerabilities**: `0`.
