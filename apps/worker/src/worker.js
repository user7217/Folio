import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  EXTRACTOR_NAME,
  EXTRACTOR_VERSION,
  extractArticle,
  parseFeedXml,
} from '../../../packages/article-processing/src/index.js';
import { ContainedDatabase, sha256Hex } from '../../../packages/db/src/index.js';
import { uuidv7 } from '../../../packages/shared/src/index.js';
import { SsrfError, safeFetch } from '../../../packages/shared/src/ssrf.js';
import { redactUrlForLog } from '../../../packages/shared/src/url.js';

export class WorkerEngine {
  db;
  workerId;
  staleTimeoutMs;
  shuttingDown = false;
  activeJobIds = new Set();
  processedCount = 0;

  constructor(db, options = {}) {
    this.db = db;
    this.workerId = options.workerId || `worker-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
    this.staleTimeoutMs = options.staleTimeoutMs ?? Number(process.env.WORKER_STALE_TIMEOUT_MS || 30_000);
    this.resolver = options.resolver;
    this.transport = options.transport;
    this.allowedPorts = options.allowedPorts;
    this.simulateSlowHookMs = options.simulateSlowHookMs ?? 0;
  }

  setNetworkFixtures(resolver, transport, allowedPorts) {
    this.resolver = resolver;
    this.transport = transport;
    this.allowedPorts = allowedPorts;
  }

  recordHeartbeat() {
    this.db.transaction((st) => {
      st.worker_heartbeats[this.workerId] = {
        worker_id: this.workerId,
        pid: process.pid,
        last_seen_at: new Date().toISOString(),
        active_jobs: this.activeJobIds.size,
        processed_count: this.processedCount,
      };
    });
  }

  /**
   * Reclaims jobs stuck in `running` state past their `timeout_ms` or `staleTimeoutMs`
   * (e.g. when a worker process was killed with SIGKILL mid-job).
   */
  recoverStaleJobs(nowMs = Date.now()) {
    return this.db.transaction((st) => {
      let recovered = 0;
      const nowIso = new Date(nowMs).toISOString();
      for (const job of Object.values(st.jobs)) {
        if (job.status !== 'running' || !job.locked_at) continue;
        const lockedMs = Date.parse(job.locked_at);
        const limitMs = Math.min(job.timeout_ms || this.staleTimeoutMs, this.staleTimeoutMs);
        if (nowMs - lockedMs >= limitMs) {
          recovered++;
          if (job.attempts >= job.max_attempts) {
            job.status = 'dead_letter';
            job.locked_by = null;
            job.locked_at = null;
            job.last_error = 'Job exceeded stale lock timeout and max_attempts';
            job.updated_at = nowIso;
          } else {
            job.status = 'queued';
            job.locked_by = null;
            job.locked_at = null;
            job.run_after = nowIso;
            job.last_error = 'Recovered from stale worker lock';
            job.updated_at = nowIso;
          }
        }
      }
      return recovered;
    });
  }

  /**
   * Claims and executes the next eligible queued job. Returns null if no job is ready.
   */
  async processNextJob(nowMs = Date.now()) {
    if (this.shuttingDown) return null;
    this.recoverStaleJobs(nowMs);

    const claimed = this.db.transaction((st) => {
      const nowIso = new Date(nowMs).toISOString();
      const candidates = Object.values(st.jobs)
        .filter((j) => j.status === 'queued' && Date.parse(j.run_after) <= nowMs)
        .sort((a, b) => a.created_at.localeCompare(b.created_at));

      const next = candidates[0];
      if (!next) return null;

      next.status = 'running';
      next.attempts += 1;
      next.locked_by = this.workerId;
      next.locked_at = nowIso;
      next.updated_at = nowIso;
      return { ...next };
    });

    if (!claimed) {
      this.recordHeartbeat();
      return null;
    }

    this.activeJobIds.add(claimed.id);
    this.recordHeartbeat();
    const startHr = performance.now();

    try {
      if (this.simulateSlowHookMs > 0) {
        await new Promise((r) => setTimeout(r, this.simulateSlowHookMs));
      }
      if (this.shuttingDown) {
        // Release back to queue on graceful shutdown
        this.db.transaction((st) => {
          const j = st.jobs[claimed.id];
          if (j && j.status === 'running') {
            j.status = 'queued';
            j.attempts = Math.max(0, j.attempts - 1);
            j.locked_by = null;
            j.locked_at = null;
            j.updated_at = new Date().toISOString();
          }
        });
        return null;
      }

      await this.executeJobPayload(claimed);

      const durationMs = Math.round(performance.now() - startHr);
      const finished = this.db.transaction((st) => {
        const j = st.jobs[claimed.id];
        if (!j) return null;
        j.status = 'completed';
        j.locked_by = null;
        j.locked_at = null;
        j.duration_ms = durationMs;
        j.updated_at = new Date().toISOString();
        return { ...j };
      });
      this.processedCount++;
      return finished;
    } catch (err) {
      const durationMs = Math.round(performance.now() - startHr);
      const isPermanent =
        err instanceof SsrfError && err.errorClass === 'permanent';
      const errMsg = err instanceof Error ? err.message : String(err);

      const failedJob = this.db.transaction((st) => {
        const j = st.jobs[claimed.id];
        if (!j) return null;
        j.locked_by = null;
        j.locked_at = null;
        j.duration_ms = durationMs;
        j.last_error = errMsg;
        j.error_class = isPermanent ? 'permanent' : 'transient';
        j.updated_at = new Date().toISOString();

        if (isPermanent || j.attempts >= j.max_attempts) {
          j.status = isPermanent ? 'failed' : 'dead_letter';
          if (j.type === 'capture.extract') {
            const itemId = String(j.payload?.itemId || '');
            const item = st.items[itemId];
            if (item) {
              item.processing_status = 'failed';
              item.error_message = errMsg;
              item.error_class = j.error_class;
              item.updated_at = j.updated_at;
            }
          }
        } else {
          // Exponential backoff retry
          const backoffMs = Math.min(30_000, 100 * 2 ** (j.attempts - 1));
          j.status = 'queued';
          j.run_after = new Date(Date.now() + backoffMs).toISOString();
        }
        return { ...j };
      });
      return failedJob;
    } finally {
      this.activeJobIds.delete(claimed.id);
      this.recordHeartbeat();
    }
  }

  async drainQueue(maxJobs = 500) {
    let count = 0;
    while (count < maxJobs) {
      const res = await this.processNextJob(Date.now() + 60_000);
      if (!res) break;
      count++;
    }
    return count;
  }

  async executeJobPayload(job) {
    if (job.type === 'capture.extract') {
      const itemId = String(job.payload?.itemId || '');
      const item = this.db.read((st) => st.items[itemId]);
      if (!item) return;

      this.db.transaction((st) => {
        if (st.items[itemId]) {
          st.items[itemId].processing_status = 'fetching';
          st.items[itemId].updated_at = new Date().toISOString();
        }
      });

      const fetchRes = await safeFetch(item.url, {
        resolver: this.resolver,
        transport: this.transport,
        allowedPorts: this.allowedPorts,
        timeoutMs: job.timeout_ms || 10_000,
      });

      this.db.transaction((st) => {
        if (st.items[itemId]) {
          st.items[itemId].processing_status = 'extracting';
          st.items[itemId].updated_at = new Date().toISOString();
        }
      });

      const rawHtml = fetchRes.body.toString('utf8');
      const extracted = extractArticle(rawHtml, fetchRes.finalUrl);

      // Check canonical URL possible duplicate (Section 6.4)
      let possibleDuplicateOf = null;
      if (extracted.canonicalUrl) {
        this.db.read((st) => {
          for (const other of Object.values(st.items)) {
            if (
              other.id !== item.id &&
              other.owner_id === item.owner_id &&
              (other.normalized_url === extracted.canonicalUrl ||
                other.canonical_url === extracted.canonicalUrl)
            ) {
              possibleDuplicateOf = other.id;
              break;
            }
          }
        });
      }

      this.db.applyNewRevision(
        item.id,
        {
          extractor_name: extracted.extractorName || EXTRACTOR_NAME,
          extractor_version: extracted.extractorVersion || EXTRACTOR_VERSION,
          content_hash: extracted.contentHash,
          sanitized_html: extracted.sanitizedHtml,
          plain_text: extracted.plainText,
          toc: extracted.toc,
          spine: [],
          pages: [],
        },
        {
          title: extracted.title || item.title,
          author: extracted.author,
          publisher: extracted.publisher,
          domain: extracted.domain,
          canonical_url: extracted.canonicalUrl,
          possible_duplicate_of: possibleDuplicateOf,
          published_at: extracted.publishedAt,
          description: extracted.description,
          featured_image: extracted.featuredImage,
          language: extracted.language,
          reading_time_minutes: extracted.readingTimeMinutes,
          processing_status: extracted.status,
          error_message: null,
          error_class: null,
          outbound_urls: extracted.outboundUrls,
        }
      );

      this.db.transaction(() =>
        this.db.enqueueJob('graph.recompute', { ownerId: item.owner_id }, { idempotencyKey: `graph:${item.owner_id}` })
      );
      return;
    }

    if (job.type === 'feed.poll') {
      const feedId = String(job.payload?.feedId || '');
      const feed = this.db.read((st) => st.feeds[feedId]);
      if (!feed) return;

      const reqHeaders = {};
      if (feed.etag) reqHeaders['If-None-Match'] = feed.etag;
      if (feed.last_modified) reqHeaders['If-Modified-Since'] = feed.last_modified;

      try {
        const res = await safeFetch(feed.url, {
          resolver: this.resolver,
          transport: this.transport,
          allowedPorts: this.allowedPorts,
          headers: reqHeaders,
          timeoutMs: job.timeout_ms || 10_000,
        });

        const nowIso = new Date().toISOString();
        if (res.status === 304) {
          this.db.transaction((st) => {
            const f = st.feeds[feedId];
            if (f) {
              f.last_polled_at = nowIso;
              f.last_error = null;
              f.updated_at = nowIso;
            }
          });
          return;
        }

        const parsed = parseFeedXml(res.body.toString('utf8'), res.finalUrl);
        this.db.transaction((st) => {
          const f = st.feeds[feedId];
          if (!f) return;
          f.title = parsed.title || f.title;
          f.description = parsed.description ?? f.description;
          f.site_url = parsed.siteUrl ?? f.site_url;
          f.etag = res.headers['etag'] || f.etag;
          f.last_modified = res.headers['last-modified'] || f.last_modified;
          f.last_polled_at = nowIso;
          f.last_error = null;
          f.error_count = 0;
          f.updated_at = nowIso;

          const existingKeys = new Set();
          for (const entry of Object.values(st.feed_entries)) {
            if (entry.feed_id === feedId) {
              existingKeys.add(entry.dedup_key);
            }
          }

          for (const pe of parsed.entries) {
            if (existingKeys.has(pe.dedupKey)) continue;
            existingKeys.add(pe.dedupKey);
            const entry = {
              id: uuidv7(),
              feed_id: feedId,
              owner_id: f.owner_id,
              guid: pe.guid,
              dedup_key: pe.dedupKey,
              url: pe.url,
              title: pe.title,
              author: pe.author,
              summary: pe.summary,
              content_html: pe.contentHtml,
              published_at: pe.publishedAt,
              is_read: false,
              saved_item_id: null,
              created_at: nowIso,
            };
            st.feed_entries[entry.id] = entry;
          }
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.db.transaction((st) => {
          const f = st.feeds[feedId];
          if (f) {
            f.last_error = msg;
            f.error_count = (f.error_count || 0) + 1;
            f.last_polled_at = new Date().toISOString();
            f.updated_at = f.last_polled_at;
          }
        });
        throw err;
      }
      return;
    }

    if (job.type === 'graph.recompute') {
      const ownerId = String(job.payload?.ownerId || '');
      if (ownerId) {
        this.db.recomputeGraphForOwner(ownerId);
      }
      return;
    }

    if (job.type === 'blob.cleanup') {
      const blobId = String(job.payload?.blobId || '');
      if (blobId) {
        this.db.blobs.delete(blobId);
      }
      return;
    }

    if (job.type === 'export.generate') {
      const exportId = String(job.payload?.exportId || '');
      const userId = String(job.payload?.userId || '');
      const format = String(job.payload?.format || 'json');
      const rawToken = String(job.payload?.rawToken || '');
      const tokenHash = String(job.payload?.downloadTokenHash || (rawToken ? sha256Hex(rawToken) : ''));

      const payloadBuffer = this.db.read((st) => {
        const items = Object.values(st.items).filter((i) => this.db.canUserReadItem(userId, i));
        if (format === 'csv') {
          const rows = ['url,title,domain,status,created_at'];
          for (const it of items) {
            const esc = (v) => {
              const raw = v || '';
              const safeFormula = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
              return `"${safeFormula.replace(/"/g, '""')}"`;
            };
            rows.push([esc(it.url), esc(it.title), esc(it.domain), esc(it.processing_status), esc(it.created_at)].join(','));
          }
          return Buffer.from(rows.join('\n'), 'utf8');
        }
        if (format === 'opml') {
          const xmlEsc = (s) =>
            (s || '')
              .replace(/&/g, '&amp;')
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;')
              .replace(/"/g, '&quot;')
              .replace(/'/g, '&apos;');
          const feeds = Object.values(st.feeds).filter((f) => f.owner_id === userId);
          const outlines = feeds
            .map(
              (f) =>
                `    <outline type="rss" text="${xmlEsc(f.title)}" xmlUrl="${xmlEsc(f.url)}" />`
            )
            .join('\n');
          const opml = `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0">\n  <head><title>Subscriptions</title></head>\n  <body>\n${outlines}\n  </body>\n</opml>`;
          return Buffer.from(opml, 'utf8');
        }

        // Default: Versioned JSON export (Section 8.10)
        const states = items.map((i) => this.db.getOrCreateUserItemState(userId, i.id));
        const tags = Object.values(st.tags).filter((t) => t.owner_id === userId);
        const itemTags = Object.values(st.item_tags).filter((it) => items.some((i) => i.id === it.item_id));
        const collections = Object.values(st.collections).filter(
          (c) => c.owner_id === userId || Boolean(st.collection_members[`${c.id}:${userId}`])
        );
        const annotations = Object.values(st.annotations).filter((a) => a.user_id === userId);
        const feeds = Object.values(st.feeds).filter((f) => f.owner_id === userId);

        return Buffer.from(
          JSON.stringify(
            {
              schema_version: '2.0',
              exported_at: new Date().toISOString(),
              user_id: userId,
              items,
              states,
              tags,
              item_tags: itemTags,
              collections,
              annotations,
              feeds,
            },
            null,
            2
          ),
          'utf8'
        );
      });

      const blobId = this.db.blobs.put(payloadBuffer);
      this.db.transaction((st) => {
        st.export_artifacts[exportId] = {
          id: exportId,
          user_id: userId,
          format,
          blob_id: blobId,
          download_token_hash: tokenHash,
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
          created_at: new Date().toISOString(),
        };
      });
      return;
    }
  }

  requestGracefulShutdown() {
    this.shuttingDown = true;
  }
}

// Standalone CLI execution when `node apps/worker/src/worker.ts` is spawned
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const db = new ContainedDatabase(process.env.DATA_DIR);
  const slowMs = Number(process.env.WORKER_SIMULATE_SLOW_MS || 0);
  const worker = new WorkerEngine(db, {
    workerId: process.env.WORKER_ID,
    simulateSlowHookMs: slowMs,
  });

  let stopping = false;
  const handleSigterm = () => {
    stopping = true;
    worker.requestGracefulShutdown();
    console.log(JSON.stringify({ level: 'info', event: 'worker.sigterm', workerId: worker.workerId }));
  };
  process.on('SIGTERM', handleSigterm);
  process.on('SIGINT', handleSigterm);

  const pollInterval = Number(process.env.WORKER_POLL_INTERVAL_MS || 200);
  console.log(
    JSON.stringify({
      level: 'info',
      event: 'worker.started',
      workerId: worker.workerId,
      pid: process.pid,
      dataDir: redactUrlForLog(`file://${db.dataDir}`),
    })
  );

  const loop = async () => {
    while (!stopping) {
      await worker.processNextJob();
      if (stopping) break;
      await new Promise((r) => setTimeout(r, pollInterval));
    }
    process.exit(0);
  };
  loop().catch((err) => {
    console.error(JSON.stringify({ level: 'error', event: 'worker.fatal', message: String(err) }));
    process.exit(1);
  });
}
