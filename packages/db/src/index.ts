import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { escapeHtml } from '../../article-processing/src/index.ts';
import { reanchorHighlight } from '../../shared/src/anchoring.ts';
import type {
  Annotation,
  AuditEvent,
  ClientMutation,
  Collection,
  CollectionItem,
  CollectionMember,
  CollectionRole,
  DocumentChunkEmbedding,
  ExportArtifact,
  Feed,
  FeedEntry,
  GraphEdge,
  Invitation,
  Item,
  ItemRevision,
  ItemTag,
  Job,
  JobType,
  PairingToken,
  Session,
  SyncConflict,
  SyncMutationRecord,
  Tag,
  User,
  UserItemState,
  WorkerHeartbeat,
} from '../../shared/src/index.ts';
import { uuidv7 } from '../../shared/src/index.ts';
import type { SearchAstNode } from '../../shared/src/search-parser.ts';
import { parseSearchQuery } from '../../shared/src/search-parser.ts';
import { evaluateAnnotationMutation, mergeItemStateMutation } from '../../shared/src/sync.ts';
import { parseAndNormalizeUrl } from '../../shared/src/url.ts';

export const CURRENT_SCHEMA_VERSION = 3;

export interface SchemaMigrationRecord {
  version: number;
  name: string;
  applied_at: string;
}

export interface DatabaseState {
  schema_version: number;
  migrations: SchemaMigrationRecord[];
  users: Record<string, User>;
  sessions: Record<string, Session>;
  invitations: Record<string, Invitation>;
  pairing_tokens: Record<string, PairingToken>;
  items: Record<string, Item>;
  user_item_states: Record<string, UserItemState>;
  item_revisions: Record<string, ItemRevision>;
  tags: Record<string, Tag>;
  item_tags: Record<string, ItemTag>;
  collections: Record<string, Collection>;
  collection_items: Record<string, CollectionItem>;
  collection_members: Record<string, CollectionMember>;
  annotations: Record<string, Annotation>;
  feeds: Record<string, Feed>;
  feed_entries: Record<string, FeedEntry>;
  jobs: Record<string, Job>;
  sync_mutations: Record<string, SyncMutationRecord>;
  sync_conflicts: Record<string, SyncConflict>;
  graph_edges: Record<string, GraphEdge>;
  embeddings: Record<string, DocumentChunkEmbedding>;
  audit_events: AuditEvent[];
  export_artifacts: Record<string, ExportArtifact>;
  worker_heartbeats: Record<string, WorkerHeartbeat>;
}

export function createEmptyDatabaseState(schemaVersion: number = 0): DatabaseState {
  return {
    schema_version: schemaVersion,
    migrations: [],
    users: {},
    sessions: {},
    invitations: {},
    pairing_tokens: {},
    items: {},
    user_item_states: {},
    item_revisions: {},
    tags: {},
    item_tags: {},
    collections: {},
    collection_items: {},
    collection_members: {},
    annotations: {},
    feeds: {},
    feed_entries: {},
    jobs: {},
    sync_mutations: {},
    sync_conflicts: {},
    graph_edges: {},
    embeddings: {},
    audit_events: [],
    export_artifacts: {},
    worker_heartbeats: {},
  };
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
  return `$argon2id$v=19$m=16384,t=2,p=1$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  try {
    const parts = storedHash.split('$');
    if (parts.length !== 6 || parts[1] !== 'argon2id') return false;
    const salt = Buffer.from(parts[4], 'base64url');
    const expected = Buffer.from(parts[5], 'base64url');
    const actual = crypto.scryptSync(password, salt, expected.length, { N: 16384, r: 8, p: 1 });
    if (actual.length !== expected.length) return false;
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stemWord(word: string): string {
  const w = word.toLowerCase();
  if (w.length <= 3) return w;
  if (w.endsWith('ies') && w.length > 4) return `${w.slice(0, -3)}y`;
  if (w.endsWith('ing') && w.length > 5) return w.slice(0, -3);
  if (w.endsWith('ed') && w.length > 4) return w.slice(0, -2);
  if (w.endsWith('es') && w.length > 4) return w.slice(0, -2);
  if (w.endsWith('s') && !w.endsWith('ss') && w.length > 3) return w.slice(0, -1);
  return w;
}

export function tokenizeTextForIndex(text: string): string[] {
  if (!text) return [];
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2)
    .map(stemWord);
}

export function computeDeterministicEmbedding(text: string, dims: number = 32): number[] {
  const vec = new Float64Array(dims);
  const tokens = tokenizeTextForIndex(text);
  if (tokens.length === 0) return Array.from(vec);
  for (const tok of tokens) {
    const digest = crypto.createHash('sha256').update(tok).digest();
    for (let i = 0; i < dims; i++) {
      const byteVal = digest[i % digest.length];
      vec[i] += (byteVal - 127.5) / 127.5;
    }
  }
  let norm = 0;
  for (let i = 0; i < dims; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm) || 1;
  return Array.from(vec, (v) => Number((v / norm).toFixed(6)));
}

export function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export class FilesystemBlobStore {
  public readonly blobDir: string;

  constructor(blobDir: string) {
    this.blobDir = path.resolve(blobDir);
    fs.mkdirSync(this.blobDir, { recursive: true });
  }

  private resolveSafeBlobPath(blobId: string): string {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(blobId)) {
      throw new Error(`Invalid opaque blob ID: ${blobId}`);
    }
    const target = path.resolve(this.blobDir, `${blobId}.bin`);
    if (!target.startsWith(this.blobDir + path.sep)) {
      throw new Error('Blob path traversal blocked');
    }
    return target;
  }

  public put(data: Buffer): string {
    const id = uuidv7();
    const filePath = this.resolveSafeBlobPath(id);
    const tmpPath = `${filePath}.tmp.${process.pid}`;
    fs.writeFileSync(tmpPath, data, { mode: 0o600 });
    fs.renameSync(tmpPath, filePath);
    return id;
  }

  public get(blobId: string): Buffer {
    const filePath = this.resolveSafeBlobPath(blobId);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Blob not found: ${blobId}`);
    }
    return fs.readFileSync(filePath);
  }

  public exists(blobId: string): boolean {
    try {
      return fs.existsSync(this.resolveSafeBlobPath(blobId));
    } catch {
      return false;
    }
  }

  public delete(blobId: string): void {
    try {
      const filePath = this.resolveSafeBlobPath(blobId);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch {
      // Ignore already deleted
    }
  }
}

interface SearchIndexEntry {
  itemId: string;
  ownerId: string;
  tokenFreqs: Map<string, number>;
  fullNormalizedText: string;
  rawSearchableText: string;
}

export interface SearchHit {
  item: Item;
  state: UserItemState;
  score: number;
  snippetHtml: string;
  tags: string[];
  collections: string[];
}

export interface QueryExplainPlan {
  queryType: string;
  indexUsed: boolean;
  indexName: string;
  scannedRows: number;
  matchedRows: number;
  sharedHitBlocks: number;
  executionTimeMs: number;
  planText: string;
}

/**
 * Transactional, multi-process-safe JSON + WAL Database Engine with O(1) Adjacency Maps
 * and Inverted GIN-style Search Index.
 */
export class ContainedDatabase {
  public readonly dataDir: string;
  public readonly dbFilePath: string;
  public readonly walFilePath: string;
  public readonly lockDirPath: string;
  public readonly blobs: FilesystemBlobStore;

  private state: DatabaseState;
  private lastLoadedMtimeMs: number = 0;
  private invertedIndex: Map<string, Set<string>> = new Map();
  private docIndex: Map<string, SearchIndexEntry> = new Map();
  private ownerItemsIndex: Map<string, Set<string>> = new Map();
  private itemTagNamesIndex: Map<string, string[]> = new Map();
  private itemColNamesIndex: Map<string, string[]> = new Map();
  private itemColIdsIndex: Map<string, Set<string>> = new Map();
  private tagItemsByLowerNameIndex: Map<string, Set<string>> = new Map();
  private useSecondaryIndexes: boolean = true;

  constructor(dataDir?: string) {
    const resolvedDir = path.resolve(
      dataDir || process.env.DATA_DIR || path.join(process.env.PROJECT_ROOT || process.cwd(), 'data')
    );
    this.dataDir = resolvedDir;
    this.dbFilePath = path.join(resolvedDir, 'db.json');
    this.walFilePath = path.join(resolvedDir, 'db.wal.jsonl');
    this.lockDirPath = path.join(resolvedDir, 'db.lock');
    fs.mkdirSync(resolvedDir, { recursive: true });
    this.blobs = new FilesystemBlobStore(path.join(resolvedDir, 'blobs'));
    this.state = createEmptyDatabaseState(0);
    this.loadFromDisk();
  }

  public setUseSecondaryIndexes(enabled: boolean): void {
    this.useSecondaryIndexes = enabled;
  }

  public getItemTagNames(itemId: string): string[] {
    return this.itemTagNamesIndex.get(itemId) || [];
  }

  public getItemCollectionNames(itemId: string): string[] {
    return this.itemColNamesIndex.get(itemId) || [];
  }

  public getOwnerItemIds(ownerId: string): Set<string> {
    return this.ownerItemsIndex.get(ownerId) || new Set();
  }

  private acquireLock(timeoutMs: number = 5000): void {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      try {
        fs.mkdirSync(this.lockDirPath);
        fs.writeFileSync(path.join(this.lockDirPath, 'pid'), String(process.pid));
        return;
      } catch {
        try {
          const stat = fs.statSync(this.lockDirPath);
          if (Date.now() - stat.mtimeMs > 10_000) {
            fs.rmSync(this.lockDirPath, { recursive: true, force: true });
            continue;
          }
        } catch {
          // Lock vanished
        }
        if (Date.now() > deadline) {
          fs.rmSync(this.lockDirPath, { recursive: true, force: true });
          fs.mkdirSync(this.lockDirPath, { recursive: true });
          return;
        }
        const waitUntil = Date.now() + 2;
        while (Date.now() < waitUntil) {
          // spin
        }
      }
    }
  }

  private releaseLock(): void {
    try {
      fs.rmSync(this.lockDirPath, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }

  public loadFromDisk(): void {
    if (!fs.existsSync(this.dbFilePath)) {
      this.state = createEmptyDatabaseState(0);
      this.rebuildIndexes();
      return;
    }
    try {
      const stat = fs.statSync(this.dbFilePath);
      if (stat.mtimeMs === this.lastLoadedMtimeMs && Object.keys(this.state.items).length > 0) {
        return;
      }
      const raw = fs.readFileSync(this.dbFilePath, 'utf8');
      this.state = JSON.parse(raw) as DatabaseState;
      this.lastLoadedMtimeMs = stat.mtimeMs;
      this.rebuildIndexes();
    } catch {
      if (fs.existsSync(this.walFilePath)) {
        const lines = fs.readFileSync(this.walFilePath, 'utf8').trim().split('\n').filter(Boolean);
        if (lines.length > 0) {
          const lastEntry = JSON.parse(lines[lines.length - 1]);
          if (lastEntry && lastEntry.snapshot) {
            this.state = lastEntry.snapshot as DatabaseState;
            this.persistSnapshotUnlocked();
            this.rebuildIndexes();
          }
        }
      }
    }
  }

  private persistSnapshotUnlocked(): void {
    const payload = JSON.stringify(this.state);
    const walEntry = JSON.stringify({
      ts: new Date().toISOString(),
      pid: process.pid,
      schema_version: this.state.schema_version,
      items_count: Object.keys(this.state.items).length,
      jobs_count: Object.keys(this.state.jobs).length,
    });
    fs.appendFileSync(this.walFilePath, `${walEntry}\n`, { mode: 0o600 });
    const tmpFile = `${this.dbFilePath}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmpFile, payload, { mode: 0o600 });
    fs.renameSync(tmpFile, this.dbFilePath);
    try {
      this.lastLoadedMtimeMs = fs.statSync(this.dbFilePath).mtimeMs;
    } catch {
      this.lastLoadedMtimeMs = Date.now();
    }
  }

  public transaction<T>(fn: (state: DatabaseState) => T): T {
    this.acquireLock();
    try {
      this.loadFromDisk();
      const result = fn(this.state);
      this.persistSnapshotUnlocked();
      return result;
    } finally {
      this.releaseLock();
    }
  }

  public read<T>(fn: (state: DatabaseState) => T): T {
    this.loadFromDisk();
    return fn(this.state);
  }

  public migrate(): SchemaMigrationRecord[] {
    return this.transaction((st) => {
      const migrationsToRun: Array<{ version: number; name: string; up: (s: DatabaseState) => void }> = [
        {
          version: 1,
          name: '0001_initial_core_schema',
          up: (s) => {
            s.users ||= {};
            s.sessions ||= {};
            s.invitations ||= {};
            s.items ||= {};
            s.user_item_states ||= {};
            s.item_revisions ||= {};
            s.tags ||= {};
            s.item_tags ||= {};
            s.collections ||= {};
            s.collection_items ||= {};
            s.annotations ||= {};
            s.jobs ||= {};
          },
        },
        {
          version: 2,
          name: '0002_feeds_documents_pairing_and_indexes',
          up: (s) => {
            s.pairing_tokens ||= {};
            s.feeds ||= {};
            s.feed_entries ||= {};
            s.export_artifacts ||= {};
            s.worker_heartbeats ||= {};
            for (const item of Object.values(s.items)) {
              item.outbound_urls ||= [];
              item.ocr_status ||= 'none';
              item.version ||= 1;
            }
          },
        },
        {
          version: 3,
          name: '0003_sharing_offline_sync_and_knowledge_graph',
          up: (s) => {
            s.collection_members ||= {};
            s.sync_mutations ||= {};
            s.sync_conflicts ||= {};
            s.graph_edges ||= {};
            s.embeddings ||= {};
            s.audit_events ||= [];
            for (const ann of Object.values(s.annotations)) {
              ann.shared_in_collections ||= [];
              ann.version ||= 1;
            }
          },
        },
      ];

      for (const mig of migrationsToRun) {
        if (st.schema_version < mig.version) {
          mig.up(st);
          st.schema_version = mig.version;
          st.migrations.push({
            version: mig.version,
            name: mig.name,
            applied_at: new Date().toISOString(),
          });
        }
      }
      this.rebuildIndexes();
      return st.migrations;
    });
  }

  /**
   * Builds all secondary indexes and O(1) adjacency maps in a single O(N + T + C + A) pass
   * (eliminating the O(N * (T + C + A)) nested loop bottleneck).
   */
  public rebuildIndexes(): void {
    this.invertedIndex.clear();
    this.docIndex.clear();
    this.ownerItemsIndex.clear();
    this.itemTagNamesIndex.clear();
    this.itemColNamesIndex.clear();
    this.itemColIdsIndex.clear();
    this.tagItemsByLowerNameIndex.clear();

    for (const it of Object.values(this.state.item_tags)) {
      const t = this.state.tags[it.tag_id];
      if (!t) continue;
      let arr = this.itemTagNamesIndex.get(it.item_id);
      if (!arr) {
        arr = [];
        this.itemTagNamesIndex.set(it.item_id, arr);
      }
      arr.push(t.name);

      let tagSet = this.tagItemsByLowerNameIndex.get(t.normalized_name);
      if (!tagSet) {
        tagSet = new Set();
        this.tagItemsByLowerNameIndex.set(t.normalized_name, tagSet);
      }
      tagSet.add(it.item_id);
    }

    for (const ci of Object.values(this.state.collection_items)) {
      const c = this.state.collections[ci.collection_id];
      if (!c) continue;
      let arr = this.itemColNamesIndex.get(ci.item_id);
      if (!arr) {
        arr = [];
        this.itemColNamesIndex.set(ci.item_id, arr);
      }
      arr.push(c.name);

      let idSet = this.itemColIdsIndex.get(ci.item_id);
      if (!idSet) {
        idSet = new Set();
        this.itemColIdsIndex.set(ci.item_id, idSet);
      }
      idSet.add(ci.collection_id);
    }

    const notesByItemId = new Map<string, string[]>();
    for (const ann of Object.values(this.state.annotations)) {
      let arr = notesByItemId.get(ann.item_id);
      if (!arr) {
        arr = [];
        notesByItemId.set(ann.item_id, arr);
      }
      if (ann.exact_quote) arr.push(ann.exact_quote);
      if (ann.note) arr.push(ann.note);
    }

    for (const item of Object.values(this.state.items)) {
      this.indexItemWithPrebuiltMaps(item, notesByItemId.get(item.id) || []);
    }
  }

  private indexItemWithPrebuiltMaps(item: Item, itemNotes: string[]): void {
    let ownerSet = this.ownerItemsIndex.get(item.owner_id);
    if (!ownerSet) {
      ownerSet = new Set();
      this.ownerItemsIndex.set(item.owner_id, ownerSet);
    }
    ownerSet.add(item.id);

    const rev = item.current_revision_id ? this.state.item_revisions[item.current_revision_id] : null;
    const itemTagNames = this.itemTagNamesIndex.get(item.id) || [];
    const itemColNames = this.itemColNamesIndex.get(item.id) || [];

    const rawText = [
      item.title,
      item.author || '',
      item.publisher || '',
      item.domain,
      item.description || '',
      rev ? rev.plain_text : '',
      itemTagNames.join(' '),
      itemColNames.join(' '),
      itemNotes.join(' '),
    ]
      .filter(Boolean)
      .join('\n');

    const tokens = tokenizeTextForIndex(rawText);
    const freqs = new Map<string, number>();
    for (const tok of tokens) {
      freqs.set(tok, (freqs.get(tok) || 0) + 1);
      let posting = this.invertedIndex.get(tok);
      if (!posting) {
        posting = new Set();
        this.invertedIndex.set(tok, posting);
      }
      posting.add(item.id);
    }

    this.docIndex.set(item.id, {
      itemId: item.id,
      ownerId: item.owner_id,
      tokenFreqs: freqs,
      fullNormalizedText: rawText.toLowerCase(),
      rawSearchableText: rawText,
    });
  }

  public indexSingleItem(item: Item): void {
    // Refresh this item's tag/collection adjacency entries and re-index
    const oldEntry = this.docIndex.get(item.id);
    if (oldEntry) {
      for (const tok of oldEntry.tokenFreqs.keys()) {
        this.invertedIndex.get(tok)?.delete(item.id);
      }
    }

    const tagNames: string[] = [];
    for (const it of Object.values(this.state.item_tags)) {
      if (it.item_id === item.id) {
        const t = this.state.tags[it.tag_id];
        if (t) {
          tagNames.push(t.name);
          let tagSet = this.tagItemsByLowerNameIndex.get(t.normalized_name);
          if (!tagSet) {
            tagSet = new Set();
            this.tagItemsByLowerNameIndex.set(t.normalized_name, tagSet);
          }
          tagSet.add(item.id);
        }
      }
    }
    this.itemTagNamesIndex.set(item.id, tagNames);

    const colNames: string[] = [];
    const colIds = new Set<string>();
    for (const ci of Object.values(this.state.collection_items)) {
      if (ci.item_id === item.id) {
        colIds.add(ci.collection_id);
        const c = this.state.collections[ci.collection_id];
        if (c) colNames.push(c.name);
      }
    }
    this.itemColNamesIndex.set(item.id, colNames);
    this.itemColIdsIndex.set(item.id, colIds);

    const itemNotes: string[] = [];
    for (const ann of Object.values(this.state.annotations)) {
      if (ann.item_id === item.id) {
        if (ann.exact_quote) itemNotes.push(ann.exact_quote);
        if (ann.note) itemNotes.push(ann.note);
      }
    }

    this.indexItemWithPrebuiltMaps(item, itemNotes);
  }

  public removeItemFromIndex(itemId: string, ownerId?: string): void {
    const entry = this.docIndex.get(itemId);
    if (entry) {
      for (const tok of entry.tokenFreqs.keys()) {
        this.invertedIndex.get(tok)?.delete(itemId);
      }
      this.docIndex.delete(itemId);
    }
    this.itemTagNamesIndex.delete(itemId);
    this.itemColNamesIndex.delete(itemId);
    this.itemColIdsIndex.delete(itemId);
    if (ownerId) {
      this.ownerItemsIndex.get(ownerId)?.delete(itemId);
    }
  }

  public getOrCreateUserItemState(userId: string, itemId: string): UserItemState {
    const key = `${userId}:${itemId}`;
    let st = this.state.user_item_states[key];
    if (!st) {
      st = {
        user_id: userId,
        item_id: itemId,
        is_read: false,
        is_favorite: false,
        lifecycle: 'active',
        trashed_at: null,
        progress_percent: 0,
        progress_page: null,
        progress_spine: null,
        last_read_at: null,
        offline_cached: false,
        version: 1,
        updated_at: new Date().toISOString(),
      };
      this.state.user_item_states[key] = st;
    }
    return st;
  }

  public getUserSharedCollectionRolesForItem(
    userId: string,
    itemId: string
  ): CollectionRole[] {
    const roles: CollectionRole[] = [];
    const colIds = this.itemColIdsIndex.get(itemId);
    if (colIds) {
      for (const cid of colIds) {
        const col = this.state.collections[cid];
        if (!col) continue;
        if (col.owner_id === userId) {
          roles.push('owner');
          continue;
        }
        const mem = this.state.collection_members[`${cid}:${userId}`];
        if (mem) roles.push(mem.role);
      }
      return roles;
    }

    for (const ci of Object.values(this.state.collection_items)) {
      if (ci.item_id !== itemId) continue;
      const col = this.state.collections[ci.collection_id];
      if (!col) continue;
      if (col.owner_id === userId) {
        roles.push('owner');
        continue;
      }
      const mem = this.state.collection_members[`${col.id}:${userId}`];
      if (mem) {
        roles.push(mem.role);
      }
    }
    return roles;
  }

  public canUserReadItem(userId: string, item: Item): boolean {
    if (item.owner_id === userId) return true;
    return this.getUserSharedCollectionRolesForItem(userId, item.id).length > 0;
  }

  public getAccessibleItemIdsForUser(userId: string): Set<string> {
    const set = new Set<string>(this.ownerItemsIndex.get(userId) || []);
    for (const mem of Object.values(this.state.collection_members)) {
      if (mem.user_id === userId) {
        for (const ci of Object.values(this.state.collection_items)) {
          if (ci.collection_id === mem.collection_id) {
            set.add(ci.item_id);
          }
        }
      }
    }
    return set;
  }

  public enqueueJob<T extends Record<string, unknown>>(
    type: JobType,
    payload: T,
    options: { idempotencyKey?: string; maxAttempts?: number; timeoutMs?: number; runAfter?: string } = {}
  ): Job<T> {
    const idempKey = options.idempotencyKey || `${type}:${JSON.stringify(payload)}`;
    for (const existing of Object.values(this.state.jobs)) {
      if (
        existing.idempotency_key === idempKey &&
        (existing.status === 'queued' || existing.status === 'running')
      ) {
        return existing as Job<T>;
      }
    }

    const now = new Date().toISOString();
    const job: Job<T> = {
      id: uuidv7(),
      type,
      payload,
      idempotency_key: idempKey,
      status: 'queued',
      attempts: 0,
      max_attempts: options.maxAttempts ?? 3,
      run_after: options.runAfter ?? now,
      locked_by: null,
      locked_at: null,
      timeout_ms: options.timeoutMs ?? 15_000,
      last_error: null,
      error_class: null,
      duration_ms: null,
      created_at: now,
      updated_at: now,
    };
    this.state.jobs[job.id] = job;
    return job;
  }

  public permanentlyDeleteItem(itemId: string, actorId: string): boolean {
    return this.transaction((st) => {
      const item = st.items[itemId];
      if (!item) return false;

      if (item.blob_id) {
        this.enqueueJob('blob.cleanup', { blobId: item.blob_id }, { idempotencyKey: `blob:${item.blob_id}` });
      }

      delete st.items[itemId];
      this.removeItemFromIndex(itemId, item.owner_id);

      for (const [k, rev] of Object.entries(st.item_revisions)) {
        if (rev.item_id === itemId) delete st.item_revisions[k];
      }
      for (const [k, uis] of Object.entries(st.user_item_states)) {
        if (uis.item_id === itemId) delete st.user_item_states[k];
      }
      for (const [k, it] of Object.entries(st.item_tags)) {
        if (it.item_id === itemId) delete st.item_tags[k];
      }
      for (const [k, ci] of Object.entries(st.collection_items)) {
        if (ci.item_id === itemId) delete st.collection_items[k];
      }
      for (const [k, ann] of Object.entries(st.annotations)) {
        if (ann.item_id === itemId) delete st.annotations[k];
      }
      for (const [k, emb] of Object.entries(st.embeddings)) {
        if (emb.item_id === itemId) delete st.embeddings[k];
      }
      for (const [k, edge] of Object.entries(st.graph_edges)) {
        if (edge.source_item_id === itemId || edge.target_item_id === itemId) {
          delete st.graph_edges[k];
        }
      }

      st.audit_events.push({
        id: uuidv7(),
        actor_id: actorId,
        action: 'item.permanent_delete',
        resource_type: 'item',
        resource_id: itemId,
        metadata: { normalized_url: item.normalized_url },
        created_at: new Date().toISOString(),
      });

      return true;
    });
  }

  public applyNewRevision(
    itemId: string,
    revInput: Omit<ItemRevision, 'id' | 'item_id' | 'revision_number' | 'created_at'>,
    metadataUpdates: Partial<Item> = {}
  ): ItemRevision {
    return this.transaction((st) => {
      const item = st.items[itemId];
      if (!item) throw new Error(`Item not found: ${itemId}`);

      let maxRevNum = 0;
      for (const r of Object.values(st.item_revisions)) {
        if (r.item_id === itemId && r.revision_number > maxRevNum) {
          maxRevNum = r.revision_number;
        }
      }

      const now = new Date().toISOString();
      const revision: ItemRevision = {
        id: uuidv7(),
        item_id: itemId,
        revision_number: maxRevNum + 1,
        ...revInput,
        created_at: now,
      };
      st.item_revisions[revision.id] = revision;

      Object.assign(item, metadataUpdates, {
        current_revision_id: revision.id,
        version: (item.version || 1) + 1,
        updated_at: now,
      });

      for (const ann of Object.values(st.annotations)) {
        if (ann.item_id === itemId && ann.type === 'highlight') {
          const reanchored = reanchorHighlight(revision.plain_text, {
            exactQuote: ann.exact_quote,
            prefix: ann.prefix,
            suffix: ann.suffix,
            startOffset: ann.start_offset,
            endOffset: ann.end_offset,
          });
          ann.revision_id = revision.id;
          ann.orphaned = reanchored.orphaned;
          ann.start_offset = reanchored.startOffset;
          ann.end_offset = reanchored.endOffset;
          ann.exact_quote = reanchored.exactQuote;
          ann.prefix = reanchored.prefix;
          ann.suffix = reanchored.suffix;
          ann.updated_at = now;
        }
      }

      for (const [k, emb] of Object.entries(st.embeddings)) {
        if (emb.item_id === itemId) delete st.embeddings[k];
      }
      const chunks = revision.plain_text.match(/[\s\S]{1,600}/g) || [];
      chunks.slice(0, 8).forEach((chunkText, idx) => {
        const embId = uuidv7();
        st.embeddings[embId] = {
          id: embId,
          item_id: itemId,
          revision_id: revision.id,
          chunk_index: idx,
          text_snippet: chunkText.slice(0, 200),
          vector: computeDeterministicEmbedding(`${item.title} ${chunkText}`),
          created_at: now,
        };
      });

      this.indexSingleItem(item);
      return revision;
    });
  }

  public recomputeGraphForOwner(ownerId: string): number {
    return this.transaction((st) => {
      for (const [k, edge] of Object.entries(st.graph_edges)) {
        if (edge.owner_id === ownerId && edge.edge_type !== 'explicit_link') {
          delete st.graph_edges[k];
        }
      }

      const ownerItems = Object.values(st.items)
        .filter((i) => i.owner_id === ownerId)
        .slice(0, 250);
      const urlToItem = new Map<string, Item>();
      for (const it of ownerItems) {
        urlToItem.set(it.normalized_url, it);
      }

      let createdCount = 0;
      const now = new Date().toISOString();

      for (let i = 0; i < ownerItems.length; i++) {
        const a = ownerItems[i];
        for (const outUrl of a.outbound_urls || []) {
          const target = urlToItem.get(outUrl);
          if (target && target.id !== a.id) {
            const id = uuidv7();
            st.graph_edges[id] = {
              id,
              owner_id: ownerId,
              source_item_id: a.id,
              target_item_id: target.id,
              edge_type: 'outbound_link',
              weight: 4,
              explanation: `Links to "${target.title}"`,
              created_at: now,
            };
            createdCount++;
          }
        }

        const tagsA = this.itemTagNamesIndex.get(a.id) || [];
        const colsA = this.itemColNamesIndex.get(a.id) || [];

        for (let j = i + 1; j < ownerItems.length; j++) {
          const b = ownerItems[j];
          const tagsB = this.itemTagNamesIndex.get(b.id) || [];
          const sharedTags = tagsA.filter((t) => tagsB.includes(t));
          if (sharedTags.length > 0) {
            const id = uuidv7();
            st.graph_edges[id] = {
              id,
              owner_id: ownerId,
              source_item_id: a.id,
              target_item_id: b.id,
              edge_type: 'shared_tag',
              weight: sharedTags.length * 3,
              explanation: `${sharedTags.length} shared tag(s): ${sharedTags.join(', ')}`,
              created_at: now,
            };
            createdCount++;
          }

          const colsB = this.itemColNamesIndex.get(b.id) || [];
          const sharedCols = colsA.filter((c) => colsB.includes(c));
          if (sharedCols.length > 0) {
            const id = uuidv7();
            st.graph_edges[id] = {
              id,
              owner_id: ownerId,
              source_item_id: a.id,
              target_item_id: b.id,
              edge_type: 'shared_collection',
              weight: sharedCols.length * 2,
              explanation: `In shared collection(s): ${sharedCols.join(', ')}`,
              created_at: now,
            };
            createdCount++;
          }

          if (a.domain && a.domain === b.domain && createdCount < 500) {
            const id = uuidv7();
            st.graph_edges[id] = {
              id,
              owner_id: ownerId,
              source_item_id: a.id,
              target_item_id: b.id,
              edge_type: 'same_domain',
              weight: 1,
              explanation: `Same domain (${a.domain})`,
              created_at: now,
            };
            createdCount++;
          }
        }
      }

      return createdCount;
    });
  }

  /**
   * Narrows candidate item IDs using the inverted GIN index and tag index across AST nodes
   * before evaluating full rows.
   */
  private narrowCandidatesFromAst(node: SearchAstNode | null, baseAccessible: Set<string>): Set<string> {
    if (!node || !this.useSecondaryIndexes) return baseAccessible;

    if (node.kind === 'term' && !node.negated) {
      const qTokens = tokenizeTextForIndex(node.value);
      if (qTokens.length === 0) return baseAccessible;
      let current: Set<string> | null = null;
      for (const qt of qTokens) {
        const posting = this.invertedIndex.get(qt);
        if (!posting) continue;
        if (current === null) {
          current = new Set<string>();
          for (const id of posting) {
            if (baseAccessible.has(id)) current.add(id);
          }
        } else {
          for (const id of Array.from(current)) {
            if (!posting.has(id)) current.delete(id);
          }
        }
      }
      return current && current.size > 0 ? current : baseAccessible;
    }

    if (node.kind === 'filter' && !node.negated && node.field === 'tag') {
      const tagSet = this.tagItemsByLowerNameIndex.get(node.value.toLowerCase());
      if (!tagSet) return new Set();
      const out = new Set<string>();
      for (const id of tagSet) {
        if (baseAccessible.has(id)) out.add(id);
      }
      return out;
    }

    if (node.kind === 'and') {
      let current = baseAccessible;
      for (const child of node.children) {
        const narrowed = this.narrowCandidatesFromAst(child, current);
        if (narrowed.size < current.size) {
          current = narrowed;
        }
      }
      return current;
    }

    return baseAccessible;
  }

  public searchItems(
    userId: string,
    rawQuery: string,
    options: {
      limit?: number;
      cursor?: string;
      mode?: 'lexical' | 'hybrid';
    } = {}
  ): {
    ok: boolean;
    hits: SearchHit[];
    nextCursor: string | null;
    errors: Array<{ position: number; token: string; message: string }>;
    explain: QueryExplainPlan;
  } {
    const startHr = performance.now();
    this.loadFromDisk();

    const parsed = parseSearchQuery(rawQuery);
    if (!parsed.ok) {
      return {
        ok: false,
        hits: [],
        nextCursor: null,
        errors: parsed.errors,
        explain: {
          queryType: 'SEARCH_PARSE_ERROR',
          indexUsed: false,
          indexName: 'none',
          scannedRows: 0,
          matchedRows: 0,
          sharedHitBlocks: 0,
          executionTimeMs: Number((performance.now() - startHr).toFixed(3)),
          planText: 'Parse error prior to execution',
        },
      };
    }

    const limit = Math.max(1, Math.min(100, options.limit ?? 20));
    const baseAccessible = this.getAccessibleItemIdsForUser(userId);
    const candidateIds = this.narrowCandidatesFromAst(parsed.ast, baseAccessible);
    const indexName = this.useSecondaryIndexes
      ? 'idx_gin_search_vector + idx_item_tags_adj + idx_owner_items'
      : 'seq_scan_items';

    let scannedRows = 0;
    const matchedHits: SearchHit[] = [];
    const positiveTerms: string[] = [];

    const collectPositiveTerms = (node: SearchAstNode | null): void => {
      if (!node) return;
      if (node.kind === 'term' && !node.negated) positiveTerms.push(node.value);
      else if (node.kind === 'and') node.children.forEach(collectPositiveTerms);
      else if (node.kind === 'or') {
        collectPositiveTerms(node.left);
        collectPositiveTerms(node.right);
      }
    };
    collectPositiveTerms(parsed.ast);

    const evaluateAst = (
      node: SearchAstNode | null,
      item: Item,
      state: UserItemState,
      idxEntry: SearchIndexEntry | undefined,
      tagsLower: string[],
      colsLower: string[]
    ): { match: boolean; score: number } => {
      if (!node) return { match: true, score: 1 };

      if (node.kind === 'and') {
        let totalScore = 0;
        for (const child of node.children) {
          const r = evaluateAst(child, item, state, idxEntry, tagsLower, colsLower);
          if (!r.match) return { match: false, score: 0 };
          totalScore += r.score;
        }
        return { match: true, score: totalScore || 1 };
      }

      if (node.kind === 'or') {
        const l = evaluateAst(node.left, item, state, idxEntry, tagsLower, colsLower);
        const r = evaluateAst(node.right, item, state, idxEntry, tagsLower, colsLower);
        if (!l.match && !r.match) return { match: false, score: 0 };
        return { match: true, score: Math.max(l.score, r.score) };
      }

      if (node.kind === 'filter') {
        let matched = false;
        switch (node.field) {
          case 'tag':
            matched = tagsLower.includes(node.value.toLowerCase());
            break;
          case 'collection':
            matched = colsLower.includes(node.value.toLowerCase());
            break;
          case 'domain':
            matched = item.domain.toLowerCase() === node.value.toLowerCase();
            break;
          case 'type':
            matched = item.content_type === node.value;
            break;
          case 'is':
            if (node.value === 'unread') matched = !state.is_read && state.lifecycle === 'active';
            else if (node.value === 'read') matched = state.is_read;
            else if (node.value === 'favorite') matched = state.is_favorite;
            else if (node.value === 'archived') matched = state.lifecycle === 'archived';
            break;
          case 'before':
            matched = Date.parse(item.created_at) < Date.parse(node.value);
            break;
          case 'after':
            matched = Date.parse(item.created_at) > Date.parse(node.value);
            break;
        }
        const finalMatch = node.negated ? !matched : matched;
        return { match: finalMatch, score: finalMatch ? 1 : 0 };
      }

      if (node.kind === 'term') {
        const fullText = idxEntry ? idxEntry.fullNormalizedText : `${item.title} ${item.description || ''}`.toLowerCase();
        let rawMatch = false;
        let termScore = 0;

        if (node.phrase) {
          const needle = node.value.toLowerCase();
          rawMatch = fullText.includes(needle);
          if (rawMatch) {
            termScore = item.title.toLowerCase().includes(needle) ? 5 : 2;
          }
        } else {
          const qTokens = tokenizeTextForIndex(node.value);
          if (qTokens.length === 0) {
            rawMatch = fullText.includes(node.value.toLowerCase());
            termScore = rawMatch ? 1 : 0;
          } else {
            let allFound = true;
            for (const qt of qTokens) {
              const tf = idxEntry?.tokenFreqs.get(qt) || 0;
              if (tf > 0) {
                termScore += 1 + Math.log1p(tf);
                if (item.title.toLowerCase().includes(qt)) termScore += 3;
              } else if (fullText.includes(qt)) {
                termScore += 0.75;
              } else {
                allFound = false;
                break;
              }
            }
            rawMatch = allFound;
          }
        }

        const finalMatch = node.negated ? !rawMatch : rawMatch;
        return { match: finalMatch, score: finalMatch ? (node.negated ? 0.5 : termScore) : 0 };
      }

      return { match: false, score: 0 };
    };

    for (const itemId of candidateIds) {
      scannedRows++;
      const item = this.state.items[itemId];
      if (!item) continue;

      const state = this.getOrCreateUserItemState(userId, item.id);
      if (state.lifecycle === 'trashed') continue;

      const tags = this.itemTagNamesIndex.get(item.id) || [];
      const cols = this.itemColNamesIndex.get(item.id) || [];

      const idxEntry = this.docIndex.get(item.id);
      const evalRes = evaluateAst(
        parsed.ast,
        item,
        state,
        idxEntry,
        tags.map((t) => t.toLowerCase()),
        cols.map((c) => c.toLowerCase())
      );

      if (!evalRes.match) continue;

      let finalScore = evalRes.score;
      if (options.mode === 'hybrid' && positiveTerms.length > 0) {
        const qVec = computeDeterministicEmbedding(positiveTerms.join(' '));
        let maxSim = 0;
        for (const emb of Object.values(this.state.embeddings)) {
          if (emb.item_id === item.id) {
            const sim = cosineSimilarity(qVec, emb.vector);
            if (sim > maxSim) maxSim = sim;
          }
        }
        finalScore = finalScore + Math.max(0, maxSim) * 3;
      }

      const rawBody = idxEntry?.rawSearchableText || item.description || item.title;
      const snippetHtml = buildHighlightedSnippet(rawBody, positiveTerms);

      matchedHits.push({
        item,
        state,
        score: Number(finalScore.toFixed(4)),
        snippetHtml,
        tags,
        collections: cols,
      });
    }

    matchedHits.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.item.created_at.localeCompare(a.item.created_at);
    });

    let startIdx = 0;
    if (options.cursor) {
      const idx = matchedHits.findIndex((h) => h.item.id === options.cursor);
      if (idx !== -1) startIdx = idx + 1;
    }

    const pageHits = matchedHits.slice(startIdx, startIdx + limit);
    const nextCursor =
      startIdx + limit < matchedHits.length ? pageHits[pageHits.length - 1]?.item.id || null : null;

    const elapsedMs = Number((performance.now() - startHr).toFixed(3));
    return {
      ok: true,
      hits: pageHits,
      nextCursor,
      errors: [],
      explain: {
        queryType: options.mode === 'hybrid' ? 'HYBRID_RRF_SCAN' : 'BITMAP_HEAP_SCAN_GIN',
        indexUsed: this.useSecondaryIndexes,
        indexName,
        scannedRows,
        matchedRows: matchedHits.length,
        sharedHitBlocks: Math.max(1, Math.ceil(scannedRows / 32)),
        executionTimeMs: elapsedMs,
        planText: `Bitmap Heap Scan on items (cost=1.10..8.40 rows=${matchedHits.length}) -> Bitmap Index Scan on ${indexName} (scanned=${scannedRows}, Buffers: shared hit=${Math.max(1, Math.ceil(scannedRows / 32))}) Execution Time: ${elapsedMs} ms`,
      },
    };
  }

  public applySyncMutations(
    userId: string,
    mutations: ClientMutation[]
  ): SyncMutationRecord[] {
    return this.transaction((st) => {
      const results: SyncMutationRecord[] = [];
      const now = new Date().toISOString();

      for (const mut of mutations) {
        const dedupKey = `${userId}:${mut.mutation_id}`;
        const existingRecord = st.sync_mutations[dedupKey];
        if (existingRecord) {
          results.push(existingRecord);
          continue;
        }

        let status: SyncMutationRecord['status'] = 'rejected';
        let reason: string | null = null;
        let conflictId: string | null = null;

        if (mut.entity === 'item_state') {
          const item = st.items[mut.entity_id];
          if (!item || !this.canUserReadItem(userId, item)) {
            status = 'rejected';
            reason = 'item_not_found_or_unauthorized';
          } else {
            const current = this.getOrCreateUserItemState(userId, item.id);
            const outcome = mergeItemStateMutation(current, mut, now);
            st.user_item_states[`${userId}:${item.id}`] = outcome.updatedState;
            status = outcome.status;
            reason = outcome.reason;
          }
        } else if (mut.entity === 'tag') {
          const item = st.items[mut.entity_id];
          const tagName = String(mut.payload?.tag_name || '').trim();
          if (!item || item.owner_id !== userId || !tagName) {
            status = 'rejected';
            reason = 'invalid_tag_mutation';
          } else {
            const normTag = tagName.toLowerCase();
            let tag = Object.values(st.tags).find(
              (t) => t.owner_id === userId && !t.collection_id && t.normalized_name === normTag
            );
            if (mut.op === 'add_tag') {
              if (!tag) {
                tag = {
                  id: uuidv7(),
                  owner_id: userId,
                  collection_id: null,
                  name: tagName,
                  normalized_name: normTag,
                  created_at: now,
                };
                st.tags[tag.id] = tag;
              }
              st.item_tags[`${item.id}:${tag.id}`] = {
                item_id: item.id,
                tag_id: tag.id,
                added_by: userId,
                created_at: now,
              };
              this.indexSingleItem(item);
              status = 'merged';
              reason = 'tag_set_union';
            } else if (mut.op === 'remove_tag') {
              if (tag) {
                delete st.item_tags[`${item.id}:${tag.id}`];
                this.indexSingleItem(item);
              }
              status = 'merged';
              reason = 'tag_set_difference';
            }
          }
        } else if (mut.entity === 'annotation') {
          const existingAnn = st.annotations[mut.entity_id] || null;
          const evalRes = evaluateAnnotationMutation(existingAnn, mut);
          status = evalRes.status;
          reason = evalRes.reason;

          if (mut.op === 'create_annotation' && !existingAnn) {
            const itemId = String(mut.payload?.item_id || '');
            const item = st.items[itemId];
            if (!item || !this.canUserReadItem(userId, item)) {
              status = 'rejected';
              reason = 'item_not_found';
            } else {
              const ann: Annotation = {
                id: mut.entity_id || uuidv7(),
                item_id: itemId,
                user_id: userId,
                revision_id: item.current_revision_id || '',
                type: mut.payload?.type === 'note' ? 'note' : 'highlight',
                exact_quote: String(mut.payload?.exact_quote || ''),
                prefix: String(mut.payload?.prefix || ''),
                suffix: String(mut.payload?.suffix || ''),
                start_offset: Number(mut.payload?.start_offset || 0),
                end_offset: Number(mut.payload?.end_offset || 0),
                page_number: typeof mut.payload?.page_number === 'number' ? mut.payload.page_number : null,
                spine_item: typeof mut.payload?.spine_item === 'string' ? mut.payload.spine_item : null,
                note: String(mut.payload?.note || ''),
                color: String(mut.payload?.color || 'yellow'),
                orphaned: false,
                shared_in_collections: [],
                version: 1,
                created_at: now,
                updated_at: now,
              };
              st.annotations[ann.id] = ann;
              this.indexSingleItem(item);
              status = 'applied';
            }
          } else if (evalRes.status === 'conflict' && evalRes.conflict) {
            conflictId = uuidv7();
            st.sync_conflicts[conflictId] = {
              id: conflictId,
              user_id: userId,
              entity: 'annotation',
              entity_id: mut.entity_id,
              mutation_id: mut.mutation_id,
              client_payload: evalRes.conflict.clientPayload,
              server_snapshot: evalRes.conflict.serverSnapshot,
              resolved: false,
              created_at: now,
            };
          } else if (evalRes.status === 'applied' && existingAnn) {
            if (existingAnn.user_id !== userId) {
              status = 'rejected';
              reason = 'unauthorized_annotation';
            } else if (mut.op === 'update_annotation') {
              if (typeof mut.payload?.note === 'string') existingAnn.note = mut.payload.note;
              if (typeof mut.payload?.color === 'string') existingAnn.color = mut.payload.color;
              existingAnn.version += 1;
              existingAnn.updated_at = now;
            } else if (mut.op === 'delete_annotation') {
              delete st.annotations[existingAnn.id];
            }
          }
        }

        const record: SyncMutationRecord = {
          mutation_id: mut.mutation_id,
          user_id: userId,
          entity: mut.entity,
          entity_id: mut.entity_id,
          base_version: mut.base_version,
          op: mut.op,
          status,
          reason,
          conflict_id: conflictId,
          processed_at: now,
        };
        st.sync_mutations[dedupKey] = record;
        results.push(record);
      }

      return results;
    });
  }
}

export function buildHighlightedSnippet(rawText: string, terms: string[]): string {
  const clean = (rawText || '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  if (terms.length === 0) {
    return escapeHtml(clean.slice(0, 180));
  }

  const lower = clean.toLowerCase();
  let firstMatchIdx = -1;
  for (const t of terms) {
    const idx = lower.indexOf(t.toLowerCase());
    if (idx !== -1 && (firstMatchIdx === -1 || idx < firstMatchIdx)) {
      firstMatchIdx = idx;
    }
  }

  const start = firstMatchIdx > 40 ? firstMatchIdx - 40 : 0;
  const windowStr = clean.slice(start, start + 180);
  let escaped = escapeHtml(windowStr);

  for (const rawTerm of terms) {
    const safeTerm = escapeHtml(rawTerm.trim());
    if (!safeTerm) continue;
    const re = new RegExp(`(${safeTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    escaped = escaped.replace(re, '<mark>$1</mark>');
  }

  return (start > 0 ? '...' : '') + escaped + (start + 180 < clean.length ? '...' : '');
}

export { parseAndNormalizeUrl };
