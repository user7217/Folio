import crypto from 'node:crypto';

/**
 * Generates an RFC 9562 UUIDv7 (time-ordered, non-sequential random bits).
 */
export function uuidv7(nowMs: number = Date.now()): string {
  const bytes = crypto.randomBytes(16);
  const timeBig = BigInt(Math.max(0, Math.floor(nowMs)));
  bytes[0] = Number((timeBig >> 40n) & 0xffn);
  bytes[1] = Number((timeBig >> 32n) & 0xffn);
  bytes[2] = Number((timeBig >> 24n) & 0xffn);
  bytes[3] = Number((timeBig >> 16n) & 0xffn);
  bytes[4] = Number((timeBig >> 8n) & 0xffn);
  bytes[5] = Number(timeBig & 0xffn);
  // version 7
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  // variant 10xx
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export type ThemeId = 'editorial-light' | 'midnight-amoled' | 'swiss-minimal' | 'soft-sepia';
export type ThemePreference = ThemeId | 'system';
export type ListLayout = 'compact' | 'comfortable';
export type UserRole = 'admin' | 'user';
export type ProcessingStatus = 'queued' | 'fetching' | 'extracting' | 'ready' | 'partial' | 'failed';
export type LifecycleState = 'active' | 'archived' | 'trashed';
export type ContentType = 'article' | 'pdf' | 'epub' | 'feed';
export type CollectionRole = 'owner' | 'editor' | 'viewer';
export type ErrorClass = 'permanent' | 'transient' | null;
export type OcrStatus = 'none' | 'completed' | 'no_text_layer' | 'unavailable';

export interface ReaderSettings {
  width: 'narrow' | 'medium' | 'wide';
  fontSize: number; // 14 to 24
  fontFamily: 'serif' | 'sans';
  lineSpacing: number; // 1.4 to 2.0
  distractionFree: boolean;
}

export interface UserSettings {
  theme: ThemePreference;
  listLayout: ListLayout;
  reader: ReaderSettings;
  offlineStorageCapMb: number;
}

export interface User {
  id: string;
  username: string;
  email: string;
  password_hash: string;
  role: UserRole;
  settings: UserSettings;
  created_at: string;
  updated_at: string;
}

export interface Session {
  id: string;
  user_id: string;
  token_hash: string;
  csrf_token: string;
  created_at: string;
  last_active_at: string;
  idle_expires_at: string;
  absolute_expires_at: string;
  revoked_at: string | null;
}

export interface Invitation {
  id: string;
  code_hash: string;
  email: string | null;
  created_by: string;
  used_by: string | null;
  expires_at: string;
  created_at: string;
}

export interface PairingToken {
  id: string;
  user_id: string;
  name: string;
  pairing_code_hash: string | null;
  pairing_expires_at: string | null;
  token_hash: string | null;
  revoked_at: string | null;
  created_at: string;
}

export interface TocEntry {
  id: string;
  text: string;
  level: number;
}

export interface EpubSpineItem {
  id: string;
  href: string;
  title: string;
  sanitized_html: string;
  plain_text: string;
}

export interface PdfPageContent {
  pageNumber: number;
  text: string;
}

export interface Item {
  id: string;
  owner_id: string;
  url: string;
  normalized_url: string;
  canonical_url: string | null;
  possible_duplicate_of: string | null;
  title: string;
  author: string | null;
  publisher: string | null;
  domain: string;
  published_at: string | null;
  description: string | null;
  featured_image: string | null;
  language: string | null;
  reading_time_minutes: number;
  content_type: ContentType;
  processing_status: ProcessingStatus;
  error_message: string | null;
  error_class: ErrorClass;
  current_revision_id: string | null;
  blob_id: string | null;
  page_count: number | null;
  ocr_status: OcrStatus;
  outbound_urls: string[];
  version: number;
  created_at: string;
  updated_at: string;
}

export interface UserItemState {
  user_id: string;
  item_id: string;
  is_read: boolean;
  is_favorite: boolean;
  lifecycle: LifecycleState;
  trashed_at: string | null;
  progress_percent: number;
  progress_page: number | null;
  progress_spine: string | null;
  last_read_at: string | null;
  offline_cached: boolean;
  version: number;
  updated_at: string;
}

export interface ItemRevision {
  id: string;
  item_id: string;
  revision_number: number;
  extractor_name: string;
  extractor_version: string;
  content_hash: string;
  sanitized_html: string;
  plain_text: string;
  toc: TocEntry[];
  spine: EpubSpineItem[];
  pages: PdfPageContent[];
  created_at: string;
}

export interface Tag {
  id: string;
  owner_id: string;
  collection_id: string | null;
  name: string;
  normalized_name: string;
  created_at: string;
}

export interface ItemTag {
  item_id: string;
  tag_id: string;
  added_by: string;
  created_at: string;
}

export interface Collection {
  id: string;
  owner_id: string;
  parent_id: string | null;
  name: string;
  description: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface CollectionItem {
  collection_id: string;
  item_id: string;
  added_by: string;
  created_at: string;
}

export interface CollectionMember {
  collection_id: string;
  user_id: string;
  role: CollectionRole;
  invited_by: string;
  created_at: string;
}

export interface Annotation {
  id: string;
  item_id: string;
  user_id: string;
  revision_id: string;
  type: 'highlight' | 'note';
  exact_quote: string;
  prefix: string;
  suffix: string;
  start_offset: number;
  end_offset: number;
  page_number: number | null;
  spine_item: string | null;
  note: string;
  color: string;
  orphaned: boolean;
  shared_in_collections: string[];
  version: number;
  created_at: string;
  updated_at: string;
}

export interface Feed {
  id: string;
  owner_id: string;
  url: string;
  normalized_url: string;
  site_url: string | null;
  title: string;
  description: string | null;
  etag: string | null;
  last_modified: string | null;
  poll_interval_minutes: number;
  last_polled_at: string | null;
  last_error: string | null;
  error_count: number;
  created_at: string;
  updated_at: string;
}

export interface FeedEntry {
  id: string;
  feed_id: string;
  owner_id: string;
  guid: string | null;
  dedup_key: string;
  url: string;
  title: string;
  author: string | null;
  summary: string;
  content_html: string;
  published_at: string | null;
  is_read: boolean;
  saved_item_id: string | null;
  created_at: string;
}

export type JobType =
  | 'capture.extract'
  | 'feed.poll'
  | 'graph.recompute'
  | 'export.generate'
  | 'import.process'
  | 'blob.cleanup'
  | 'embedding.compute';

export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'dead_letter';

export interface Job<T = Record<string, unknown>> {
  id: string;
  type: JobType;
  payload: T;
  idempotency_key: string;
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  run_after: string;
  locked_by: string | null;
  locked_at: string | null;
  timeout_ms: number;
  last_error: string | null;
  error_class: ErrorClass;
  duration_ms: number | null;
  created_at: string;
  updated_at: string;
}

export type SyncResultStatus = 'applied' | 'merged' | 'conflict' | 'rejected';

export interface ClientMutation {
  mutation_id: string;
  entity: 'item_state' | 'tag' | 'annotation';
  entity_id: string;
  base_version: number;
  op: 'update_state' | 'add_tag' | 'remove_tag' | 'create_annotation' | 'update_annotation' | 'delete_annotation';
  payload: Record<string, unknown>;
}

export interface SyncMutationRecord {
  mutation_id: string;
  user_id: string;
  entity: string;
  entity_id: string;
  base_version: number;
  op: string;
  status: SyncResultStatus;
  reason: string | null;
  conflict_id: string | null;
  processed_at: string;
}

export interface SyncConflict {
  id: string;
  user_id: string;
  entity: string;
  entity_id: string;
  mutation_id: string;
  client_payload: Record<string, unknown>;
  server_snapshot: Record<string, unknown>;
  resolved: boolean;
  created_at: string;
}

export type GraphEdgeType =
  | 'shared_tag'
  | 'shared_collection'
  | 'explicit_link'
  | 'outbound_link'
  | 'same_domain';

export interface GraphEdge {
  id: string;
  owner_id: string;
  source_item_id: string;
  target_item_id: string;
  edge_type: GraphEdgeType;
  weight: number;
  explanation: string;
  created_at: string;
}

export interface DocumentChunkEmbedding {
  id: string;
  item_id: string;
  revision_id: string;
  chunk_index: number;
  text_snippet: string;
  vector: number[];
  created_at: string;
}

export interface AuditEvent {
  id: string;
  actor_id: string;
  action: string;
  resource_type: string;
  resource_id: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface ExportArtifact {
  id: string;
  user_id: string;
  format: 'json' | 'csv' | 'opml';
  blob_id: string;
  download_token_hash: string;
  expires_at: string;
  created_at: string;
}

export interface WorkerHeartbeat {
  worker_id: string;
  pid: number;
  last_seen_at: string;
  active_jobs: number;
  processed_count: number;
}

export type AuthPolicyName =
  | 'public'
  | 'authenticated'
  | 'admin'
  | 'extension_or_authenticated'
  | 'item:read'
  | 'item:write'
  | 'item:owner'
  | 'collection:read'
  | 'collection:edit'
  | 'collection:owner'
  | 'annotation:write'
  | 'feed:owner'
  | 'export:owner';

export interface RouteDefinition {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  policy: AuthPolicyName;
  rateLimit?: {
    windowMs: number;
    max: number;
  };
  csrfExempt?: boolean;
}

export const ROUTE_REGISTRY: RouteDefinition[] = [
  // Health & Readiness
  { method: 'GET', path: '/healthz', policy: 'public' },
  { method: 'GET', path: '/readyz', policy: 'public' },
  // UI Pages
  { method: 'GET', path: '/', policy: 'public' },
  { method: 'GET', path: '/manifest.webmanifest', policy: 'public' },
  { method: 'GET', path: '/sw.js', policy: 'public' },
  // Authentication & Accounts
  { method: 'POST', path: '/api/auth/bootstrap', policy: 'public', rateLimit: { windowMs: 60000, max: 10 }, csrfExempt: true },
  { method: 'POST', path: '/api/auth/register', policy: 'public', rateLimit: { windowMs: 60000, max: 15 }, csrfExempt: true },
  { method: 'POST', path: '/api/auth/login', policy: 'public', rateLimit: { windowMs: 60000, max: 20 }, csrfExempt: true },
  { method: 'POST', path: '/api/auth/logout', policy: 'authenticated' },
  { method: 'POST', path: '/api/auth/sessions/revoke', policy: 'authenticated' },
  { method: 'GET', path: '/api/auth/me', policy: 'authenticated' },
  { method: 'PATCH', path: '/api/user/settings', policy: 'authenticated' },
  // Admin actions
  { method: 'POST', path: '/api/admin/invitations', policy: 'admin' },
  { method: 'POST', path: '/api/admin/password-reset', policy: 'admin', rateLimit: { windowMs: 60000, max: 10 } },
  { method: 'GET', path: '/api/admin/diagnostics', policy: 'admin' },
  { method: 'GET', path: '/api/admin/audit-events', policy: 'admin' },
  // Extension Pairing
  { method: 'POST', path: '/api/extension/pair/start', policy: 'authenticated', rateLimit: { windowMs: 60000, max: 15 } },
  { method: 'POST', path: '/api/extension/pair/exchange', policy: 'public', rateLimit: { windowMs: 60000, max: 15 }, csrfExempt: true },
  { method: 'POST', path: '/api/extension/tokens/:id/revoke', policy: 'authenticated' },
  // Capture & Bookmarklet & Share Target
  { method: 'POST', path: '/api/items/capture', policy: 'extension_or_authenticated', rateLimit: { windowMs: 60000, max: 120 } },
  { method: 'GET', path: '/api/bookmarklet/capture', policy: 'authenticated', rateLimit: { windowMs: 60000, max: 60 } },
  { method: 'POST', path: '/api/share-target', policy: 'authenticated', rateLimit: { windowMs: 60000, max: 60 } },
  // Library & Items
  { method: 'GET', path: '/api/items', policy: 'authenticated' },
  { method: 'POST', path: '/api/items/bulk', policy: 'authenticated' },
  { method: 'GET', path: '/api/items/:id', policy: 'item:read' },
  { method: 'PATCH', path: '/api/items/:id', policy: 'item:owner' },
  { method: 'POST', path: '/api/items/:id/state', policy: 'item:read' },
  { method: 'POST', path: '/api/items/:id/retry', policy: 'item:owner' },
  { method: 'POST', path: '/api/items/:id/reprocess', policy: 'item:owner' },
  { method: 'POST', path: '/api/items/:id/restore', policy: 'item:owner' },
  { method: 'DELETE', path: '/api/items/:id', policy: 'item:owner' },
  // Documents (PDF & EPUB)
  { method: 'POST', path: '/api/documents/upload', policy: 'authenticated', rateLimit: { windowMs: 60000, max: 30 } },
  { method: 'GET', path: '/api/documents/:id/download', policy: 'item:read' },
  // Tags
  { method: 'GET', path: '/api/tags', policy: 'authenticated' },
  { method: 'POST', path: '/api/tags', policy: 'authenticated' },
  { method: 'POST', path: '/api/items/:id/tags', policy: 'item:owner' },
  { method: 'DELETE', path: '/api/items/:id/tags/:tagId', policy: 'item:owner' },
  // Collections & Sharing
  { method: 'GET', path: '/api/collections', policy: 'authenticated' },
  { method: 'POST', path: '/api/collections', policy: 'authenticated' },
  { method: 'GET', path: '/api/collections/:id', policy: 'collection:read' },
  { method: 'PATCH', path: '/api/collections/:id', policy: 'collection:edit' },
  { method: 'DELETE', path: '/api/collections/:id', policy: 'collection:owner' },
  { method: 'POST', path: '/api/collections/:id/items', policy: 'collection:edit' },
  { method: 'DELETE', path: '/api/collections/:id/items/:itemId', policy: 'collection:edit' },
  { method: 'POST', path: '/api/collections/:id/members', policy: 'collection:owner' },
  { method: 'PATCH', path: '/api/collections/:id/members/:userId', policy: 'collection:owner' },
  { method: 'DELETE', path: '/api/collections/:id/members/:userId', policy: 'collection:owner' },
  // Annotations
  { method: 'GET', path: '/api/items/:id/annotations', policy: 'item:read' },
  { method: 'POST', path: '/api/items/:id/annotations', policy: 'item:read' },
  { method: 'PATCH', path: '/api/annotations/:id', policy: 'annotation:write' },
  { method: 'DELETE', path: '/api/annotations/:id', policy: 'annotation:write' },
  { method: 'GET', path: '/api/annotations/export', policy: 'authenticated' },
  // Search
  { method: 'GET', path: '/api/search', policy: 'authenticated' },
  // Feeds (RSS/Atom)
  { method: 'GET', path: '/api/feeds', policy: 'authenticated' },
  { method: 'POST', path: '/api/feeds', policy: 'authenticated' },
  { method: 'POST', path: '/api/feeds/discover', policy: 'authenticated' },
  { method: 'GET', path: '/api/feeds/:id/entries', policy: 'feed:owner' },
  { method: 'POST', path: '/api/feeds/:id/refresh', policy: 'feed:owner' },
  { method: 'PATCH', path: '/api/feeds/:id', policy: 'feed:owner' },
  { method: 'DELETE', path: '/api/feeds/:id', policy: 'feed:owner' },
  { method: 'POST', path: '/api/feeds/:id/entries/:entryId/state', policy: 'feed:owner' },
  { method: 'POST', path: '/api/feeds/:id/entries/:entryId/save', policy: 'feed:owner' },
  // Offline Sync
  { method: 'POST', path: '/api/sync', policy: 'authenticated' },
  { method: 'GET', path: '/api/sync/conflicts', policy: 'authenticated' },
  // Knowledge Graph
  { method: 'GET', path: '/api/graph', policy: 'authenticated' },
  { method: 'POST', path: '/api/graph/links', policy: 'authenticated' },
  { method: 'GET', path: '/api/items/:id/recommendations', policy: 'item:read' },
  // Import & Export
  { method: 'POST', path: '/api/export', policy: 'authenticated' },
  { method: 'GET', path: '/api/export/:id/download', policy: 'export:owner' },
  { method: 'POST', path: '/api/import', policy: 'authenticated' }
];
