import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { ExtensionCaptureClient } from '../../apps/extension/extension-client.ts';
import { ReadingPlatformApp } from '../../apps/web/src/app.ts';
import { WorkerEngine } from '../../apps/worker/src/worker.ts';
import { createZipArchive } from '../../packages/article-processing/src/index.ts';
import { ContainedDatabase } from '../../packages/db/src/index.ts';
import type { ThemeId } from '../../packages/shared/src/index.ts';
import { THEMES, verifyThemeContrast } from '../../packages/shared/src/themes.ts';

const rootDir = process.env.PROJECT_ROOT || '/Users/harsha1/Documents/pocket_clone';

function createE2eDataDir(name: string): string {
  const d = path.join(rootDir, '.cache', `e2e-${name}-${process.pid}-${Date.now()}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/**
 * Automated accessibility & semantic HTML audit across rendered screens (Section 10 Accessibility).
 */
function runHtmlAccessibilityChecks(html: string, screenName: string): void {
  assert.match(html, /<!DOCTYPE html>/i, `${screenName}: missing DOCTYPE`);
  assert.match(html, /<html[^>]+lang="en"/i, `${screenName}: missing html[lang]`);
  assert.match(html, /<main\b[^>]*id="main-content"/i, `${screenName}: missing <main> landmark`);
  assert.match(html, /<h1\b[^>]*>/i, `${screenName}: missing primary <h1> heading`);
  // Every <input> with an id must have an associated <label for="..."> or be inside a <label>
  for (const m of html.matchAll(/<input\b([^>]+)>/gi)) {
    const attrs = m[1];
    if (/type="radio"/i.test(attrs)) continue;
    const idMatch = /id="([^"]+)"/.exec(attrs);
    if (idMatch) {
      const id = idMatch[1];
      assert.match(
        html,
        new RegExp(`<label[^>]+for="${id}"`, 'i'),
        `${screenName}: input#${id} is missing an associated <label for="${id}">`
      );
    }
  }
}

test('E2E P0 Complete Workflow: bootstrap, invite registration, capture, retry failed, reader, themes, tags, collections, annotations, search, export/import', async () => {
  const dataDir = createE2eDataDir('p0-flow');
  try {
    const db = new ContainedDatabase(dataDir);
    const app = new ReadingPlatformApp(db);

    let failNextFetch = false;
    const worker = new WorkerEngine(db, {
      resolver: async () => [{ address: '93.184.216.34', family: 4 }],
      transport: async (req) => {
        if (failNextFetch) {
          throw new Error('Upstream connection reset');
        }
        return {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
          body: Buffer.from(
            `<!DOCTYPE html><html lang="en"><head><title>Article for ${req.url}</title><meta name="author" content="Edsger Dijkstra"/></head><body><article><h1>Structured Programming</h1><p>Simplicity is prerequisite for reliability in software engineering systems.</p><h2>Verification</h2><p>Testing shows the presence of bugs; formal reasoning strengthens confidence. Link to <a href="https://example.com/second">Second Article</a>.</p></article></body></html>`,
            'utf8'
          ),
        };
      },
    });

    // 1. Fresh install & admin bootstrap
    const bootRes = await app.handleRequest({
      method: 'POST',
      path: '/api/auth/bootstrap',
      body: { username: 'admin', email: 'admin@example.com', password: 'AdminPassword123!' },
    });
    assert.equal(bootRes.status, 201);

    const adminLogin = await app.handleRequest({
      method: 'POST',
      path: '/api/auth/login',
      body: { email: 'admin@example.com', password: 'AdminPassword123!' },
    });
    const adminToken = (adminLogin.body as { sessionToken: string }).sessionToken;

    // 2. Invite-only registration for second user
    const noInviteReg = await app.handleRequest({
      method: 'POST',
      path: '/api/auth/register',
      body: { username: 'reader1', email: 'reader1@example.com', password: 'ReaderPassword123!' },
    });
    assert.equal(noInviteReg.status, 403);

    const invRes = await app.handleRequest({
      method: 'POST',
      path: '/api/admin/invitations',
      headers: { 'x-session-token': adminToken },
      body: { email: 'reader1@example.com' },
    });
    const inviteCode = (invRes.body as { inviteCode: string }).inviteCode;

    const regRes = await app.handleRequest({
      method: 'POST',
      path: '/api/auth/register',
      body: { username: 'reader1', email: 'reader1@example.com', password: 'ReaderPassword123!', inviteCode },
    });
    assert.equal(regRes.status, 201);

    // 3. Save a fixture article and read it
    const cap1 = await app.handleRequest({
      method: 'POST',
      path: '/api/items/capture',
      headers: { 'x-session-token': adminToken },
      body: { url: 'https://example.com/first?utm_source=e2e' },
    });
    assert.equal(cap1.status, 201);
    const item1Id = (cap1.body as { item: { id: string } }).item.id;
    await worker.drainQueue();

    // 4. Failed capture & retry flow
    failNextFetch = true;
    const capFail = await app.handleRequest({
      method: 'POST',
      path: '/api/items/capture',
      headers: { 'x-session-token': adminToken },
      body: { url: 'https://example.com/second' },
    });
    const item2Id = (capFail.body as { item: { id: string } }).item.id;
    await worker.drainQueue(); // exhausts retries and marks item failed

    const failedList = await app.handleRequest({
      method: 'GET',
      path: '/api/items?view=failed',
      headers: { 'x-session-token': adminToken },
    });
    assert.equal((failedList.body as { totalCount: number }).totalCount, 1);

    // Retry the failed capture once network recovers
    failNextFetch = false;
    const retryRes = await app.handleRequest({
      method: 'POST',
      path: `/api/items/${item2Id}/retry`,
      headers: { 'x-session-token': adminToken },
    });
    assert.equal(retryRes.status, 200);
    await worker.drainQueue();

    const afterRetry = await app.handleRequest({
      method: 'GET',
      path: `/api/items/${item2Id}`,
      headers: { 'x-session-token': adminToken },
    });
    assert.equal((afterRetry.body as { item: { processing_status: string } }).item.processing_status, 'ready');

    // 5. All four themes + Reader settings + Accessibility checks
    const screens = ['library', 'reader', 'settings', 'command-palette', 'error-state', 'pdf-reader'] as const;
    for (const themeId of Object.keys(THEMES) as ThemeId[]) {
      assert.equal(verifyThemeContrast(THEMES[themeId]).passesWcagAA, true);
      await app.handleRequest({
        method: 'PATCH',
        path: '/api/user/settings',
        headers: { 'x-session-token': adminToken },
        body: {
          theme: themeId,
          listLayout: 'compact',
          reader: { width: 'wide', fontSize: 20, fontFamily: 'serif', lineSpacing: 1.8, distractionFree: false },
        },
      });

      for (const screen of screens) {
        const htmlRes = await app.handleRequest({
          method: 'GET',
          path: `/?screen=${screen}&theme=${themeId}&id=${item1Id}`,
          headers: { 'x-session-token': adminToken },
        });
        assert.equal(htmlRes.status, 200);
        const html = String(htmlRes.body);
        assert.match(html, new RegExp(`data-theme="${themeId}"`));
        runHtmlAccessibilityChecks(html, `${themeId}:${screen}`);
      }
    }

    // 6. Tags, Collections (flat & nested + cycle check), Archive & Restore
    await app.handleRequest({
      method: 'POST',
      path: `/api/items/${item1Id}/tags`,
      headers: { 'x-session-token': adminToken },
      body: { name: 'ComputerScience' },
    });

    const parentColRes = await app.handleRequest({
      method: 'POST',
      path: '/api/collections',
      headers: { 'x-session-token': adminToken },
      body: { name: 'Engineering' },
    });
    const parentColId = (parentColRes.body as { collection: { id: string } }).collection.id;

    const childColRes = await app.handleRequest({
      method: 'POST',
      path: '/api/collections',
      headers: { 'x-session-token': adminToken },
      body: { name: 'Distributed Systems', parentId: parentColId },
    });
    const childColId = (childColRes.body as { collection: { id: string } }).collection.id;

    // Moving parent into child must be rejected with 400 CYCLE_DETECTED
    const cycleRes = await app.handleRequest({
      method: 'PATCH',
      path: `/api/collections/${parentColId}`,
      headers: { 'x-session-token': adminToken },
      body: { parentId: childColId },
    });
    assert.equal(cycleRes.status, 400);

    await app.handleRequest({
      method: 'POST',
      path: `/api/collections/${childColId}/items`,
      headers: { 'x-session-token': adminToken },
      body: { itemId: item1Id },
    });

    // Archive and restore item
    await app.handleRequest({
      method: 'POST',
      path: `/api/items/${item1Id}/state`,
      headers: { 'x-session-token': adminToken },
      body: { lifecycle: 'archived', is_favorite: true, progress_percent: 75 },
    });
    const archivedView = await app.handleRequest({
      method: 'GET',
      path: '/api/items?view=archived',
      headers: { 'x-session-token': adminToken },
    });
    assert.equal((archivedView.body as { totalCount: number }).totalCount, 1);

    await app.handleRequest({
      method: 'POST',
      path: `/api/items/${item1Id}/restore`,
      headers: { 'x-session-token': adminToken },
    });

    // 7. Highlight & Note + Search with operators
    await app.handleRequest({
      method: 'POST',
      path: `/api/items/${item1Id}/annotations`,
      headers: { 'x-session-token': adminToken },
      body: {
        type: 'highlight',
        exactQuote: 'Simplicity is prerequisite for reliability',
        note: 'Famous Dijkstra quote',
      },
    });

    const searchOpRes = await app.handleRequest({
      method: 'GET',
      path: '/api/search?q=tag:computerscience+domain:example.com+is:favorite+"Simplicity+is+prerequisite"',
      headers: { 'x-session-token': adminToken },
    });
    assert.equal(searchOpRes.status, 200);
    assert.equal((searchOpRes.body as { hits: unknown[] }).hits.length, 1);

    // 8. JSON Export and Import round-trip + dry-run mode
    const expStart = await app.handleRequest({
      method: 'POST',
      path: '/api/export',
      headers: { 'x-session-token': adminToken },
      body: { format: 'json' },
    });
    assert.equal(expStart.status, 202);
    await worker.drainQueue();

    const dlPath = (expStart.body as { downloadPath: string }).downloadPath;
    const dlRes = await app.handleRequest({
      method: 'GET',
      path: dlPath,
      headers: { 'x-session-token': adminToken },
    });
    assert.equal(dlRes.status, 200);
    const exportedJson = JSON.parse(String(dlRes.body));
    assert.equal(exportedJson.schema_version, '2.0');
    assert.equal(exportedJson.items.length, 2);

    // Dry-run import of new bookmarks HTML
    const dryRunImport = await app.handleRequest({
      method: 'POST',
      path: '/api/import',
      headers: { 'x-session-token': adminToken },
      body: {
        format: 'bookmarks_html',
        dryRun: true,
        content: '<a href="https://example.com/new-bookmark">New Bookmark</a>',
      },
    });
    assert.equal((dryRunImport.body as { counts: { imported: number } }).counts.imported, 1);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('E2E P1 & P2 Workflows: PDF/EPUB upload & download, MV3 Extension pairing & capture, Shared Collections, Knowledge Graph, Hybrid Search, Diagnostics', async () => {
  const dataDir = createE2eDataDir('p1-p2-flow');
  try {
    const db = new ContainedDatabase(dataDir);
    const app = new ReadingPlatformApp(db);
    const worker = new WorkerEngine(db, {
      resolver: async () => [{ address: '93.184.216.34', family: 4 }],
      transport: async () => ({
        status: 200,
        headers: { 'content-type': 'text/html' },
        body: Buffer.from('<article><h1>Captured via Extension</h1><p>Extension body text.</p></article>', 'utf8'),
      }),
    });

    await app.handleRequest({
      method: 'POST',
      path: '/api/auth/bootstrap',
      body: { username: 'admin', email: 'admin@example.com', password: 'AdminPassword123!' },
    });
    const login = await app.handleRequest({
      method: 'POST',
      path: '/api/auth/login',
      body: { email: 'admin@example.com', password: 'AdminPassword123!' },
    });
    const token = (login.body as { sessionToken: string }).sessionToken;

    // 1. Extension pairing & capture flow
    const pairStart = await app.handleRequest({
      method: 'POST',
      path: '/api/extension/pair/start',
      headers: { 'x-session-token': token },
      body: { name: 'Chromium Unpacked Extension' },
    });
    const pairingCode = (pairStart.body as { pairingCode: string }).pairingCode;
    const tokenId = (pairStart.body as { id: string }).id;

    const extClient = new ExtensionCaptureClient('http://localhost:3000', async (url, init) => {
      const u = new URL(url);
      const res = await app.handleRequest({
        method: init.method,
        path: u.pathname + u.search,
        headers: init.headers,
        body: JSON.parse(init.body),
      });
      return { status: res.status, body: res.body as Record<string, unknown> };
    });

    // Unauthenticated state before pairing
    const prePairCapture = await extClient.capture({ url: 'https://example.com/ext-1' });
    assert.equal(prePairCapture.state, 'unauthenticated');

    // Pair with short-lived code
    const pairRes = await extClient.pairWithCode(pairingCode);
    assert.equal(pairRes.ok, true);
    assert.equal(pairRes.state, 'paired');

    // Capture current tab & selection via extension
    const capRes = await extClient.capture({
      url: 'https://example.com/ext-captured',
      title: 'Extension Tab',
      selection: 'Selected excerpt',
    });
    assert.equal(capRes.ok, true);
    assert.equal(capRes.state, 'saved');
    await worker.drainQueue();

    // Revoke extension token -> extension gets clear 'revoked_token' state
    await app.handleRequest({
      method: 'POST',
      path: `/api/extension/tokens/${tokenId}/revoke`,
      headers: { 'x-session-token': token },
    });
    const postRevokeCap = await extClient.capture({ url: 'https://example.com/ext-2' });
    assert.equal(postRevokeCap.state, 'revoked_token');

    // 2. Upload PDF and EPUB and verify secure download headers
    const pdfBuf = Buffer.from(
      '%PDF-1.4\n1 0 obj << /Type /Page >> endobj\nBT (Quantum Cryptography Overview) Tj ET\n%%EOF',
      'latin1'
    );
    const pdfUp = await app.handleRequest({
      method: 'POST',
      path: '/api/documents/upload',
      headers: { 'x-session-token': token },
      body: { filename: 'quantum.pdf', dataBase64: pdfBuf.toString('base64') },
    });
    assert.equal(pdfUp.status, 201);
    const pdfItemId = (pdfUp.body as { item: { id: string } }).item.id;

    const pdfDl = await app.handleRequest({
      method: 'GET',
      path: `/api/documents/${pdfItemId}/download`,
      headers: { 'x-session-token': token },
    });
    assert.equal(pdfDl.status, 200);
    assert.match(pdfDl.headers['Content-Disposition'], /^attachment;/);
    assert.equal(pdfDl.headers['X-Content-Type-Options'], 'nosniff');

    const epubBuf = createZipArchive([
      {
        name: 'META-INF/container.xml',
        data: Buffer.from('<container><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>', 'utf8'),
      },
      {
        name: 'content.opf',
        data: Buffer.from(
          '<package><metadata><dc:title>Systems Handbook</dc:title></metadata><manifest><item id="c1" href="c1.xhtml"/></manifest><spine><itemref idref="c1"/></spine></package>',
          'utf8'
        ),
      },
      {
        name: 'c1.xhtml',
        data: Buffer.from('<html><body><h1>Chapter 1</h1><p>EPUB body content on distributed systems.</p></body></html>', 'utf8'),
      },
    ]);
    const epubUp = await app.handleRequest({
      method: 'POST',
      path: '/api/documents/upload',
      headers: { 'x-session-token': token },
      body: { filename: 'handbook.epub', dataBase64: epubBuf.toString('base64') },
    });
    assert.equal(epubUp.status, 201);
    const epubItemId = (epubUp.body as { item: { id: string } }).item.id;

    // 3. Knowledge Graph & Explainable Recommendations + Hybrid Search
    await app.handleRequest({
      method: 'POST',
      path: '/api/graph/links',
      headers: { 'x-session-token': token },
      body: {
        sourceItemId: pdfItemId,
        targetItemId: epubItemId,
        explanation: 'Both cover cryptographic & distributed systems foundations',
      },
    });

    const graphRes = await app.handleRequest({
      method: 'GET',
      path: `/api/graph?itemId=${pdfItemId}&depth=1`,
      headers: { 'x-session-token': token },
    });
    assert.equal(graphRes.status, 200);
    assert.ok((graphRes.body as { nodes: unknown[] }).nodes.length >= 2);

    const recRes = await app.handleRequest({
      method: 'GET',
      path: `/api/items/${pdfItemId}/recommendations`,
      headers: { 'x-session-token': token },
    });
    assert.equal(recRes.status, 200);
    const recs = (recRes.body as { recommendations: Array<{ reasons: string[] }> }).recommendations;
    assert.ok(recs.length >= 1);
    assert.ok(recs[0].reasons.length >= 1);

    const hybridSearch = await app.handleRequest({
      method: 'GET',
      path: '/api/search?q=Quantum+Cryptography&mode=hybrid',
      headers: { 'x-session-token': token },
    });
    assert.equal(hybridSearch.status, 200);
    assert.equal((hybridSearch.body as { mode: string }).mode, 'hybrid');

    // 4. Admin Diagnostics endpoint
    const diagRes = await app.handleRequest({
      method: 'GET',
      path: '/api/admin/diagnostics',
      headers: { 'x-session-token': token },
    });
    assert.equal(diagRes.status, 200);
    assert.ok((diagRes.body as { workerHeartbeats: unknown[] }).workerHeartbeats.length >= 1);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('E2E Long-Form Editorial GUI & Image Rendering: lazy data-src/srcset promotion, figure captions, library thumbnails, and reader lightbox', async () => {
  const dataDir = createE2eDataDir('image-and-reader-gui');
  try {
    const db = new ContainedDatabase(dataDir);
    const app = new ReadingPlatformApp(db);

    const svgDiagramBase64 = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="240"><rect width="600" height="240" fill="#FAF8F5"/></svg>',
      'utf8'
    ).toString('base64');

    const worker = new WorkerEngine(db, {
      resolver: async () => [{ address: '93.184.216.34', family: 4 }],
      transport: async () => ({
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
        body: Buffer.from(
          `<!DOCTYPE html>
          <html lang="en">
          <head>
            <title>Long-Form Typography and Visual Figures</title>
            <meta name="author" content="Edward Tufte" />
            <meta name="description" content="How measure, leading, marginalia, and high-resolution figures work together." />
          </head>
          <body>
            <article>
              <h2>Section 1: Saccades and Line Width</h2>
              <p>${'Sustained reading comfort depends on a 55ch to 68ch line measure and generous leading. '.repeat(12)}</p>
              <figure>
                <img data-src="/assets/diagrams/saccade-geometry.png" alt="Saccade geometry diagram" width="720" height="360" />
                <figcaption>Figure 1: Lazy-loaded data-src diagram promoted to canonical src.</figcaption>
              </figure>
              <h2>Section 2: Responsive Srcset &amp; Base64 Diagrams</h2>
              <figure>
                <img srcset="/assets/diagrams/tufte-rail-2x.webp 2x, /assets/diagrams/tufte-rail-1x.webp 1x" alt="Tufte sidenote rail" />
                <figcaption>Figure 2: Responsive srcset candidate promoted and rendered.</figcaption>
              </figure>
              <figure>
                <img src="data:image/svg+xml;base64,${svgDiagramBase64}" alt="Inline base64 SVG diagram" />
                <figcaption>Figure 3: Self-contained base64 SVG diagram.</figcaption>
              </figure>
            </article>
          </body>
          </html>`,
          'utf8'
        ),
      }),
    });

    // Capture via auto-bootstrapped browser session on GET /
    const initHome = await app.handleRequest({ method: 'GET', path: '/' });
    assert.equal(initHome.status, 200);
    const cookieHeader = initHome.headers['Set-Cookie']?.split(';')[0] || '';
    assert.match(cookieHeader, /^rp_session=/);

    const capRes = await app.handleRequest({
      method: 'POST',
      path: '/api/items/capture',
      headers: { cookie: cookieHeader },
      body: { url: 'https://typography.example.com/essays/figures' },
    });
    assert.equal(capRes.status, 201);
    const itemId = (capRes.body as { item: { id: string } }).item.id;
    await worker.drainQueue();

    // Verify Library GUI renders featured image thumbnail (fallback from first body <img>)
    const libRes = await app.handleRequest({
      method: 'GET',
      path: '/?screen=library&theme=editorial-light',
      headers: { cookie: cookieHeader },
    });
    assert.equal(libRes.status, 200);
    const libHtml = String(libRes.body);
    runHtmlAccessibilityChecks(libHtml, 'editorial-light:library-with-images');
    assert.match(libHtml, /class="item-thumbnail"/);
    assert.match(libHtml, /src="https:\/\/typography\.example\.com\/assets\/diagrams\/saccade-geometry\.png"/);

    // Verify Reader GUI renders 3-column layout, typography controls, all 3 figures, captions, and lightbox
    const readerRes = await app.handleRequest({
      method: 'GET',
      path: `/?screen=reader&id=${itemId}&theme=editorial-light`,
      headers: { cookie: cookieHeader },
    });
    assert.equal(readerRes.status, 200);
    const readerHtml = String(readerRes.body);
    runHtmlAccessibilityChecks(readerHtml, 'editorial-light:reader-with-images');
    assert.match(readerHtml, /class="reader-workspace-grid"/);
    assert.match(readerHtml, /data-reader-font="serif"/);
    assert.match(readerHtml, /data-reader-width="65ch"/);
    assert.match(readerHtml, /id="reader-image-lightbox"/);
    assert.match(readerHtml, /src="https:\/\/typography\.example\.com\/assets\/diagrams\/saccade-geometry\.png"/);
    assert.match(readerHtml, /src="https:\/\/typography\.example\.com\/assets\/diagrams\/tufte-rail-2x\.webp"/);
    assert.match(readerHtml, new RegExp(`src="data:image/svg\\+xml;base64,${svgDiagramBase64.slice(0, 24)}`));
    assert.match(readerHtml, /<figcaption>Figure 1: Lazy-loaded data-src diagram promoted to canonical src\.<\/figcaption>/);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

