import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ReadingPlatformApp } from '../apps/web/src/app.ts';
import { WorkerEngine } from '../apps/worker/src/worker.ts';
import { ContainedDatabase } from '../packages/db/src/index.ts';

const rootDir = process.env.PROJECT_ROOT || '/Users/harsha1/Documents/pocket_clone';
const smokeDataDir = path.join(rootDir, '.cache', `smoke-${process.pid}-${Date.now()}`);

try {
  const db = new ContainedDatabase(smokeDataDir);
  db.migrate();
  const app = new ReadingPlatformApp(db);
  const worker = new WorkerEngine(db, {
    resolver: async () => [{ address: '93.184.216.34', family: 4 }],
    transport: async () => ({
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: Buffer.from(
        '<!DOCTYPE html><html lang="en"><head><title>Smoke Test Article</title></head><body><article><h1>Smoke Verification</h1><p>This article verifies end-to-end production smoke readiness across the reading platform.</p></article></body></html>',
        'utf8'
      ),
    }),
  });

  const health = await app.handleRequest({ method: 'GET', path: '/healthz' });
  assert.equal(health.status, 200);

  const ready = await app.handleRequest({ method: 'GET', path: '/readyz' });
  assert.equal(ready.status, 200);

  const boot = await app.handleRequest({
    method: 'POST',
    path: '/api/auth/bootstrap',
    body: { username: 'smokeadmin', email: 'smoke@example.com', password: 'SmokePassword123!' },
  });
  assert.equal(boot.status, 201);

  const login = await app.handleRequest({
    method: 'POST',
    path: '/api/auth/login',
    body: { email: 'smoke@example.com', password: 'SmokePassword123!' },
  });
  assert.equal(login.status, 200);
  const token = (login.body as { sessionToken: string }).sessionToken;

  const cap = await app.handleRequest({
    method: 'POST',
    path: '/api/items/capture',
    headers: { 'x-session-token': token },
    body: { url: 'https://example.com/smoke-article' },
  });
  assert.equal(cap.status, 201);

  await worker.drainQueue();

  const searchRes = await app.handleRequest({
    method: 'GET',
    path: '/api/search?q=Smoke+Verification',
    headers: { 'x-session-token': token },
  });
  assert.equal(searchRes.status, 200);
  const hits = (searchRes.body as { hits: unknown[] }).hits;
  assert.equal(hits.length, 1);

  console.log(JSON.stringify({ status: 'passed', check: 'smoke', verifiedItems: hits.length }));
} finally {
  fs.rmSync(smokeDataDir, { recursive: true, force: true });
}
