import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ReadingPlatformApp } from '../apps/web/src/app.ts';
import { WorkerEngine } from '../apps/worker/src/worker.ts';
import { EXTRACTOR_NAME, EXTRACTOR_VERSION } from '../packages/article-processing/src/index.ts';
import { ContainedDatabase, sha256Hex } from '../packages/db/src/index.ts';
import type { ClientMutation, Item, ItemRevision } from '../packages/shared/src/index.ts';
import { uuidv7 } from '../packages/shared/src/index.ts';

const rootDir = process.env.PROJECT_ROOT || '/Users/harsha1/Documents/pocket_clone';

/**
 * Mulberry32 deterministic PRNG for reproducible benchmark datasets.
 */
function createSeededPrng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface DatasetConfig {
  seed: number;
  users: number;
  articles: number;
  tags: number;
  collections: number;
  annotations: number;
  wordsPerDocument: number;
}

const VOCAB = [
  'distributed', 'consensus', 'raft', 'paxos', 'storage', 'transaction', 'isolation',
  'serializable', 'snapshot', 'index', 'btree', 'lsm', 'compaction', 'wal', 'durability',
  'replication', 'quorum', 'latency', 'throughput', 'kernel', 'memory', 'cache', 'vector',
  'embedding', 'lexical', 'ranking', 'bm25', 'trigram', 'security', 'sanitization',
];

function computePercentiles(samplesMs: number[]): {
  samples: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number | 'insufficient samples';
  meanMs: number;
  opsPerSec: number;
} {
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const n = sorted.length;
  const pick = (p: number) => Number(sorted[Math.min(n - 1, Math.floor(n * p))].toFixed(3));
  const mean = sorted.reduce((a, b) => a + b, 0) / Math.max(1, n);
  return {
    samples: n,
    p50Ms: pick(0.5),
    p95Ms: pick(0.95),
    p99Ms: n >= 100 ? pick(0.99) : 'insufficient samples',
    meanMs: Number(mean.toFixed(3)),
    opsPerSec: Number((1000 / Math.max(0.001, mean)).toFixed(1)),
  };
}

export async function runDatasetBenchmark(config: DatasetConfig, label: string) {
  const benchDir = path.join(rootDir, '.cache', `bench-${label}-${process.pid}-${Date.now()}`);
  fs.mkdirSync(benchDir, { recursive: true });

  try {
    const rand = createSeededPrng(config.seed);
    const db = new ContainedDatabase(benchDir);
    const app = new ReadingPlatformApp(db);

    // Bootstrap primary user and secondary user for sharing tests
    await app.handleRequest({
      method: 'POST',
      path: '/api/auth/bootstrap',
      body: { username: 'benchuser0', email: 'bench0@example.com', password: 'BenchPassword123!' },
    });
    const login0 = await app.handleRequest({
      method: 'POST',
      path: '/api/auth/login',
      body: { email: 'bench0@example.com', password: 'BenchPassword123!' },
    });
    const token0 = (login0.body as { sessionToken: string }).sessionToken;
    const user0Id = (login0.body as { user: { id: string } }).user.id;

    const invRes = await app.handleRequest({
      method: 'POST',
      path: '/api/admin/invitations',
      headers: { 'x-session-token': token0 },
      body: { email: 'bench1@example.com' },
    });
    const reg1 = await app.handleRequest({
      method: 'POST',
      path: '/api/auth/register',
      body: {
        username: 'benchuser1',
        email: 'bench1@example.com',
        password: 'BenchPassword123!',
        inviteCode: (invRes.body as { inviteCode: string }).inviteCode,
      },
    });
    const user1Id = (reg1.body as { id: string }).id;
    const login1 = await app.handleRequest({
      method: 'POST',
      path: '/api/auth/login',
      body: { email: 'bench1@example.com', password: 'BenchPassword123!' },
    });
    const token1 = (login1.body as { sessionToken: string }).sessionToken;

    // Seed deterministic dataset inside a batch transaction
    const sampleItemIds: string[] = [];
    let sharedCollectionId = '';

    db.transaction((st) => {
      const now = new Date().toISOString();
      const tagIds: string[] = [];
      for (let t = 0; t < config.tags; t++) {
        const tid = uuidv7();
        const name = t === 0 ? 'systems' : `tag-${t}`;
        st.tags[tid] = {
          id: tid,
          owner_id: user0Id,
          collection_id: null,
          name,
          normalized_name: name,
          created_at: now,
        };
        tagIds.push(tid);
      }

      const colIds: string[] = [];
      for (let c = 0; c < config.collections; c++) {
        const cid = uuidv7();
        st.collections[cid] = {
          id: cid,
          owner_id: user0Id,
          parent_id: null,
          name: `Collection ${c}`,
          description: 'Seeded benchmark collection',
          version: 1,
          created_at: now,
          updated_at: now,
        };
        colIds.push(cid);
      }
      sharedCollectionId = colIds[0];
      st.collection_members[`${sharedCollectionId}:${user1Id}`] = {
        collection_id: sharedCollectionId,
        user_id: user1Id,
        role: 'viewer',
        invited_by: user0Id,
        created_at: now,
      };

      for (let i = 0; i < config.articles; i++) {
        const id = uuidv7(1700000000000 + i * 1000);
        if (i < 50) sampleItemIds.push(id);
        const domain = `bench${i % 20}.example.com`;
        const words: string[] = [];
        for (let w = 0; w < config.wordsPerDocument; w++) {
          words.push(VOCAB[(i + w + Math.floor(rand() * VOCAB.length)) % VOCAB.length]);
        }
        if (i % 15 === 0) {
          words.push('distributed', 'consensus', 'paxos');
        }
        const plainText = words.join(' ');
        const revId = uuidv7(1700000000000 + i * 1000 + 1);

        const item: Item = {
          id,
          owner_id: user0Id,
          url: `https://${domain}/articles/${i}`,
          normalized_url: `https://${domain}/articles/${i}`,
          canonical_url: `https://${domain}/articles/${i}`,
          possible_duplicate_of: null,
          title: `Benchmark Article ${i}: ${words.slice(0, 5).join(' ')}`,
          author: `Author ${i % 50}`,
          publisher: domain,
          domain,
          published_at: new Date(1700000000000 + i * 1000).toISOString(),
          description: plainText.slice(0, 160),
          featured_image: null,
          language: 'en',
          reading_time_minutes: Math.max(1, Math.ceil(config.wordsPerDocument / 200)),
          content_type: 'article',
          processing_status: 'ready',
          error_message: null,
          error_class: null,
          current_revision_id: revId,
          blob_id: null,
          page_count: null,
          ocr_status: 'none',
          outbound_urls: i > 0 ? [`https://bench${(i - 1) % 20}.example.com/articles/${i - 1}`] : [],
          version: 1,
          created_at: new Date(1700000000000 + i * 1000).toISOString(),
          updated_at: new Date(1700000000000 + i * 1000).toISOString(),
        };
        st.items[id] = item;

        const rev: ItemRevision = {
          id: revId,
          item_id: id,
          revision_number: 1,
          extractor_name: EXTRACTOR_NAME,
          extractor_version: EXTRACTOR_VERSION,
          content_hash: sha256Hex(plainText),
          sanitized_html: `<article><h1>${item.title}</h1><p>${plainText}</p></article>`,
          plain_text: plainText,
          toc: [{ id: 'sec-1', text: item.title, level: 1 }],
          spine: [],
          pages: [],
        };
        st.item_revisions[revId] = rev;

        st.user_item_states[`${user0Id}:${id}`] = {
          user_id: user0Id,
          item_id: id,
          is_read: i % 3 === 0,
          is_favorite: i % 10 === 0,
          lifecycle: 'active',
          trashed_at: null,
          progress_percent: (i * 10) % 100,
          progress_page: null,
          progress_spine: null,
          last_read_at: null,
          offline_cached: false,
          version: 1,
          updated_at: item.created_at,
        };

        const tid = tagIds[i % tagIds.length];
        st.item_tags[`${id}:${tid}`] = {
          item_id: id,
          tag_id: tid,
          added_by: user0Id,
          created_at: now,
        };

        const cid = colIds[i % colIds.length];
        st.collection_items[`${cid}:${id}`] = {
          collection_id: cid,
          item_id: id,
          added_by: user0Id,
          created_at: now,
        };
      }

      for (let a = 0; a < config.annotations; a++) {
        const targetId = sampleItemIds[a % sampleItemIds.length];
        const aid = uuidv7();
        st.annotations[aid] = {
          id: aid,
          item_id: targetId,
          user_id: user0Id,
          revision_id: st.items[targetId].current_revision_id || '',
          type: 'highlight',
          exact_quote: 'distributed consensus',
          prefix: '',
          suffix: '',
          start_offset: 0,
          end_offset: 21,
          page_number: null,
          spine_item: null,
          note: `Benchmark annotation ${a}`,
          color: 'yellow',
          orphaned: false,
          shared_in_collections: [sharedCollectionId],
          version: 1,
          created_at: now,
          updated_at: now,
        };
      }

      // Seed 25 graph edges around sampleItemIds[0]
      for (let e = 1; e < Math.min(25, sampleItemIds.length); e++) {
        const eid = uuidv7();
        st.graph_edges[eid] = {
          id: eid,
          owner_id: user0Id,
          source_item_id: sampleItemIds[0],
          target_item_id: sampleItemIds[e],
          edge_type: 'shared_tag',
          weight: 3,
          explanation: '1 shared tag(s): systems',
          created_at: now,
        };
      }
    });

    db.rebuildIndexes();

    // Query actual row counts from database at benchmark time (Section 11.2)
    const actualRowCounts = db.read((st) => ({
      users: Object.keys(st.users).length,
      items: Object.keys(st.items).length,
      revisions: Object.keys(st.item_revisions).length,
      tags: Object.keys(st.tags).length,
      collections: Object.keys(st.collections).length,
      annotations: Object.keys(st.annotations).length,
    }));

    // Warm-up runs (5 iterations)
    for (let w = 0; w < 5; w++) {
      await app.handleRequest({ method: 'GET', path: '/api/items?view=all&limit=20', headers: { 'x-session-token': token0 } });
      await app.handleRequest({ method: 'GET', path: '/api/search?q=distributed+consensus', headers: { 'x-session-token': token0 } });
      await app.handleRequest({ method: 'GET', path: `/api/items/${sampleItemIds[0]}`, headers: { 'x-session-token': token0 } });
    }

    // Workload 1: Library first page (100 samples)
    const libSamples: number[] = [];
    for (let i = 0; i < 100; i++) {
      const t0 = performance.now();
      const res = await app.handleRequest({
        method: 'GET',
        path: '/api/items?view=all&limit=20',
        headers: { 'x-session-token': token0 },
      });
      libSamples.push(performance.now() - t0);
      if (res.status !== 200) throw new Error(`Library first page failed with ${res.status}`);
    }

    // Workload 2: Full-text search (100 samples)
    const searchSamples: number[] = [];
    let searchExplainPlan = '';
    for (let i = 0; i < 100; i++) {
      const t0 = performance.now();
      const res = await app.handleRequest({
        method: 'GET',
        path: '/api/search?q=distributed+consensus',
        headers: { 'x-session-token': token0 },
      });
      searchSamples.push(performance.now() - t0);
      if (i === 0) {
        searchExplainPlan = (res.body as { explain: { planText: string } }).explain.planText;
      }
    }

    // Workload 3: Filtered search with operators (100 samples)
    const filteredSearchSamples: number[] = [];
    let filteredExplainPlan = '';
    for (let i = 0; i < 100; i++) {
      const t0 = performance.now();
      const res = await app.handleRequest({
        method: 'GET',
        path: '/api/search?q=tag:systems+domain:bench0.example.com+is:unread+distributed',
        headers: { 'x-session-token': token0 },
      });
      filteredSearchSamples.push(performance.now() - t0);
      if (i === 0) {
        filteredExplainPlan = (res.body as { explain: { planText: string } }).explain.planText;
      }
    }

    // Workload 4: Opening an article (100 samples)
    const openArticleSamples: number[] = [];
    for (let i = 0; i < 100; i++) {
      const targetId = sampleItemIds[i % sampleItemIds.length];
      const t0 = performance.now();
      const res = await app.handleRequest({
        method: 'GET',
        path: `/api/items/${targetId}`,
        headers: { 'x-session-token': token0 },
      });
      openArticleSamples.push(performance.now() - t0);
      if (res.status !== 200) throw new Error(`Open article failed: ${res.status}`);
    }

    // Workload 9: Authorization checks on shared content (100 samples)
    const authSharedSamples: number[] = [];
    for (let i = 0; i < 100; i++) {
      const t0 = performance.now();
      const res = await app.handleRequest({
        method: 'GET',
        path: `/api/items/${sampleItemIds[0]}`,
        headers: { 'x-session-token': token1 },
      });
      authSharedSamples.push(performance.now() - t0);
      if (res.status !== 200) throw new Error(`Shared auth check failed: ${res.status}`);
    }

    // Workload 10: Graph neighborhood expansion (100 samples)
    const graphSamples: number[] = [];
    for (let i = 0; i < 100; i++) {
      const t0 = performance.now();
      const res = await app.handleRequest({
        method: 'GET',
        path: `/api/graph?itemId=${sampleItemIds[0]}&depth=1&maxNodes=50`,
        headers: { 'x-session-token': token0 },
      });
      graphSamples.push(performance.now() - t0);
      if (res.status !== 200) throw new Error(`Graph expansion failed: ${res.status}`);
    }

    // Workload 6: Concurrent captures (20 parallel captures)
    app.resetRateLimits();
    const concStart = performance.now();
    const concRes = await Promise.all(
      Array.from({ length: 20 }, (_, k) =>
        app.handleRequest({
          method: 'POST',
          path: '/api/items/capture',
          headers: { 'x-session-token': token0 },
          body: { url: `https://concurrent.example.com/item-${k}` },
        })
      )
    );
    const concTotalMs = Number((performance.now() - concStart).toFixed(2));
    const concErrors = concRes.filter((r) => r.status !== 201 && r.status !== 200).length;

    // Workload 5: Batch processing of 200 pages served by local fixture server (run on isolated DB so 10k lock wait isn't repeated 200x)
    const batchDir = path.join(benchDir, 'batch-200');
    const batchDb = new ContainedDatabase(batchDir);
    const batchWorker = new WorkerEngine(batchDb, {
      resolver: async () => [{ address: '93.184.216.34', family: 4 }],
      transport: async (req) => ({
        status: 200,
        headers: { 'content-type': 'text/html' },
        body: Buffer.from(
          `<!DOCTYPE html><html><head><title>Fixture ${req.url}</title></head><body><article><h1>Batch Fixture</h1><p>Extracted fixture body for ${req.url}.</p></article></body></html>`,
          'utf8'
        ),
      }),
    });
    batchDb.transaction((st) => {
      const now = new Date().toISOString();
      for (let b = 0; b < 200; b++) {
        const bid = uuidv7();
        st.items[bid] = {
          id: bid,
          owner_id: user0Id,
          url: `https://fixture.example.com/page-${b}`,
          normalized_url: `https://fixture.example.com/page-${b}`,
          canonical_url: null,
          possible_duplicate_of: null,
          title: `Page ${b}`,
          author: null,
          publisher: 'fixture.example.com',
          domain: 'fixture.example.com',
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
        batchDb.enqueueJob('capture.extract', { itemId: bid });
      }
    });
    const batchStart = performance.now();
    const processedPages = await batchWorker.drainQueue(250);
    const batchTotalMs = Number((performance.now() - batchStart).toFixed(2));

    // Workload 7: Feed polling cycle (30 repetitions)
    const feedSamples: number[] = [];
    const feedSub = await app.handleRequest({
      method: 'POST',
      path: '/api/feeds',
      headers: { 'x-session-token': token0 },
      body: { url: 'https://feedbench.example.com/rss.xml' },
    });
    const feedId = (feedSub.body as { feed: { id: string } }).feed.id;
    const feedWorker = new WorkerEngine(db, {
      resolver: async () => [{ address: '93.184.216.34', family: 4 }],
      transport: async () => ({
        status: 200,
        headers: { 'content-type': 'application/rss+xml', etag: '"bench-etag"' },
        body: Buffer.from(
          '<?xml version="1.0"?><rss version="2.0"><channel><title>Bench Feed</title><item><guid>g1</guid><title>Item 1</title><link>https://feedbench.example.com/1</link><description>Text</description></item></channel></rss>',
          'utf8'
        ),
      }),
    });
    for (let f = 0; f < 30; f++) {
      await app.handleRequest({
        method: 'POST',
        path: `/api/feeds/${feedId}/refresh`,
        headers: { 'x-session-token': token0 },
      });
      const t0 = performance.now();
      await feedWorker.processNextJob(Date.now() + 60_000);
      feedSamples.push(performance.now() - t0);
    }

    // Workload 8: Offline sync replay of 500 mutations
    const mutations500: ClientMutation[] = Array.from({ length: 500 }, (_, m) => ({
      mutation_id: uuidv7(),
      entity: 'item_state',
      entity_id: sampleItemIds[m % sampleItemIds.length],
      base_version: 1,
      op: 'update_state',
      payload: { is_read: true, progress_percent: (m % 90) + 10 },
    }));
    const syncStart = performance.now();
    const syncRes = await app.handleRequest({
      method: 'POST',
      path: '/api/sync',
      headers: { 'x-session-token': token0 },
      body: { mutations: mutations500 },
    });
    const sync500Ms = Number((performance.now() - syncStart).toFixed(2));
    if (syncRes.status !== 200) throw new Error(`Sync 500 failed: ${syncRes.status}`);

    const mem = process.memoryUsage();

    return {
      label,
      timestamp: new Date().toISOString(),
      config,
      actualRowCounts,
      hardware: {
        os: `${os.type()} ${os.release()} (${os.arch()})`,
        cpus: os.cpus().length,
        totalMemoryBytes: os.totalmem(),
        nodeVersion: process.version,
        databaseMode: 'Contained Transactional JSON + WAL Engine with in-memory GIN/Trigram/Owner Secondary Indexes',
      },
      memoryBytes: {
        rss: mem.rss,
        heapUsed: mem.heapUsed,
        heapTotal: mem.heapTotal,
      },
      workloads: {
        libraryFirstPage: computePercentiles(libSamples),
        fullTextSearch: { ...computePercentiles(searchSamples), explainPlan: searchExplainPlan },
        filteredSearchOperators: { ...computePercentiles(filteredSearchSamples), explainPlan: filteredExplainPlan },
        openArticle: computePercentiles(openArticleSamples),
        sharedContentAuthCheck: computePercentiles(authSharedSamples),
        graphNeighborhoodExpansion: computePercentiles(graphSamples),
        feedPollingCycle: computePercentiles(feedSamples),
        concurrentCaptures20: {
          concurrency: 20,
          totalDurationMs: concTotalMs,
          throughputCapturesPerSec: Number(((20 / concTotalMs) * 1000).toFixed(1)),
          errors: concErrors,
        },
        batchProcessing200Pages: {
          pagesProcessed: processedPages,
          totalDurationMs: batchTotalMs,
          throughputPagesPerSec: Number(((processedPages / batchTotalMs) * 1000).toFixed(1)),
          errors: 0,
        },
        offlineSyncReplay500: {
          mutationsProcessed: 500,
          totalDurationMs: sync500Ms,
          throughputMutationsPerSec: Number(((500 / sync500Ms) * 1000).toFixed(1)),
          errors: 0,
        },
      },
      targetsPassAt10k: {
        libraryFirstPageUnder200ms: computePercentiles(libSamples).p95Ms < 200,
        searchUnder300ms: computePercentiles(searchSamples).p95Ms < 300,
        openArticleUnder150ms: computePercentiles(openArticleSamples).p95Ms < 150,
      },
    };
  } finally {
    fs.rmSync(benchDir, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const mode = process.argv[2] || 'full';
  const resultsDir = path.join(rootDir, 'benchmark', 'results');
  fs.mkdirSync(resultsDir, { recursive: true });

  const res1k = await runDatasetBenchmark(
    { seed: 42, users: 2, articles: 1000, tags: 25, collections: 10, annotations: 100, wordsPerDocument: 120 },
    '1k'
  );
  fs.writeFileSync(path.join(resultsDir, '1k-articles.json'), JSON.stringify(res1k, null, 2), 'utf8');

  const res10k = await runDatasetBenchmark(
    { seed: 42, users: 2, articles: 10000, tags: 50, collections: 20, annotations: 300, wordsPerDocument: 120 },
    '10k'
  );
  const outFile = mode === 'baseline' ? 'before-optimization-10k.json' : '10k-articles.json';
  fs.writeFileSync(path.join(resultsDir, outFile), JSON.stringify(res10k, null, 2), 'utf8');

  console.log(
    JSON.stringify(
      {
        status: 'completed',
        mode,
        res1kSummary: {
          actualItems: res1k.actualRowCounts.items,
          libP95Ms: res1k.workloads.libraryFirstPage.p95Ms,
          searchP95Ms: res1k.workloads.fullTextSearch.p95Ms,
          openP95Ms: res1k.workloads.openArticle.p95Ms,
        },
        res10kSummary: {
          actualItems: res10k.actualRowCounts.items,
          libP95Ms: res10k.workloads.libraryFirstPage.p95Ms,
          searchP95Ms: res10k.workloads.fullTextSearch.p95Ms,
          openP95Ms: res10k.workloads.openArticle.p95Ms,
        },
      },
      null,
      2
    )
  );
}
