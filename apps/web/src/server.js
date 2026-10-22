import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { extractArticle } from '../../../packages/article-processing/src/index.js';
import { ContainedDatabase, hashPassword } from '../../../packages/db/src/index.js';
import { uuidv7 } from '../../../packages/shared/src/index.js';
import { WorkerEngine } from '../../worker/src/worker.js';
import { ReadingPlatformApp } from './app.js';

function buildSvgDataUri(svgString) {
  return `data:image/svg+xml;base64,${Buffer.from(svgString.trim(), 'utf8').toString('base64')}`;
}

export function seedShowcaseEssaysIfNeeded(db) {
  db.transaction((st) => {
    const now = new Date().toISOString();
    let user = Object.values(st.users)[0];
    if (!user) {
      user = {
        id: uuidv7(),
        username: 'admin',
        email: 'admin@localhost',
        password_hash: hashPassword('AdminPassword123!'),
        role: 'admin',
        settings: {
          theme: 'editorial-light',
          listLayout: 'comfortable',
          reader: {
            width: 'medium',
            fontSize: 19,
            fontFamily: 'serif',
            lineSpacing: 1.75,
            distractionFree: false,
          },
          offlineStorageCapMb: 250,
        },
        created_at: now,
        updated_at: now,
      };
      st.users[user.id] = user;
    }

    const hasIllustratedEssay = Object.values(st.items).some(
      (it) => it.url === 'https://practicaltypography.com/long-form-digital-reading'
    );
    if (hasIllustratedEssay) return;

    const figTypographySvg = buildSvgDataUri(`
      <svg xmlns="http://www.w3.org/2000/svg" width="840" height="360" viewBox="0 0 840 360">
        <rect width="840" height="360" rx="12" fill="#F6F2EA"/>
        <rect x="32" y="28" width="776" height="304" rx="8" fill="#FAF8F5" stroke="#DED8CE" stroke-width="2"/>
        <text x="64" y="72" font-family="Georgia, serif" font-size="20" font-weight="bold" fill="#1C1B18">Figure 1 — Optimal Eye Saccade &amp; Measure Geometry (55ch–68ch)</text>
        <text x="64" y="100" font-family="sans-serif" font-size="13" fill="#524F49">Butterick’s Practical Typography &amp; Tufte CSS Sidenote Proportions</text>
        <rect x="64" y="128" width="460" height="168" rx="6" fill="#EFECE6" stroke="#8B261D" stroke-width="2"/>
        <text x="84" y="158" font-family="Georgia, serif" font-size="15" font-weight="bold" fill="#8B261D">Primary Reading Column (65ch Measure · 1.75 Line Spacing)</text>
        <line x1="84" y1="178" x2="496" y2="178" stroke="#524F49" stroke-width="4" stroke-linecap="round"/>
        <line x1="84" y1="202" x2="480" y2="202" stroke="#524F49" stroke-width="4" stroke-linecap="round"/>
        <line x1="84" y1="226" x2="502" y2="226" stroke="#524F49" stroke-width="4" stroke-linecap="round"/>
        <line x1="84" y1="250" x2="440" y2="250" stroke="#524F49" stroke-width="4" stroke-linecap="round"/>
        <circle cx="150" cy="178" r="7" fill="#8B261D"/>
        <circle cx="290" cy="178" r="7" fill="#8B261D"/>
        <circle cx="430" cy="178" r="7" fill="#8B261D"/>
        <rect x="548" y="128" width="228" height="168" rx="6" fill="#FAF8F5" stroke="#DED8CE" stroke-width="1.5"/>
        <text x="566" y="158" font-family="sans-serif" font-size="13" font-weight="bold" fill="#1C1B18">Tufte Marginalia Rail</text>
        <text x="566" y="184" font-family="Georgia, serif" font-size="12" font-style="italic" fill="#524F49">“Sidenotes &amp; highlights</text>
        <text x="566" y="202" font-family="Georgia, serif" font-size="12" font-style="italic" fill="#524F49">live beside the passage</text>
        <text x="566" y="220" font-family="Georgia, serif" font-size="12" font-style="italic" fill="#524F49">without breaking flow.”</text>
      </svg>
    `);

    const figStorageSvg = buildSvgDataUri(`
      <svg xmlns="http://www.w3.org/2000/svg" width="840" height="340" viewBox="0 0 840 340">
        <rect width="840" height="340" rx="12" fill="#F3EFE6"/>
        <rect x="32" y="28" width="776" height="284" rx="8" fill="#FAF8F5" stroke="#DED8CE" stroke-width="2"/>
        <text x="60" y="68" font-family="Georgia, serif" font-size="20" font-weight="bold" fill="#1C1B18">Figure 2 — Contained Extraction &amp; SSRF-Pinned Pipeline</text>
        <rect x="60" y="106" width="200" height="150" rx="8" fill="#EFECE6" stroke="#1E6B45" stroke-width="2"/>
        <text x="82" y="142" font-family="sans-serif" font-size="14" font-weight="bold" fill="#1E6B45">1. DNS Pin &amp; Fetch</text>
        <text x="82" y="168" font-family="monospace" font-size="12" fill="#524F49">Resolve IP once</text>
        <text x="82" y="190" font-family="monospace" font-size="12" fill="#524F49">Block RFC1918/Loopback</text>
        <text x="82" y="212" font-family="monospace" font-size="12" fill="#524F49">Stream cap: 10 MB</text>
        <rect x="320" y="106" width="200" height="150" rx="8" fill="#EFECE6" stroke="#8B261D" stroke-width="2"/>
        <text x="342" y="142" font-family="sans-serif" font-size="14" font-weight="bold" fill="#8B261D">2. Readability &amp; Img</text>
        <text x="342" y="168" font-family="monospace" font-size="12" fill="#524F49">Promote data-src</text>
        <text x="342" y="190" font-family="monospace" font-size="12" fill="#524F49">Sanitize &lt;figure&gt;</text>
        <text x="342" y="212" font-family="monospace" font-size="12" fill="#524F49">Build TOC anchors</text>
        <rect x="580" y="106" width="200" height="150" rx="8" fill="#EFECE6" stroke="#1C1B18" stroke-width="2"/>
        <text x="602" y="142" font-family="sans-serif" font-size="14" font-weight="bold" fill="#1C1B18">3. Immutable Revision</text>
        <text x="602" y="168" font-family="monospace" font-size="12" fill="#524F49">SHA-256 content hash</text>
        <text x="602" y="190" font-family="monospace" font-size="12" fill="#524F49">Fuzzy quote anchors</text>
        <text x="602" y="212" font-family="monospace" font-size="12" fill="#524F49">Offline cache ready</text>
      </svg>
    `);

    const essay1RawHtml = `<!DOCTYPE html>
    <html lang="en">
    <head>
      <title>The Architecture of Long-Form Digital Reading: Measure, Rhythm, and Marginalia</title>
      <meta name="author" content="Matthew Butterick &amp; Edward Tufte Research Synthesis" />
      <meta property="og:site_name" content="Practical Typography Journal" />
      <meta property="article:published_time" content="2026-10-12T09:00:00Z" />
      <meta name="description" content="Why line measure between 55 and 68 characters, generous 1.75 line spacing, warm ivory paper contrast, and side-column marginalia transform multi-hour screen reading." />
    </head>
    <body>
      <article>
        <h2>1. The Cognitive Mechanics of Line Length and Saccades</h2>
        <p>Sustained reading on luminous screens fails most often not because of screen resolution, but because of uncalibrated typographic geometry. When a column of prose stretches across an entire widescreen monitor, the human eye struggles to execute a clean return sweep from the end of one line to the beginning of the next.</p>
        <p>Empirical typography research establishes that an line measure between 55 and 70 characters (roughly two to three alphabets in width, or <code>65ch</code> in CSS) minimizes ocular fatigue across multi-hour reading sessions. Within this window, readers take three to four comfortable fixation pauses per line without losing vertical orientation.</p>
        <figure>
          <img src="${figTypographySvg}" alt="Diagram of 65ch reading measure and Tufte marginalia layout" />
          <figcaption>Figure 1: A 65-character reading column paired with a dedicated marginalia rail preserves horizontal eye rhythm while keeping highlights and notes immediately visible.</figcaption>
        </figure>
        <blockquote>
          <p>“Good typography is measured not by ornament, but by how effortlessly the reader forgets the interface and enters the author’s argument.”</p>
        </blockquote>
        <h2>2. Line Spacing, Paper Luminance, and Book Serifs</h2>
        <p>For long-form essays and technical papers, tight default browser leading forces adjacent lines to crowd one another optically. Setting body leading between <code>1.65</code> and <code>1.80</code> gives ascenders and descenders breathing room while making inline code, mathematical notation, and links effortless to scan.</p>
        <table>
          <thead>
            <tr>
              <th>Typographic Parameter</th>
              <th>Casual Web Default</th>
              <th>Long-Form Reading Standard</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Column Measure</td>
              <td>95–130 characters (unconstrained)</td>
              <td>55–68 characters (<code>65ch</code> default)</td>
            </tr>
            <tr>
              <td>Line Spacing (Leading)</td>
              <td>1.35 – 1.45</td>
              <td>1.70 – 1.80 generous book rhythm</td>
            </tr>
            <tr>
              <td>Canvas Surface</td>
              <td>Stark #FFFFFF blue-white glare</td>
              <td>Warm Ivory (#FAF8F5) or Archival Sepia (#F4ECD8)</td>
            </tr>
          </tbody>
        </table>
        <h2>3. Marginalia and Active Knowledge Synthesis</h2>
        <p>Inspired by Renaissance humanism and Edward Tufte’s layout principles, placing the Table of Contents on the left rail and interactive highlights on the right rail turns passive consumption into active synthesis. You can select any sentence in this essay to record a permanent highlight or press <code>F</code> at any moment to enter distraction-free Focus Mode.</p>
      </article>
    </body>
    </html>`;

    const extracted1 = extractArticle(essay1RawHtml, 'https://practicaltypography.com/long-form-digital-reading');
    const itemId1 = uuidv7();
    const revId1 = uuidv7();
    st.items[itemId1] = {
      id: itemId1,
      owner_id: user.id,
      url: 'https://practicaltypography.com/long-form-digital-reading',
      normalized_url: 'https://practicaltypography.com/long-form-digital-reading',
      canonical_url: 'https://practicaltypography.com/long-form-digital-reading',
      possible_duplicate_of: null,
      title: extracted1.title,
      author: extracted1.author,
      publisher: extracted1.publisher,
      domain: extracted1.domain,
      published_at: extracted1.publishedAt,
      description: extracted1.description,
      featured_image: extracted1.featuredImage,
      language: extracted1.language,
      reading_time_minutes: 6,
      content_type: 'article',
      processing_status: 'ready',
      error_message: null,
      error_class: null,
      current_revision_id: revId1,
      blob_id: null,
      page_count: null,
      ocr_status: 'none',
      outbound_urls: extracted1.outboundUrls,
      version: 1,
      created_at: now,
      updated_at: now,
    };
    st.item_revisions[revId1] = {
      id: revId1,
      item_id: itemId1,
      revision_number: 1,
      content_hash: extracted1.contentHash,
      extractor_name: extracted1.extractorName,
      extractor_version: extracted1.extractorVersion,
      sanitized_html: extracted1.sanitizedHtml,
      plain_text: extracted1.plainText,
      toc: extracted1.toc,
      spine: [],
      pages: [],
      created_at: now,
    };
    st.user_item_states[`${user.id}:${itemId1}`] = {
      user_id: user.id,
      item_id: itemId1,
      is_read: false,
      is_favorite: true,
      lifecycle: 'active',
      trashed_at: null,
      progress_percent: 35,
      progress_page: null,
      progress_spine: null,
      last_read_at: now,
      offline_cached: true,
      version: 1,
      updated_at: now,
    };
    const annId1 = uuidv7();
    st.annotations[annId1] = {
      id: annId1,
      item_id: itemId1,
      user_id: user.id,
      revision_id: revId1,
      type: 'highlight',
      exact_quote: 'an line measure between 55 and 70 characters (roughly two to three alphabets in width, or 65ch in CSS) minimizes ocular fatigue',
      prefix: 'Empirical typography research establishes that ',
      suffix: ' across multi-hour reading sessions.',
      start_offset: 280,
      end_offset: 408,
      page_number: null,
      spine_item: null,
      note: 'Core rule for our default 65ch reader column width.',
      color: 'yellow',
      orphaned: false,
      shared_in_collections: [],
      version: 1,
      created_at: now,
      updated_at: now,
    };

    const essay2RawHtml = `<!DOCTYPE html>
    <html lang="en">
    <head>
      <title>Local-First Knowledge Engines: SSRF-Safe Extraction and Resilient Quote Anchoring</title>
      <meta name="author" content="Systems Architecture Group" />
      <meta property="og:site_name" content="Local-First Review" />
      <meta property="article:published_time" content="2026-10-14T11:30:00Z" />
      <meta name="description" content="How self-hosted reading platforms combine resolve-and-pin SSRF defense, lazy-image promotion, and three-tier quote re-anchoring." />
    </head>
    <body>
      <article>
        <h2>1. Why Self-Hosted Readers Outlast Cloud Silos</h2>
        <p>Cloud bookmarking services frequently degrade behind paywalls, inject algorithmic feeds, or shut down entirely—taking years of personal highlights and marginalia with them. A self-hosted knowledge engine stores every extracted revision, figure, and annotation locally in an auditable, portable format.</p>
        <figure>
          <img src="${figStorageSvg}" alt="Architecture diagram of DNS-pinned extraction and immutable revisions" />
          <figcaption>Figure 2: The three-stage pipeline: DNS-pinned fetching, lazy-image promotion &amp; HTML sanitization, and immutable revision storage.</figcaption>
        </figure>
        <h2>2. Solving Lazy-Loaded Images in Modern Web Articles</h2>
        <p>Many modern blogs omit the standard <code>src</code> attribute on <code>&lt;img&gt;</code> tags, storing high-resolution illustrations inside <code>data-src</code>, <code>data-original</code>, or <code>srcset</code> attributes. Our sanitizer automatically promotes these lazy attributes into canonical, responsive images with click-to-zoom lightbox support.</p>
      </article>
    </body>
    </html>`;

    const extracted2 = extractArticle(essay2RawHtml, 'https://localfirst.dev/ssrf-safe-knowledge-engines');
    const itemId2 = uuidv7();
    const revId2 = uuidv7();
    st.items[itemId2] = {
      id: itemId2,
      owner_id: user.id,
      url: 'https://localfirst.dev/ssrf-safe-knowledge-engines',
      normalized_url: 'https://localfirst.dev/ssrf-safe-knowledge-engines',
      canonical_url: 'https://localfirst.dev/ssrf-safe-knowledge-engines',
      possible_duplicate_of: null,
      title: extracted2.title,
      author: extracted2.author,
      publisher: extracted2.publisher,
      domain: extracted2.domain,
      published_at: extracted2.publishedAt,
      description: extracted2.description,
      featured_image: extracted2.featuredImage,
      language: extracted2.language,
      reading_time_minutes: 5,
      content_type: 'article',
      processing_status: 'ready',
      error_message: null,
      error_class: null,
      current_revision_id: revId2,
      blob_id: null,
      page_count: null,
      ocr_status: 'none',
      outbound_urls: extracted2.outboundUrls,
      version: 1,
      created_at: now,
      updated_at: now,
    };
    st.item_revisions[revId2] = {
      id: revId2,
      item_id: itemId2,
      revision_number: 1,
      content_hash: extracted2.contentHash,
      extractor_name: extracted2.extractorName,
      extractor_version: extracted2.extractorVersion,
      sanitized_html: extracted2.sanitizedHtml,
      plain_text: extracted2.plainText,
      toc: extracted2.toc,
      spine: [],
      pages: [],
      created_at: now,
    };
    st.user_item_states[`${user.id}:${itemId2}`] = {
      user_id: user.id,
      item_id: itemId2,
      is_read: false,
      is_favorite: false,
      lifecycle: 'active',
      trashed_at: null,
      progress_percent: 0,
      progress_page: null,
      progress_spine: null,
      last_read_at: null,
      offline_cached: true,
      version: 1,
      updated_at: now,
    };
  });
}

export function createHttpServer(app) {
  const maxBodyBytes = Number(process.env.MAX_UPLOAD_BYTES || 55 * 1024 * 1024) + 5 * 1024 * 1024;
  return http.createServer(async (req, res) => {
    try {
      const chunks = [];
      let totalBytes = 0;
      for await (const chunk of req) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        totalBytes += buf.length;
        if (totalBytes > maxBodyBytes) {
          res.statusCode = 413;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'Payload too large', code: 'PAYLOAD_TOO_LARGE' }));
          req.destroy();
          return;
        }
        chunks.push(buf);
      }
      const rawBuf = Buffer.concat(chunks, totalBytes);
    let parsedBody = undefined;
    if (rawBuf.length > 0) {
      const ct = (req.headers['content-type'] || '').toLowerCase();
      if (ct.includes('application/json')) {
        try {
          parsedBody = JSON.parse(rawBuf.toString('utf8'));
        } catch {
          parsedBody = undefined;
        }
      } else {
        parsedBody = rawBuf.toString('utf8');
      }
    }

    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v !== undefined) {
        headers[k] = Array.isArray(v) ? v.join('; ') : String(v);
      }
    }

    const appRes = await app.handleRequest({
      method: req.method || 'GET',
      path: req.url || '/',
      headers,
      body: parsedBody,
      rawBodyBytes: rawBuf.length,
      ip: req.socket?.remoteAddress || '127.0.0.1',
    });

    res.statusCode = appRes.status;
    for (const [hk, hv] of Object.entries(appRes.headers)) {
      res.setHeader(hk, hv);
    }

      if (Buffer.isBuffer(appRes.body)) {
        res.end(appRes.body);
      } else if (typeof appRes.body === 'string') {
        res.end(appRes.body, 'utf8');
      } else {
        res.end(JSON.stringify(appRes.body));
      }
    } catch (err) {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Internal server error', code: 'INTERNAL_ERROR' }));
      }
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const db = new ContainedDatabase(process.env.DATA_DIR);
  if (process.env.NODE_ENV !== 'production' || process.env.SEED_SHOWCASE === 'true') {
    seedShowcaseEssaysIfNeeded(db);
    db.rebuildIndexes();
  }
  const app = new ReadingPlatformApp(db);
  const embeddedWorker = new WorkerEngine(db);
  const workerTimer = setInterval(() => {
    embeddedWorker.processNextJob(Date.now()).catch(() => {});
  }, 1500);
  workerTimer.unref();

  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '127.0.0.1';
  const srv = createHttpServer(app);

  const shutdown = () => {
    clearInterval(workerTimer);
    console.log(JSON.stringify({ level: 'info', event: 'web.sigterm' }));
    srv.close(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  srv.listen(port, host, () => {
    console.log(JSON.stringify({ level: 'info', event: 'web.listening', host, port }));
  });
}
