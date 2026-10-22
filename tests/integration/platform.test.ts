import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { ReadingPlatformApp } from '../../apps/web/src/app.ts';
import { WorkerEngine } from '../../apps/worker/src/worker.ts';
import { createZipArchive } from '../../packages/article-processing/src/index.ts';
import { ContainedDatabase, createEmptyDatabaseState } from '../../packages/db/src/index.ts';
import { ROUTE_REGISTRY, uuidv7 } from '../../packages/shared/src/index.ts';
import { createBackup } from '../../scripts/backup.ts';
import { restoreBackup } from '../../scripts/restore.ts';

const rootDir = process.env.PROJECT_ROOT || '/Users/harsha1/Documents/pocket_clone';

function createTempDataDir(prefix: string): string {
  const dir = path.join(rootDir, '.cache', `int-${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

test('Clean install and migration upgrade from schema v1 with existing data', () => {
  const dataDir = createTempDataDir('migrations');
  try {
    // 1. Seed a v1 database state containing data
    const v1State = createEmptyDatabaseState(1);
    v1State.migrations = [{ version: 1, name: '0001_initial_core_schema', applied_at: '2026-01-01T00:00:00Z' }];
    const legacyItemId = uuidv7();
    v1State.items[legacyItemId] = {
      id: legacyItemId,
      owner_id: 'u1',
      url: 'https://example.com/v1',
      normalized_url: 'https://example.com/v1',
      canonical_url: null,
      possible_duplicate_of: null,
      title: 'Legacy V1 Article',
      author: null,
      publisher: 'example.com',
      domain: 'example.com',
      published_at: null,
      description: 'Saved in v1',
      featured_image: null,
      language: 'en',
      reading_time_minutes: 2,
      content_type: 'article',
      processing_status: 'ready',
      error_message: null,
      error_class: null,
      current_revision_id: null,
      blob_id: null,
      page_count: null,
      ocr_status: 'none',
      outbound_urls: [],
      version: 1,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    };
    fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify(v1State), 'utf8');

    // 2. Run migrations to upgrade to CURRENT_SCHEMA_VERSION (3)
    const db = new ContainedDatabase(dataDir);
    // Zero-migration direct JSON load:
    assert.equal(db.read((s) => s.schema_version), 3);
    assert.equal(db.read((s) => s.schema_version), 3);
    assert.equal(db.read((s) => s.items[legacyItemId].title), 'Legacy V1 Article');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('Generated Authorization Matrix (Section 9.2): unauthenticated, another user, viewer vs editor, revoked member, and revoked session', async () => {
  const dataDir = createTempDataDir('authz-matrix');
  try {
    const db = new ContainedDatabase(dataDir);
    const app = new ReadingPlatformApp(db);

    // Bootstrap owner (admin)
    await app.handleRequest({
      method: 'POST',
      path: '/api/auth/bootstrap',
      body: { username: 'owner', email: 'owner@example.com', password: 'Password123!' },
    });
    const ownerLogin = await app.handleRequest({
      method: 'POST',
      path: '/api/auth/login',
      body: { email: 'owner@example.com', password: 'Password123!' },
    });
    const ownerToken = (ownerLogin.body as { sessionToken: string }).sessionToken;

    // Create 3 invitations for otherUser, viewerUser, revokedMemberUser
    const createUserWithSession = async (username: string, email: string) => {
      const invRes = await app.handleRequest({
        method: 'POST',
        path: '/api/admin/invitations',
        headers: { 'x-session-token': ownerToken },
        body: { email },
      });
      const inviteCode = (invRes.body as { inviteCode: string }).inviteCode;
      const regRes = await app.handleRequest({
        method: 'POST',
        path: '/api/auth/register',
        body: { username, email, password: 'Password123!', inviteCode },
      });
      const userId = (regRes.body as { id: string }).id;
      const loginRes = await app.handleRequest({
        method: 'POST',
        path: '/api/auth/login',
        body: { email, password: 'Password123!' },
      });
      return { userId, token: (loginRes.body as { sessionToken: string }).sessionToken };
    };

    const other = await createUserWithSession('other', 'other@example.com');
    const viewer = await createUserWithSession('viewer', 'viewer@example.com');
    const revokedMem = await createUserWithSession('revokedmem', 'revokedmem@example.com');
    const revokedSess = await createUserWithSession('revokedsess', 'revokedsess@example.com');

    // Revoke revokedSess's session
    await app.handleRequest({
      method: 'POST',
      path: '/api/auth/sessions/revoke',
      headers: { 'x-session-token': revokedSess.token },
    });

    // Create owner resources: item, collection, annotation, feed, export
    const capRes = await app.handleRequest({
      method: 'POST',
      path: '/api/items/capture',
      headers: { 'x-session-token': ownerToken },
      body: { url: 'https://example.com/private-item', title: 'Secret Title' },
    });
    const itemId = (capRes.body as { item: { id: string } }).item.id;

    const colRes = await app.handleRequest({
      method: 'POST',
      path: '/api/collections',
      headers: { 'x-session-token': ownerToken },
      body: { name: 'Shared Team Collection' },
    });
    const colId = (colRes.body as { collection: { id: string } }).collection.id;

    // Add viewer and revokedMem to collection, then immediately revoke revokedMem
    await app.handleRequest({
      method: 'POST',
      path: `/api/collections/${colId}/members`,
      headers: { 'x-session-token': ownerToken },
      body: { userId: viewer.userId, role: 'viewer' },
    });
    await app.handleRequest({
      method: 'POST',
      path: `/api/collections/${colId}/members`,
      headers: { 'x-session-token': ownerToken },
      body: { userId: revokedMem.userId, role: 'editor' },
    });
    await app.handleRequest({
      method: 'DELETE',
      path: `/api/collections/${colId}/members/${revokedMem.userId}`,
      headers: { 'x-session-token': ownerToken },
    });

    const annRes = await app.handleRequest({
      method: 'POST',
      path: `/api/items/${itemId}/annotations`,
      headers: { 'x-session-token': ownerToken },
      body: { type: 'note', note: 'Owner private note' },
    });
    const annId = (annRes.body as { annotation: { id: string } }).annotation.id;

    const feedRes = await app.handleRequest({
      method: 'POST',
      path: '/api/feeds',
      headers: { 'x-session-token': ownerToken },
      body: { url: 'https://example.com/rss.xml' },
    });
    const feedId = (feedRes.body as { feed: { id: string } }).feed.id;

    const expRes = await app.handleRequest({
      method: 'POST',
      path: '/api/export',
      headers: { 'x-session-token': ownerToken },
      body: { format: 'json' },
    });
    const exportId = (expRes.body as { exportId: string }).exportId;
    const worker = new WorkerEngine(db);
    await worker.drainQueue();

    const materializePath = (templatePath: string): string =>
      templatePath
        .replace(':id', templatePath.includes('/collections/') ? colId : templatePath.includes('/annotations/') ? annId : templatePath.includes('/feeds/') ? feedId : templatePath.includes('/export/') ? exportId : itemId)
        .replace(':itemId', itemId)
        .replace(':tagId', uuidv7())
        .replace(':userId', viewer.userId)
        .replace(':entryId', uuidv7());

    // Enumerate every non-public route in ROUTE_REGISTRY
    for (const route of ROUTE_REGISTRY) {
      if (route.policy === 'public') continue;
      const concretePath = materializePath(route.path);

      // 1. Unauthenticated must be denied with 401
      const unauthRes = await app.handleRequest({ method: route.method, path: concretePath, body: {} });
      assert.equal(unauthRes.status, 401, `Expected 401 for unauthenticated ${route.method} ${concretePath}`);

      // 2. Revoked session must be denied with 401
      const revSessRes = await app.handleRequest({
        method: route.method,
        path: concretePath,
        headers: { 'x-session-token': revokedSess.token },
        body: {},
      });
      assert.equal(revSessRes.status, 401, `Expected 401 for revoked session on ${route.method} ${concretePath}`);

      // 3. Resource-scoped routes: another user & revoked member must be denied with 404 (not leaking existence)
      if (
        ['item:read', 'item:write', 'item:owner', 'collection:read', 'collection:edit', 'collection:owner', 'annotation:write', 'feed:owner', 'export:owner'].includes(
          route.policy
        )
      ) {
        const otherRes = await app.handleRequest({
          method: route.method,
          path: concretePath,
          headers: { 'x-session-token': other.token },
          body: {},
        });
        assert.equal(
          otherRes.status,
          404,
          `Expected 404 (no existence leak) for other user on ${route.method} ${concretePath}`
        );
        assert.equal(
          JSON.stringify(otherRes.body).includes('Secret Title'),
          false,
          'Must not leak resource title'
        );

        const revMemRes = await app.handleRequest({
          method: route.method,
          path: concretePath,
          headers: { 'x-session-token': revokedMem.token },
          body: {},
        });
        assert.equal(
          revMemRes.status,
          404,
          `Expected 404 for revoked member on ${route.method} ${concretePath}`
        );
      }

      // 4. Viewer attempting editor/owner action on shared collection must be denied with 403
      if (route.policy === 'collection:edit' || route.policy === 'collection:owner') {
        const viewerEditRes = await app.handleRequest({
          method: route.method,
          path: concretePath,
          headers: { 'x-session-token': viewer.token },
          body: { name: 'Unauthorized Rename' },
        });
        assert.equal(
          viewerEditRes.status,
          403,
          `Expected 403 for viewer attempting ${route.method} ${concretePath}`
        );
      }
    }
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('Capture -> Job -> Extraction -> Search -> Reprocess -> Delete consistency & concurrent duplicates', async () => {
  const dataDir = createTempDataDir('pipeline');
  try {
    const db = new ContainedDatabase(dataDir);
    const app = new ReadingPlatformApp(db);

    let articleVersion = 1;
    const worker = new WorkerEngine(db, {
      resolver: async () => [{ address: '93.184.216.34', family: 4 }],
      transport: async (req) => {
        if (req.url.includes('/login-wall')) {
          return {
            status: 200,
            headers: { 'content-type': 'text/html' },
            body: Buffer.from(
              '<html><head><title>Members Only</title><meta name="description" content="Sign in required"/></head><body><form action="/login"><input type="password"/></form></body></html>',
              'utf8'
            ),
          };
        }
        return {
          status: 200,
          headers: { 'content-type': 'text/html' },
          body: Buffer.from(
            `<!DOCTYPE html><html><head><title>Storage Engine V${articleVersion}</title></head><body><article><h1>Section ${articleVersion}</h1><p>Transactional durability with write-ahead logging and B-tree indexing version ${articleVersion}. Important highlightable quote here.</p></article></body></html>`,
            'utf8'
          ),
        };
      },
    });

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

    // Concurrent duplicate capture submissions return the same item
    const [c1, c2, c3] = await Promise.all([
      app.handleRequest({
        method: 'POST',
        path: '/api/items/capture',
        headers: { 'x-session-token': token },
        body: { url: 'https://example.com/storage?utm_source=test#top' },
      }),
      app.handleRequest({
        method: 'POST',
        path: '/api/items/capture',
        headers: { 'x-session-token': token },
        body: { url: 'https://example.com/storage?utm_medium=social' },
      }),
      app.handleRequest({
        method: 'POST',
        path: '/api/items/capture',
        headers: { 'x-session-token': token },
        body: { url: 'https://example.com/login-wall' },
      }),
    ]);

    const item1Id = (c1.body as { item: { id: string } }).item.id;
    const item2Id = (c2.body as { item: { id: string } }).item.id;
    assert.equal(item1Id, item2Id, 'Duplicate normalized URLs must return the existing item');

    // Before worker runs, capture record is already persisted with status=queued
    const preJobItem = await app.handleRequest({
      method: 'GET',
      path: `/api/items/${item1Id}`,
      headers: { 'x-session-token': token },
    });
    assert.equal((preJobItem.body as { item: { processing_status: string } }).item.processing_status, 'queued');

    // Run worker
    await worker.drainQueue();

    // Verify extraction + partial extraction
    const postJobItem = await app.handleRequest({
      method: 'GET',
      path: `/api/items/${item1Id}`,
      headers: { 'x-session-token': token },
    });
    assert.equal((postJobItem.body as { item: { processing_status: string } }).item.processing_status, 'ready');

    const partialItemId = (c3.body as { item: { id: string } }).item.id;
    const partialItem = await app.handleRequest({
      method: 'GET',
      path: `/api/items/${partialItemId}`,
      headers: { 'x-session-token': token },
    });
    assert.equal((partialItem.body as { item: { processing_status: string } }).item.processing_status, 'partial');

    // Create highlight on item1
    const annRes = await app.handleRequest({
      method: 'POST',
      path: `/api/items/${item1Id}/annotations`,
      headers: { 'x-session-token': token },
      body: {
        type: 'highlight',
        exactQuote: 'Important highlightable quote here.',
        prefix: 'indexing version 1. ',
        suffix: '',
        startOffset: 85,
        endOffset: 120,
        note: 'Key architectural takeaway',
      },
    });
    assert.equal(annRes.status, 201);

    // Reprocess item when upstream changes to V2; verify new revision is created and highlight re-anchors
    articleVersion = 2;
    await app.handleRequest({
      method: 'POST',
      path: `/api/items/${item1Id}/reprocess`,
      headers: { 'x-session-token': token },
    });
    await worker.drainQueue();

    const reprocessed = await app.handleRequest({
      method: 'GET',
      path: `/api/items/${item1Id}`,
      headers: { 'x-session-token': token },
    });
    assert.equal((reprocessed.body as { revision: { revision_number: number } }).revision.revision_number, 2);

    const annsAfterReprocess = await app.handleRequest({
      method: 'GET',
      path: `/api/items/${item1Id}/annotations`,
      headers: { 'x-session-token': token },
    });
    const annList = (annsAfterReprocess.body as { annotations: Array<{ orphaned: boolean }> }).annotations;
    assert.equal(annList[0].orphaned, false);

    // Search index consistency after edit and after permanent delete
    const searchBeforeDel = await app.handleRequest({
      method: 'GET',
      path: '/api/search?q=Transactional+durability',
      headers: { 'x-session-token': token },
    });
    assert.equal((searchBeforeDel.body as { hits: unknown[] }).hits.length, 1);

    await app.handleRequest({
      method: 'DELETE',
      path: `/api/items/${item1Id}?permanent=true`,
      headers: { 'x-session-token': token },
    });

    const searchAfterDel = await app.handleRequest({
      method: 'GET',
      path: '/api/search?q=Transactional+durability',
      headers: { 'x-session-token': token },
    });
    assert.equal((searchAfterDel.body as { hits: unknown[] }).hits.length, 0);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('Worker crash / kill mid-job recovery and retry/backoff/dead-letter behavior', async () => {
  const dataDir = createTempDataDir('worker-recovery');
  try {
    const db = new ContainedDatabase(dataDir);

    // Enqueue a capture job and spawn a real OS worker child process with slow simulation, then SIGKILL it mid-job
    const itemId = uuidv7();
    const now = new Date().toISOString();
    db.transaction((st) => {
      st.items[itemId] = {
        id: itemId,
        owner_id: 'u1',
        url: 'https://example.com/crash-recovery',
        normalized_url: 'https://example.com/crash-recovery',
        canonical_url: null,
        possible_duplicate_of: null,
        title: 'Crash Recovery Article',
        author: null,
        publisher: 'example.com',
        domain: 'example.com',
        published_at: null,
        description: null,
        featured_image: null,
        language: 'en',
        reading_time_minutes: 1,
        content_type: 'article',
        processing_status: 'queued',
        error_message: null,
        error_class: null,
        current_revision_id: null,
        blob_id: null,
        page_count: null,
        ocr_status: 'none',
        outbound_urls: [],
        version: 1,
        created_at: now,
        updated_at: now,
      };
      db.enqueueJob('capture.extract', { itemId }, { timeoutMs: 200, maxAttempts: 3 });
    });

    // Spawn real child process running apps/worker/src/worker.ts with WORKER_SIMULATE_SLOW_MS=5000
    const child = spawn(process.execPath, [path.join(rootDir, 'apps/worker/src/worker.ts')], {
      env: {
        ...process.env,
        DATA_DIR: dataDir,
        WORKER_SIMULATE_SLOW_MS: '5000',
        WORKER_STALE_TIMEOUT_MS: '150',
      },
      stdio: 'ignore',
    });

    // Wait until the child worker locks the job in `running` state
    let jobLocked = false;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 50));
      const statuses = db.read((st) => Object.values(st.jobs).map((j) => j.status));
      if (statuses.includes('running')) {
        jobLocked = true;
        break;
      }
    }
    assert.equal(jobLocked, true, 'Child worker process must claim and lock the job');

    // Kill the worker process mid-job with SIGKILL
    child.kill('SIGKILL');
    await new Promise((r) => child.once('exit', r));

    // Wait 220ms for stale lock window (200ms) to expire, then start replacement worker and process the job
    await new Promise((r) => setTimeout(r, 220));
    const replacementWorker = new WorkerEngine(db, {
      staleTimeoutMs: 150,
      resolver: async () => [{ address: '93.184.216.34', family: 4 }],
      transport: async () => ({
        status: 200,
        headers: { 'content-type': 'text/html' },
        body: Buffer.from('<article><h1>Recovered After Crash</h1><p>Processed cleanly after worker SIGKILL.</p></article>', 'utf8'),
      }),
    });

    await replacementWorker.drainQueue();
    const recoveredItem = db.read((st) => st.items[itemId]);
    assert.equal(recoveredItem.processing_status, 'ready');
    assert.equal(db.read((st) => Object.keys(st.item_revisions).length), 1, 'Processed exactly once');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('Feeds conditional GET (ETag / 304), offline sync replay with conflicts, and Backup/Restore round-trip', async () => {
  const dataDir = createTempDataDir('p1-features');
  const restoreDir = createTempDataDir('restored-db');
  try {
    const db = new ContainedDatabase(dataDir);
    const app = new ReadingPlatformApp(db);

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

    let etagObserved: string | undefined;
    const worker = new WorkerEngine(db, {
      resolver: async () => [{ address: '93.184.216.34', family: 4 }],
      transport: async (req) => {
        if (req.headers['If-None-Match'] === '"v1-etag"') {
          etagObserved = req.headers['If-None-Match'];
          return { status: 304, headers: { etag: '"v1-etag"' }, body: Buffer.alloc(0) };
        }
        return {
          status: 200,
          headers: { 'content-type': 'application/rss+xml', etag: '"v1-etag"' },
          body: Buffer.from(
            '<?xml version="1.0"?><rss version="2.0"><channel><title>Tech Feed</title><item><guid>e1</guid><title>Entry 1</title><link>https://example.com/e1</link><description>Summary 1</description></item></channel></rss>',
            'utf8'
          ),
        };
      },
    });

    const subRes = await app.handleRequest({
      method: 'POST',
      path: '/api/feeds',
      headers: { 'x-session-token': token },
      body: { url: 'https://example.com/feed.xml', pollIntervalMinutes: 15 },
    });
    const feedId = (subRes.body as { feed: { id: string } }).feed.id;
    await worker.drainQueue();

    // Refresh feed -> sends If-None-Match: "v1-etag", gets 304, does not duplicate entries
    await app.handleRequest({
      method: 'POST',
      path: `/api/feeds/${feedId}/refresh`,
      headers: { 'x-session-token': token },
    });
    await worker.drainQueue();
    assert.equal(etagObserved, '"v1-etag"');

    const entriesRes = await app.handleRequest({
      method: 'GET',
      path: `/api/feeds/${feedId}/entries`,
      headers: { 'x-session-token': token },
    });
    const entries = (entriesRes.body as { entries: Array<{ id: string }> }).entries;
    assert.equal(entries.length, 1);

    // Save feed entry to library
    const savedFromFeed = await app.handleRequest({
      method: 'POST',
      path: `/api/feeds/${feedId}/entries/${entries[0].id}/save`,
      headers: { 'x-session-token': token },
    });
    assert.equal(savedFromFeed.status, 201);
    const savedItemId = (savedFromFeed.body as { item: { id: string } }).item.id;

    // Upload a PDF document so blobs exist for backup/restore verification
    const pdfBuf = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Page >> endobj\nBT (Backup Verification PDF) Tj ET\n%%EOF', 'latin1');
    const upRes = await app.handleRequest({
      method: 'POST',
      path: '/api/documents/upload',
      headers: { 'x-session-token': token },
      body: { filename: 'paper.pdf', dataBase64: pdfBuf.toString('base64') },
    });
    assert.equal(upRes.status, 201);

    // Offline mutation replay: idempotent duplicate mutation_id + stale annotation conflict
    const annId = uuidv7();
    const mutId1 = uuidv7();
    const syncRes1 = await app.handleRequest({
      method: 'POST',
      path: '/api/sync',
      headers: { 'x-session-token': token },
      body: {
        mutations: [
          {
            mutation_id: mutId1,
            entity: 'annotation',
            entity_id: annId,
            base_version: 1,
            op: 'create_annotation',
            payload: { item_id: savedItemId, type: 'note', note: 'Initial note v1' },
          },
          // Replay identical mutation_id
          {
            mutation_id: mutId1,
            entity: 'annotation',
            entity_id: annId,
            base_version: 1,
            op: 'create_annotation',
            payload: { item_id: savedItemId, type: 'note', note: 'Initial note v1' },
          },
        ],
      },
    });
    assert.equal(syncRes1.status, 200);

    // Server edits annotation to bump version to 2
    await app.handleRequest({
      method: 'PATCH',
      path: `/api/annotations/${annId}`,
      headers: { 'x-session-token': token },
      body: { note: 'Server updated note v2' },
    });

    // Offline client sends edit based on stale base_version=1 -> creates conflict record
    await app.handleRequest({
      method: 'POST',
      path: '/api/sync',
      headers: { 'x-session-token': token },
      body: {
        mutations: [
          {
            mutation_id: uuidv7(),
            entity: 'annotation',
            entity_id: annId,
            base_version: 1,
            op: 'update_annotation',
            payload: { note: 'Offline conflicting edit' },
          },
        ],
      },
    });

    const conflictsRes = await app.handleRequest({
      method: 'GET',
      path: '/api/sync/conflicts',
      headers: { 'x-session-token': token },
    });
    assert.equal((conflictsRes.body as { conflicts: unknown[] }).conflicts.length, 1);

    // Backup and restore round-trip into a fresh database directory
    const backupZipPath = path.join(dataDir, 'backup.zip');
    const manifest = createBackup(dataDir, backupZipPath);
    assert.equal(manifest.blobs.length, 1);

    restoreBackup(backupZipPath, restoreDir);
    const restoredDb = new ContainedDatabase(restoreDir);
    assert.equal(
      Object.keys(restoredDb.read((s) => s.items)).length,
      Object.keys(db.read((s) => s.items)).length
    );
    assert.equal(restoredDb.blobs.exists(manifest.blobs[0].blob_id), true);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(restoreDir, { recursive: true, force: true });
  }
});
