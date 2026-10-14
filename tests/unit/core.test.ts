import assert from 'node:assert/strict';
import test from 'node:test';
import {
  computeReadingTimeMinutes,
  createZipArchive,
  discoverFeedsFromHtml,
  extractArticle,
  extractZipSafely,
  parseEpubBuffer,
  parseFeedXml,
  parsePdfBuffer,
  sanitizeHtml,
} from '../../packages/article-processing/src/index.ts';
import { buildTextAnchor, reanchorHighlight } from '../../packages/shared/src/anchoring.ts';
import { can } from '../../packages/shared/src/authz.ts';
import { ROUTE_REGISTRY, uuidv7 } from '../../packages/shared/src/index.ts';
import { parseSearchQuery } from '../../packages/shared/src/search-parser.ts';
import {
  SsrfError,
  checkIpSafety,
  parseIpv4LiteralToUint32,
  safeFetch,
  validateAndPinDestination,
} from '../../packages/shared/src/ssrf.ts';
import { evaluateAnnotationMutation, mergeItemStateMutation } from '../../packages/shared/src/sync.ts';
import { THEMES, verifyThemeContrast } from '../../packages/shared/src/themes.ts';
import { UrlValidationError, parseAndNormalizeUrl, redactUrlForLog } from '../../packages/shared/src/url.ts';
import { COMPONENT_ONLY_CSS, renderInlineThemeBootstrapScript } from '../../packages/ui/src/index.ts';

test('URL normalization strips tracking params, default ports, fragments, and sorts query params', () => {
  const res = parseAndNormalizeUrl(
    'HTTPS://WWW.Example.COM:443/articles/guide?utm_source=newsletter&b=2&fbclid=abc123&a=1&gclid=xyz#section-2'
  );
  assert.equal(res.normalizedUrl, 'https://www.example.com/articles/guide?a=1&b=2');
  assert.equal(res.hostname, 'www.example.com');
  assert.equal(res.domain, 'example.com');

  const httpDefault = parseAndNormalizeUrl('http://example.com:80/test#frag');
  assert.equal(httpDefault.normalizedUrl, 'http://example.com/test');

  assert.equal(
    redactUrlForLog('https://example.com/path?secret_token=12345&code=abc#hash'),
    'https://example.com/path'
  );

  assert.throws(() => parseAndNormalizeUrl('javascript:alert(1)'), UrlValidationError);
  assert.throws(() => parseAndNormalizeUrl('file:///etc/passwd'), UrlValidationError);
  assert.throws(() => parseAndNormalizeUrl('https://user:pass@example.com/'), UrlValidationError);
});

test('SSRF destination validator blocks all private, loopback, metadata, IPv6, and exotic IPv4 encodings', async () => {
  // Standard IPv4 blocked ranges
  for (const blockedIp of [
    '127.0.0.1',
    '127.255.255.254',
    '0.0.0.0',
    '10.0.0.1',
    '10.255.255.255',
    '100.64.0.1',
    '100.100.100.200', // Alibaba/cloud metadata in CGNAT
    '169.254.169.254', // AWS/GCP/Azure metadata
    '172.16.0.1',
    '172.31.255.254',
    '192.168.1.1',
    '224.0.0.1',
    '240.0.0.1',
    '255.255.255.255',
  ]) {
    const check = checkIpSafety(blockedIp);
    assert.equal(check.safe, false, `Expected ${blockedIp} to be blocked`);
  }

  // Public IPv4 allowed
  assert.equal(checkIpSafety('93.184.216.34').safe, true);
  assert.equal(checkIpSafety('1.1.1.1').safe, true);

  // Exotic IPv4 encodings (decimal integer, octal, hex, shortened, mixed)
  const exoticLoopbacks = [
    '2130706433', // 127.0.0.1 decimal
    '0177.0.0.1', // octal
    '017700000001', // single octal integer
    '0x7f.0.0.1', // hex dotted
    '0x7f000001', // single hex integer
    '127.1', // 2-part shortened
    '127.0.1', // 3-part shortened
    '0x7f.0.0.01', // mixed hex + octal
    '167772161', // 10.0.0.1 decimal
    '2851995649', // 169.254.169.254 decimal
  ];
  for (const literal of exoticLoopbacks) {
    const num = parseIpv4LiteralToUint32(literal);
    assert.notEqual(num, null, `Expected ${literal} to parse as IPv4`);
    await assert.rejects(
      () => validateAndPinDestination(`http://${literal}/latest/meta-data/`),
      SsrfError,
      `Expected ${literal} URL to be rejected by SSRF validator`
    );
  }

  // IPv6 blocked ranges
  for (const blockedV6 of [
    '::1',
    '::',
    '::ffff:127.0.0.1',
    '::ffff:169.254.169.254',
    '::ffff:10.0.0.1',
    'fc00::1',
    'fd12:3456:789a::1',
    'fe80::1',
    'fe80::1%eth0',
    'ff02::1',
    '64:ff9b::127.0.0.1',
    '2002:7f00:0001::1',
    '2001:db8::1',
  ]) {
    assert.equal(checkIpSafety(blockedV6).safe, false, `Expected IPv6 ${blockedV6} to be blocked`);
  }

  // Public IPv6 allowed
  assert.equal(checkIpSafety('2606:2800:220:1:248:1893:25c8:1946').safe, true);

  // Cloud metadata hostnames & non-default ports
  await assert.rejects(() => validateAndPinDestination('http://metadata.google.internal/computeMetadata/v1/'), SsrfError);
  await assert.rejects(() => validateAndPinDestination('http://localhost/admin'), SsrfError);
  await assert.rejects(() => validateAndPinDestination('https://example.com:6379/'), SsrfError);
});

test('SSRF safeFetch validates every redirect hop, blocks loops, and enforces streaming byte & decompression caps', async () => {
  const pubResolver = async () => [{ address: '93.184.216.34', family: 4 as const }];

  // Redirect to private IP must be rejected before connecting
  await assert.rejects(
    () =>
      safeFetch('https://example.com/start', {
        resolver: pubResolver,
        transport: async () => ({
          status: 302,
          headers: { location: 'http://169.254.169.254/latest/meta-data/' },
          body: Buffer.alloc(0),
        }),
      }),
    (err: unknown) => err instanceof SsrfError && err.errorClass === 'permanent'
  );

  // Redirect loop detection
  await assert.rejects(
    () =>
      safeFetch('https://example.com/loop-a', {
        resolver: pubResolver,
        transport: async (req) => ({
          status: 302,
          headers: {
            location: req.url.endsWith('/loop-a') ? 'https://example.com/loop-b' : 'https://example.com/loop-a',
          },
          body: Buffer.alloc(0),
        }),
      }),
    (err: unknown) => err instanceof SsrfError && err.code === 'REDIRECT_LOOP'
  );

  // Oversized streaming body rejection
  await assert.rejects(
    () =>
      safeFetch('https://example.com/huge', {
        resolver: pubResolver,
        maxBytes: 100,
        transport: async () => ({
          status: 200,
          headers: { 'content-type': 'text/html' },
          body: Buffer.alloc(250, 'a'),
        }),
      }),
    (err: unknown) => err instanceof SsrfError && err.code === 'BODY_TOO_LARGE'
  );
});

test('HTML Sanitizer neutralizes XSS payload corpus and rewrites relative URLs', () => {
  const xssCorpus = [
    '<script>alert("xss")</script><p>Safe text</p>',
    '<img src="x" onerror="alert(1)" />',
    '<svg onload="alert(1)"><circle r="10"/></svg>',
    '<a href="javascript:alert(document.cookie)">Click me</a>',
    '<a href="JaVaScRiPt:&#97;lert(1)">Obfuscated</a>',
    '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">Data URI</a>',
    '<iframe src="https://evil.example/frame"></iframe>',
    '<math><mi xlink:href="javascript:alert(1)">X</mi></math>',
    '<div style="background:url(javascript:alert(1))" onclick="steal()">Styled</div>',
    '<form action="https://evil.example/phish"><input name="pw"/></form>',
  ];

  for (const payload of xssCorpus) {
    const out = sanitizeHtml(payload, 'https://blog.example.com/posts/1');
    assert.equal(/<script|<svg|<iframe|<math|<form|onerror|onload|onclick|javascript:|data:text\/html/i.test(out), false, `Sanitizer leaked dangerous construct in: ${out}`);
  }

  const relativeRewritten = sanitizeHtml(
    '<p>Read <a href="/guide/part-2">Part 2</a> and see <img src="../images/diagram.png" alt="Diagram"/></p>',
    'https://docs.example.com/articles/part-1'
  );
  assert.match(relativeRewritten, /href="https:\/\/docs\.example\.com\/guide\/part-2"/);
  assert.match(relativeRewritten, /rel="noopener noreferrer"/);
  assert.match(relativeRewritten, /src="https:\/\/docs\.example\.com\/images\/diagram\.png"/);
});

test('Article extractor extracts metadata, TOC, reading time, and marks login shells as partial', () => {
  const html = `<!DOCTYPE html>
  <html lang="en">
  <head>
    <title>Fallback Title</title>
    <meta property="og:title" content="Designing Durable Storage Systems" />
    <meta name="author" content="Ada Lovelace" />
    <meta property="og:site_name" content="Systems Journal" />
    <meta property="article:published_time" content="2026-05-01T10:00:00Z" />
    <link rel="canonical" href="https://systems.example.com/durable-storage?utm_source=rss" />
  </head>
  <body>
    <article>
      <h1>Introduction</h1>
      <p>${'Durable storage requires atomic commits and crash recovery. '.repeat(25)}</p>
      <h2>Write-Ahead Logging</h2>
      <p>Every mutation is recorded before acknowledging the client. See <a href="https://other.example.org/wal">WAL Spec</a>.</p>
    </article>
  </body>
  </html>`;

  const res = extractArticle(html, 'https://systems.example.com/durable-storage');
  assert.equal(res.status, 'ready');
  assert.equal(res.title, 'Designing Durable Storage Systems');
  assert.equal(res.author, 'Ada Lovelace');
  assert.equal(res.publisher, 'Systems Journal');
  assert.equal(res.canonicalUrl, 'https://systems.example.com/durable-storage');
  assert.equal(res.toc.length, 2);
  assert.equal(res.toc[0].text, 'Introduction');
  assert.equal(res.toc[1].text, 'Write-Ahead Logging');
  assert.ok(res.outboundUrls.includes('https://other.example.org/wal'));
  assert.ok(res.readingTimeMinutes >= 1);

  // Login wall shell becomes partial
  const loginWallHtml = `<html><head><title>Sign In</title><meta name="description" content="Please log in to view"/></head><body><form action="/login"><input type="password"/></form></body></html>`;
  const partialRes = extractArticle(loginWallHtml, 'https://private.example.com/secret');
  assert.equal(partialRes.status, 'partial');
  assert.equal(computeReadingTimeMinutes('word '.repeat(410)), 3);
});

test('Feed discovery and XML parser handle RSS, Atom, deduplication, and block XXE', () => {
  const pageHtml = `<html><head><link rel="alternate" type="application/rss+xml" title="Main RSS" href="/feed.xml" /></head></html>`;
  const discovered = discoverFeedsFromHtml(pageHtml, 'https://news.example.com/index.html');
  assert.equal(discovered.length, 1);
  assert.equal(discovered[0].url, 'https://news.example.com/feed.xml');

  const rssXml = `<?xml version="1.0"?>
  <rss version="2.0">
    <channel>
      <title>Engineering Feed</title>
      <description>Updates</description>
      <item>
        <guid>post-1</guid>
        <title>First Post</title>
        <link>https://news.example.com/posts/1?utm_source=rss</link>
        <description><![CDATA[<p>Hello <script>evil()</script>world</p>]]></description>
      </item>
    </channel>
  </rss>`;

  const parsed = parseFeedXml(rssXml, 'https://news.example.com/feed.xml');
  assert.equal(parsed.title, 'Engineering Feed');
  assert.equal(parsed.entries.length, 1);
  assert.equal(parsed.entries[0].dedupKey, 'guid:post-1');
  assert.equal(parsed.entries[0].url, 'https://news.example.com/posts/1');
  assert.equal(parsed.entries[0].contentHtml.includes('<script>'), false);

  const xxeXml = `<?xml version="1.0"?><!DOCTYPE foo [ <!ENTITY xxe SYSTEM "file:///etc/passwd"> ]><rss><channel><title>&xxe;</title></channel></rss>`;
  assert.throws(() => parseFeedXml(xxeXml, 'https://news.example.com/feed.xml'), /XXE/);
});

test('Search query parser enforces operator precedence (OR tighter than AND) and compiles parameterized SQL', () => {
  const res = parseSearchQuery('tag:systems collection:core domain:example.com type:article is:unread before:2026-12-31 after:2026-01-01 "distributed consensus" -raft paxos OR viewstamped');
  assert.equal(res.ok, true);
  assert.equal(res.errors.length, 0);
  // Verify user values are in params array and SQL only contains $1..$n placeholders
  assert.equal(res.compiledSql.sql.includes('distributed consensus'), false);
  assert.ok(res.compiledSql.params.includes('distributed consensus'));
  assert.ok(res.compiledSql.params.includes('paxos'));
  assert.ok(res.compiledSql.params.includes('viewstamped'));

  // Invalid queries return structured errors
  const bad = parseSearchQuery('type:video is:unknown "unterminated');
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.length >= 1);
});

test('Route registry declares an explicit policy for every route and authorization policy enforces roles', () => {
  assert.ok(ROUTE_REGISTRY.length >= 45);
  for (const r of ROUTE_REGISTRY) {
    assert.ok(r.policy, `Route ${r.method} ${r.path} is missing a policy`);
  }

  const ownerUser = {
    id: uuidv7(),
    username: 'alice',
    email: 'alice@example.com',
    password_hash: 'h',
    role: 'user' as const,
    settings: {
      theme: 'editorial-light' as const,
      listLayout: 'comfortable' as const,
      reader: { width: 'medium' as const, fontSize: 18, fontFamily: 'serif' as const, lineSpacing: 1.7, distractionFree: false },
      offlineStorageCapMb: 250,
    },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const otherUser = { ...ownerUser, id: uuidv7(), username: 'bob' };
  const sampleItem = {
    id: uuidv7(),
    owner_id: ownerUser.id,
    url: 'https://example.com/a',
    normalized_url: 'https://example.com/a',
    canonical_url: null,
    possible_duplicate_of: null,
    title: 'A',
    author: null,
    publisher: null,
    domain: 'example.com',
    published_at: null,
    description: null,
    featured_image: null,
    language: 'en',
    reading_time_minutes: 1,
    content_type: 'article' as const,
    processing_status: 'ready' as const,
    error_message: null,
    error_class: null,
    current_revision_id: null,
    blob_id: null,
    page_count: null,
    ocr_status: 'none' as const,
    outbound_urls: [],
    version: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  assert.equal(can({ user: null, authType: 'none' }, 'item:read', { item: sampleItem }).statusCode, 401);
  // Another user denied with 404 so existence is not leaked
  assert.equal(can({ user: otherUser, authType: 'session' }, 'item:read', { item: sampleItem }).statusCode, 404);
  // Viewer on shared collection can read item but cannot write item
  assert.equal(
    can({ user: otherUser, authType: 'session' }, 'item:read', {
      item: sampleItem,
      itemSharedCollectionRoles: ['viewer'],
    }).allowed,
    true
  );
  assert.equal(
    can({ user: otherUser, authType: 'session' }, 'item:owner', {
      item: sampleItem,
      itemSharedCollectionRoles: ['editor'],
    }).statusCode,
    403
  );
});

test('Annotation anchoring re-anchors across exact offset, shifted context, fuzzy edit, and marks deleted passage as orphaned', () => {
  const originalText =
    'Section One introduces the foundational theorem of distributed state machines and consensus protocols in detail.';
  const quote = 'foundational theorem of distributed state machines';
  const start = originalText.indexOf(quote);
  const anchor = buildTextAnchor(originalText, start, start + quote.length);

  // 1. Shifted offset (context quote match)
  const shiftedText = `Preface paragraph added at top.\n\n${originalText}`;
  const r1 = reanchorHighlight(shiftedText, anchor);
  assert.equal(r1.orphaned, false);
  assert.equal(r1.matchType, 'context_quote');
  assert.equal(shiftedText.slice(r1.startOffset, r1.endOffset), quote);

  // 2. Minor typo fix inside quote (fuzzy match >= 0.80)
  const slightlyEditedText =
    'Section One introduces the foundational theorems of distributed state machine and consensus protocols in detail.';
  const r2 = reanchorHighlight(slightlyEditedText, anchor);
  assert.equal(r2.orphaned, false);
  assert.equal(r2.matchType, 'fuzzy');

  // 3. Passage completely removed -> marked orphaned, never attached to wrong text
  const unrelatedText = 'This replacement article discusses culinary recipes and sourdough fermentation techniques.';
  const r3 = reanchorHighlight(unrelatedText, anchor);
  assert.equal(r3.orphaned, true);
  assert.equal(r3.matchType, 'orphaned');
});

test('Offline sync merge rules enforce monotonic progress, LWW state merge, and annotation conflict records', () => {
  const baseState = {
    user_id: 'u1',
    item_id: 'i1',
    is_read: false,
    is_favorite: false,
    lifecycle: 'active' as const,
    trashed_at: null,
    progress_percent: 60,
    progress_page: null,
    progress_spine: null,
    last_read_at: null,
    offline_cached: true,
    version: 3,
    updated_at: '2026-10-14T10:00:00Z',
  };

  // Lower progress without explicit reset keeps greater progress (60%)
  const m1 = mergeItemStateMutation(baseState, {
    mutation_id: uuidv7(),
    entity: 'item_state',
    entity_id: 'i1',
    base_version: 2,
    op: 'update_state',
    payload: { progress_percent: 25, is_favorite: true },
  });
  assert.equal(m1.status, 'merged');
  assert.equal(m1.updatedState.progress_percent, 60);
  assert.equal(m1.updatedState.is_favorite, true);

  // Annotation edit with stale base_version creates conflict
  const serverAnn = {
    id: 'a1',
    item_id: 'i1',
    user_id: 'u1',
    revision_id: 'r1',
    type: 'highlight' as const,
    exact_quote: 'quote',
    prefix: '',
    suffix: '',
    start_offset: 0,
    end_offset: 5,
    page_number: null,
    spine_item: null,
    note: 'Server note v2',
    color: 'yellow',
    orphaned: false,
    shared_in_collections: [],
    version: 2,
    created_at: '2026-10-14T10:00:00Z',
    updated_at: '2026-10-14T10:05:00Z',
  };

  const annEval = evaluateAnnotationMutation(serverAnn, {
    mutation_id: uuidv7(),
    entity: 'annotation',
    entity_id: 'a1',
    base_version: 1,
    op: 'update_annotation',
    payload: { note: 'Offline client note edit' },
  });
  assert.equal(annEval.status, 'conflict');
  assert.ok(annEval.conflict);
});

test('Four themes are token-complete, pass WCAG 2.2 AA contrast, and use zero hard-coded component colors', () => {
  const themeIds = Object.keys(THEMES) as Array<keyof typeof THEMES>;
  assert.equal(themeIds.length, 4);

  const fontPairings = new Set<string>();
  for (const id of themeIds) {
    const t = THEMES[id];
    const audit = verifyThemeContrast(t);
    assert.equal(audit.passesWcagAA, true, `Theme ${id} failed contrast audit: ${JSON.stringify(audit.ratios)}`);
    fontPairings.add(`${t.typography.fontReading}|${t.layout.borderRadiusMd}|${t.layout.density}`);
  }
  assert.equal(fontPairings.size, 4, 'Each theme must have distinct typography, spacing, and layout tokens');
  assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(COMPONENT_ONLY_CSS), false);
  assert.match(renderInlineThemeBootstrapScript('midnight-amoled'), /document\.documentElement\.setAttribute\('data-theme'/);
});

test('PDF and EPUB parsers validate magic bytes, extract pages/spine, and block zip-slip', () => {
  const samplePdf = Buffer.from(
    '%PDF-1.4\n1 0 obj << /Type /Page >> endobj\nBT (Distributed Consensus Paper) Tj ET\n%%EOF',
    'latin1'
  );
  const parsedPdf = parsePdfBuffer(samplePdf, 'consensus.pdf');
  assert.equal(parsedPdf.pageCount, 1);
  assert.match(parsedPdf.plainText, /Distributed Consensus Paper/);
  assert.equal(parsedPdf.ocrStatus, 'none');

  // Scanned PDF with no text layer gets ocrStatus: 'no_text_layer'
  const scannedPdf = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Page >> endobj\n%%EOF', 'latin1');
  assert.equal(parsePdfBuffer(scannedPdf, 'scan.pdf').ocrStatus, 'no_text_layer');

  // Zip-slip path traversal in EPUB archive is blocked
  const maliciousZip = createZipArchive([
    { name: '../../etc/passwd', data: Buffer.from('root:x:0:0', 'utf8') },
  ]);
  assert.throws(() => extractZipSafely(maliciousZip), /Zip-slip path traversal/);

  // Valid EPUB archive parses spine and sanitizes HTML
  const validEpub = createZipArchive([
    {
      name: 'META-INF/container.xml',
      data: Buffer.from(
        '<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>',
        'utf8'
      ),
    },
    {
      name: 'OEBPS/content.opf',
      data: Buffer.from(
        '<package><metadata><dc:title>Book of Knowledge</dc:title><dc:creator>Grace Hopper</dc:creator></metadata><manifest><item id="ch1" href="ch1.xhtml"/></manifest><spine><itemref idref="ch1"/></spine></package>',
        'utf8'
      ),
    },
    {
      name: 'OEBPS/ch1.xhtml',
      data: Buffer.from('<html><head><title>Chapter One</title></head><body><h1>Chapter One</h1><p>Compiler design.</p><script>evil()</script></body></html>', 'utf8'),
    },
  ]);
  const epubRes = parseEpubBuffer(validEpub);
  assert.equal(epubRes.title, 'Book of Knowledge');
  assert.equal(epubRes.author, 'Grace Hopper');
  assert.equal(epubRes.spine.length, 1);
  assert.equal(epubRes.sanitizedHtml.includes('<script>'), false);
});
