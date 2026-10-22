import crypto from 'node:crypto';

/**
 * Generates an RFC 9562 UUIDv7 (time-ordered, non-sequential random bits).
 */
export function uuidv7(nowMs = Date.now()) {
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

export const ROUTE_REGISTRY = [
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
