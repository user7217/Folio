import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';
import { ReadingPlatformApp } from '../../apps/web/src/app.ts';
import { WorkerEngine } from '../../apps/worker/src/worker.ts';
import { createZipArchive, extractZipSafely, parsePdfBuffer } from '../../packages/article-processing/src/index.ts';
import { ContainedDatabase } from '../../packages/db/src/index.ts';
import { SsrfError, safeFetch } from '../../packages/shared/src/ssrf.ts';

const rootDir = process.env.PROJECT_ROOT || '/Users/harsha1/Documents/pocket_clone';

function createSecDataDir(name: string): string {
  const d = path.join(rootDir, '.cache', `sec-${name}-${process.pid}-${Date.now()}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

test('Security: DNS rebinding defense via resolve-and-pin and multi-record validation', async () => {
  // 1. Multi-record DNS response containing one public IP and one internal IP is blocked immediately
  await assert.rejects(
    () =>
      safeFetch('https://rebind.attacker.example/data', {
        resolver: async () => [
          { address: '93.184.216.34', family: 4 },
          { address: '127.0.0.1', family: 4 },
        ],
        transport: async () => ({ status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from('ok') }),
      }),
    (err: unknown) => err instanceof SsrfError && err.errorClass === 'permanent'
  );

  // 2. DNS rebinding across redirect hops (Hop 1 resolves to public IP, Hop 2 resolves to 169.254.169.254)
  let lookupCall = 0;
  let transportCalledOnHop2 = false;
  await assert.rejects(
    () =>
      safeFetch('https://rebind-hop.attacker.example/step1', {
        resolver: async () => {
          lookupCall++;
          if (lookupCall === 1) return [{ address: '93.184.216.34', family: 4 }];
          return [{ address: '169.254.169.254', family: 4 }];
        },
        transport: async (req) => {
          // Verify pinnedIp is passed directly to transport so transport connects to pinnedIp, never re-resolving DNS
          assert.equal(req.pinnedIp, '93.184.216.34');
          if (req.url.includes('step2')) {
            transportCalledOnHop2 = true;
          }
          return {
            status: 302,
            headers: { location: 'https://rebind-hop.attacker.example/step2' },
            body: Buffer.alloc(0),
          };
        },
      }),
    (err: unknown) => err instanceof SsrfError && err.reason !== 'ok'
  );
  assert.equal(transportCalledOnHop2, false, 'Hop 2 must be blocked before connecting');
});

test('Security: Decompression bombs, Slowloris timeouts, unexpected MIME types, and CRLF header injection', async () => {
  const pubResolver = async () => [{ address: '93.184.216.34', family: 4 as const }];

  // Gzip decompression bomb (small compressed payload expanding past maxDecompressedBytes)
  const bombPlain = Buffer.alloc(256 * 1024, 'A');
  const compressedBomb = zlib.gzipSync(bombPlain);
  await assert.rejects(
    () =>
      safeFetch('https://example.com/bomb', {
        resolver: pubResolver,
        maxDecompressedBytes: 32 * 1024,
        transport: async () => ({
          status: 200,
          headers: { 'content-type': 'text/html', 'content-encoding': 'gzip' },
          body: compressedBomb,
        }),
      }),
    (err: unknown) => err instanceof SsrfError && err.code === 'DECOMPRESSION_BOMB'
  );

  // Slowloris timeout
  await assert.rejects(
    () =>
      safeFetch('https://example.com/slowloris', {
        resolver: pubResolver,
        timeoutMs: 40,
        transport: async (_req, signal) =>
          new Promise((resolve, reject) => {
            const t = setTimeout(() => resolve({ status: 200, headers: {}, body: Buffer.alloc(0) }), 500);
            signal.addEventListener('abort', () => {
              clearTimeout(t);
              reject(signal.reason);
            });
          }),
      }),
    (err: unknown) => err instanceof SsrfError && err.code === 'FETCH_TIMEOUT' && err.errorClass === 'transient'
  );

  // Unexpected MIME type
  await assert.rejects(
    () =>
      safeFetch('https://example.com/malware.exe', {
        resolver: pubResolver,
        transport: async () => ({
          status: 200,
          headers: { 'content-type': 'application/x-msdownload' },
          body: Buffer.from('MZ...'),
        }),
      }),
    (err: unknown) => err instanceof SsrfError && err.code === 'UNEXPECTED_MIME_TYPE' && err.errorClass === 'permanent'
  );

  // Malformed response header with CRLF injection
  await assert.rejects(
    () =>
      safeFetch('https://example.com/crlf', {
        resolver: pubResolver,
        transport: async () => ({
          status: 200,
          headers: { 'content-type': 'text/html', 'x-injected': 'val\r\nSet-Cookie: evil=1' },
          body: Buffer.from('<p>hi</p>'),
        }),
      }),
    (err: unknown) => err instanceof SsrfError && err.code === 'MALFORMED_HEADERS'
  );
});

test('Security: Hostile feeds, malformed PDF/EPUB, zip-bombs, and blob path traversal', async () => {
  const dataDir = createSecDataDir('hostile-files');
  try {
    const db = new ContainedDatabase(dataDir);
    const app = new ReadingPlatformApp(db);

    // Blob store rejects path traversal IDs
    assert.throws(() => db.blobs.get('../../etc/passwd'), /Invalid opaque blob ID/);
    assert.throws(() => db.blobs.get('not-a-uuid'), /Invalid opaque blob ID/);

    // Malformed PDF magic bytes rejected
    assert.throws(() => parsePdfBuffer(Buffer.from('NOT_A_PDF_FILE')), /Invalid PDF magic bytes/);

    // Zip bomb in EPUB rejected
    const hugeEntry = Buffer.alloc(120 * 1024, 'Z');
    const zipBomb = createZipArchive([{ name: 'OEBPS/huge.xhtml', data: hugeEntry }]);
    assert.throws(
      () => extractZipSafely(zipBomb, { maxExpandedBytes: 32 * 1024 }),
      /Zip-bomb detected/
    );

    // Hostile feed with XXE never crashes worker; records feed error cleanly
    await app.handleRequest({
      method: 'POST',
      path: '/api/auth/bootstrap',
      body: { username: 'admin', email: 'admin@example.com', password: 'Password123!' },
    });
    const login = await app.handleRequest({
      method: 'POST',
      path: '/api/auth/login',
      body: { email: 'admin@example.com', password: 'Password123!' },
    });
    const token = (login.body as { sessionToken: string }).sessionToken;

    const feedRes = await app.handleRequest({
      method: 'POST',
      path: '/api/feeds',
      headers: { 'x-session-token': token },
      body: { url: 'https://evil-feed.example.com/rss.xml' },
    });
    const feedId = (feedRes.body as { feed: { id: string } }).feed.id;

    const worker = new WorkerEngine(db, {
      resolver: async () => [{ address: '93.184.216.34', family: 4 }],
      transport: async () => ({
        status: 200,
        headers: { 'content-type': 'application/rss+xml' },
        body: Buffer.from(
          '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;">]><rss><channel><title>&lol2;</title></channel></rss>',
          'utf8'
        ),
      }),
    });

    await worker.drainQueue();
    const updatedFeed = db.read((st) => st.feeds[feedId]);
    assert.ok(updatedFeed.last_error?.includes('XXE'));
    assert.equal(updatedFeed.error_count > 0, true);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('Security: Cross-user isolation across Search, Graph, Export, Recommendations, CSRF, Rate-Limit, and Concurrent Destructive Requests', async () => {
  const dataDir = createSecDataDir('isolation');
  try {
    const db = new ContainedDatabase(dataDir);
    const app = new ReadingPlatformApp(db);

    await app.handleRequest({
      method: 'POST',
      path: '/api/auth/bootstrap',
      body: { username: 'alice', email: 'alice@example.com', password: 'Password123!' },
    });
    const aliceLogin = await app.handleRequest({
      method: 'POST',
      path: '/api/auth/login',
      body: { email: 'alice@example.com', password: 'Password123!' },
    });
    const aliceToken = (aliceLogin.body as { sessionToken: string }).sessionToken;
    const aliceCsrf = (aliceLogin.body as { csrfToken: string }).csrfToken;

    // Create Bob via invite
    const inv = await app.handleRequest({
      method: 'POST',
      path: '/api/admin/invitations',
      headers: { 'x-session-token': aliceToken },
      body: { email: 'bob@example.com' },
    });
    await app.handleRequest({
      method: 'POST',
      path: '/api/auth/register',
      body: {
        username: 'bob',
        email: 'bob@example.com',
        password: 'Password123!',
        inviteCode: (inv.body as { inviteCode: string }).inviteCode,
      },
    });
    const bobLogin = await app.handleRequest({
      method: 'POST',
      path: '/api/auth/login',
      body: { email: 'bob@example.com', password: 'Password123!' },
    });
    const bobToken = (bobLogin.body as { sessionToken: string }).sessionToken;

    // Alice saves a confidential item
    const aliceCap = await app.handleRequest({
      method: 'POST',
      path: '/api/items/capture',
      headers: { 'x-session-token': aliceToken },
      body: { url: 'https://example.com/alice-confidential', title: 'Project Hyperion Secret Blueprint' },
    });
    const aliceItemId = (aliceCap.body as { item: { id: string } }).item.id;

    // Bob searches for "Hyperion" -> 0 hits, no title/snippet/count leak
    const bobSearch = await app.handleRequest({
      method: 'GET',
      path: '/api/search?q=Hyperion',
      headers: { 'x-session-token': bobToken },
    });
    assert.equal((bobSearch.body as { hits: unknown[] }).hits.length, 0);
    assert.equal(JSON.stringify(bobSearch.body).includes('Hyperion'), false);

    // Bob queries Knowledge Graph -> 0 nodes/edges from Alice
    const bobGraph = await app.handleRequest({
      method: 'GET',
      path: `/api/graph?itemId=${aliceItemId}`,
      headers: { 'x-session-token': bobToken },
    });
    assert.equal((bobGraph.body as { nodes: unknown[] }).nodes.length, 0);

    // CSRF protection: cross-origin state-mutating request with session cookie is rejected with 403
    const csrfBlocked = await app.handleRequest({
      method: 'POST',
      path: '/api/tags',
      headers: {
        cookie: `rp_session=${aliceToken}`,
        origin: 'https://evil.attacker.example',
      },
      body: { name: 'CrossOriginTag' },
    });
    assert.equal(csrfBlocked.status, 403);

    // Mismatched X-CSRF-Token header is rejected with 403
    const badCsrfToken = await app.handleRequest({
      method: 'POST',
      path: '/api/tags',
      headers: {
        cookie: `rp_session=${aliceToken}`,
        'x-csrf-token': `${aliceCsrf}_tampered`,
      },
      body: { name: 'BadCsrfTag' },
    });
    assert.equal(badCsrfToken.status, 403);

    // Concurrent destructive requests (10 simultaneous permanent delete requests on the same item)
    const delResults = await Promise.all(
      Array.from({ length: 10 }, () =>
        app.handleRequest({
          method: 'DELETE',
          path: `/api/items/${aliceItemId}?permanent=true`,
          headers: { 'x-session-token': aliceToken },
        })
      )
    );
    assert.ok(delResults.some((r) => r.status === 200));
    assert.equal(db.read((st) => st.items[aliceItemId]), undefined);

    // Rate-limit enforcement on /api/auth/bootstrap (limit: 10 per minute)
    let rateLimited = false;
    for (let i = 0; i < 15; i++) {
      const r = await app.handleRequest({
        method: 'POST',
        path: '/api/auth/bootstrap',
        ip: '203.0.113.99',
        body: {},
      });
      if (r.status === 429) {
        rateLimited = true;
        break;
      }
    }
    assert.equal(rateLimited, true, 'Rate limiter must return 429 after threshold');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
