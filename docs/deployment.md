# Deployment & Hardening Guide

## 1. Supported Deployment Targets

- **Supported**: Docker Compose (`compose.yaml`) or bare Node.js (`>=22.6.0`) with persistent local storage (`DATA_DIR`).
- **Not Supported**: Serverless / ephemeral function platforms (incompatible with the long-running background worker and transactional WAL storage).

## 2. Docker Compose Deployment

```bash
docker compose up -d --build
```

- `web` listens on `127.0.0.1:3000` and exposes `/healthz` (liveness) and `/readyz` (readiness: database reachable, schema version current, blob storage writable).
- `worker` runs `node apps/worker/src/worker.ts` sharing the named volume `app_data:/app/data`.
- Both services handle `SIGTERM` gracefully within a 15-second stop grace period.

## 3. Reverse-Proxy Configuration (Nginx)

```nginx
server {
    listen 443 ssl http2;
    server_name reader.example.com;

    client_max_body_size 55M;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }
}
```

## 4. Production Hardening Checklist

- [x] Set `NODE_ENV=production` so session cookies include the `Secure` attribute.
- [x] Set a cryptographically random `SESSION_SECRET` (at least 32 bytes).
- [x] Keep `REGISTRATION_MODE=invite_only` after completing first-run administrator bootstrap.
- [x] Restrict `DATA_DIR` permissions to the application user (`0700` directory, `0600` files).
- [x] Schedule periodic off-host copies of `node scripts/backup.ts` archives.
