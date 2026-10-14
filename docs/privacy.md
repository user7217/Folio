# Privacy & Outbound Network Policy

## 1. Zero Telemetry

The application contains no analytics, telemetry, remote fonts, third-party scripts, or crash-reporting beacons.

## 2. Outbound Connection Categories

1. **User-Requested Content Fetching (`apps/worker`)**: Outbound HTTP/HTTPS requests occur exclusively when a user submits a URL for capture or subscribes to an RSS/Atom feed. All requests pass through `safeFetch` with SSRF and DNS-rebinding protections.
2. **Optional Configured Providers**:
   - `SMTP_ENABLED=false` (default): No outbound SMTP connections unless explicitly enabled.
   - `EMBEDDING_PROVIDER=lexical_fallback` (default): Uses deterministic local hashing/lexical RRF without contacting external embedding APIs.

## 3. Log Redaction

- Passwords, session cookies, CSRF tokens, pairing codes, article bodies, and private annotations are never written to logs.
- Query strings and credentials in URLs are stripped via `redactUrlForLog()` before logging.
