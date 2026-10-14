import crypto from 'node:crypto';
import fs from 'node:fs';
import {
  EXTRACTOR_NAME,
  EXTRACTOR_VERSION,
  discoverFeedsFromHtml,
  parseEpubBuffer,
  parsePdfBuffer,
} from '../../../packages/article-processing/src/index.ts';
import {
  CURRENT_SCHEMA_VERSION,
  ContainedDatabase,
  hashPassword,
  parseAndNormalizeUrl,
  sha256Hex,
  verifyPassword,
} from '../../../packages/db/src/index.ts';
import { buildTextAnchor } from '../../../packages/shared/src/anchoring.ts';
import type { AuthActor, ResourceContext } from '../../../packages/shared/src/authz.ts';
import { can } from '../../../packages/shared/src/authz.ts';
import type {
  Annotation,
  ClientMutation,
  Collection,
  CollectionRole,
  Item,
  RouteDefinition,
  ThemeId,
  User,
} from '../../../packages/shared/src/index.ts';
import { ROUTE_REGISTRY, uuidv7 } from '../../../packages/shared/src/index.ts';
import { THEMES } from '../../../packages/shared/src/themes.ts';
import { UrlValidationError } from '../../../packages/shared/src/url.ts';
import { renderAppScreenHtml } from '../../../packages/ui/src/index.ts';

export interface AppRequest {
  method: string;
  path: string; // e.g. '/api/items?view=inbox'
  headers?: Record<string, string>;
  body?: unknown;
  rawBodyBytes?: number;
  ip?: string;
}

export interface AppResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

interface MatchedRoute {
  route: RouteDefinition;
  params: Record<string, string>;
}

function matchRegisteredRoute(method: string, pathname: string): MatchedRoute | null {
  const upperMethod = method.toUpperCase();
  const cleanPath = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  const reqSegs = cleanPath.split('/');

  for (const r of ROUTE_REGISTRY) {
    if (r.method !== upperMethod) continue;
    const routeSegs = r.path.split('/');
    if (routeSegs.length !== reqSegs.length) continue;

    const params: Record<string, string> = {};
    let matched = true;
    for (let i = 0; i < routeSegs.length; i++) {
      if (routeSegs[i].startsWith(':')) {
        params[routeSegs[i].slice(1)] = decodeURIComponent(reqSegs[i]);
      } else if (routeSegs[i] !== reqSegs[i]) {
        matched = false;
        break;
      }
    }
    if (matched) {
      return { route: r, params };
    }
  }
  return null;
}

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!cookieHeader) return out;
  for (const pair of cookieHeader.split(';')) {
    const idx = pair.indexOf('=');
    if (idx > 0) {
      const k = pair.slice(0, idx).trim();
      const v = pair.slice(idx + 1).trim();
      out[k] = v;
    }
  }
  return out;
}

export class ReadingPlatformApp {
  public readonly db: ContainedDatabase;
  private rateLimitBuckets: Map<string, { count: number; resetAt: number }> = new Map();
  private searchLatenciesMs: number[] = [];
  private maxRequestBytes: number;

  constructor(db: ContainedDatabase, options: { maxRequestBytes?: number } = {}) {
    this.db = db;
    this.maxRequestBytes = options.maxRequestBytes ?? 55 * 1024 * 1024;
  }

  public resetRateLimits(): void {
    this.rateLimitBuckets.clear();
  }

  private defaultSecurityHeaders(): Record<string, string> {
    return {
      'Content-Security-Policy':
        "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' https: http: data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
    };
  }

  private resolveActor(headers: Record<string, string>): {
    actor: AuthActor;
    sessionId: string | null;
    csrfToken: string | null;
  } {
    const cookies = parseCookies(headers['cookie']);
    const sessionToken = cookies['rp_session'] || headers['x-session-token'];
    const authHeader = headers['authorization'] || '';

    if (authHeader.toLowerCase().startsWith('bearer ')) {
      const rawToken = authHeader.slice(7).trim();
      const tokenHash = sha256Hex(rawToken);
      return this.db.read((st) => {
        const pt = Object.values(st.pairing_tokens).find((t) => t.token_hash === tokenHash);
        if (!pt) {
          return { actor: { user: null, authType: 'none' }, sessionId: null, csrfToken: null };
        }
        if (pt.revoked_at) {
          return {
            actor: { user: null, authType: 'extension_token', tokenRevoked: true },
            sessionId: null,
            csrfToken: null,
          };
        }
        const user = st.users[pt.user_id] || null;
        return {
          actor: { user, authType: 'extension_token' },
          sessionId: null,
          csrfToken: null,
        };
      });
    }

    if (sessionToken) {
      const tokenHash = sha256Hex(sessionToken);
      const nowMs = Date.now();
      return this.db.read((st) => {
        const sess = Object.values(st.sessions).find((s) => s.token_hash === tokenHash);
        if (!sess) {
          return { actor: { user: null, authType: 'none' }, sessionId: null, csrfToken: null };
        }
        if (
          sess.revoked_at ||
          Date.parse(sess.idle_expires_at) <= nowMs ||
          Date.parse(sess.absolute_expires_at) <= nowMs
        ) {
          return {
            actor: { user: null, authType: 'session', sessionRevoked: true },
            sessionId: sess.id,
            csrfToken: null,
          };
        }
        const user = st.users[sess.user_id] || null;
        return {
          actor: { user, authType: 'session' },
          sessionId: sess.id,
          csrfToken: sess.csrf_token,
        };
      });
    }

    return { actor: { user: null, authType: 'none' }, sessionId: null, csrfToken: null };
  }

  private buildResourceContext(actor: AuthActor, params: Record<string, string>, routePath: string): ResourceContext {
    return this.db.read((st) => {
      const ctx: ResourceContext = {};
      const userId = actor.user?.id || '';

      if (routePath.startsWith('/api/items/:id') || routePath.startsWith('/api/documents/:id')) {
        const item = st.items[params.id] || null;
        ctx.item = item;
        if (item && userId) {
          ctx.itemSharedCollectionRoles = this.db.getUserSharedCollectionRolesForItem(userId, item.id);
        }
      } else if (routePath.startsWith('/api/collections/:id')) {
        const col = st.collections[params.id] || null;
        ctx.collection = col;
        if (col && userId) {
          ctx.collectionMember = st.collection_members[`${col.id}:${userId}`] || null;
        }
      } else if (routePath.startsWith('/api/annotations/:id')) {
        ctx.annotation = st.annotations[params.id] || null;
      } else if (routePath.startsWith('/api/feeds/:id')) {
        ctx.feed = st.feeds[params.id] || null;
      } else if (routePath.startsWith('/api/export/:id')) {
        ctx.exportArtifact = st.export_artifacts[params.id] || null;
      }

      return ctx;
    });
  }

  public async handleRequest(req: AppRequest): Promise<AppResponse> {
    const baseHeaders = this.defaultSecurityHeaders();
    const normHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers || {})) {
      normHeaders[k.toLowerCase()] = String(v);
    }

    const bodySize =
      req.rawBodyBytes ??
      (req.body ? Buffer.byteLength(typeof req.body === 'string' ? req.body : JSON.stringify(req.body)) : 0);
    if (bodySize > this.maxRequestBytes) {
      return {
        status: 413,
        headers: { ...baseHeaders, 'Content-Type': 'application/json' },
        body: { error: 'Payload too large', code: 'PAYLOAD_TOO_LARGE' },
      };
    }

    const parsedUrl = new URL(req.path, 'http://localhost');
    const matched = matchRegisteredRoute(req.method, parsedUrl.pathname);
    if (!matched) {
      return {
        status: 404,
        headers: { ...baseHeaders, 'Content-Type': 'application/json' },
        body: { error: 'Route not found', code: 'ROUTE_NOT_FOUND' },
      };
    }

    const { route, params } = matched;
    const { actor, sessionId, csrfToken } = this.resolveActor(normHeaders);

    // Enforce rate limit if configured on route
    if (route.rateLimit) {
      const clientKey = `${route.method}:${route.path}:${actor.user?.id || req.ip || 'anon'}`;
      const now = Date.now();
      let bucket = this.rateLimitBuckets.get(clientKey);
      if (!bucket || now >= bucket.resetAt) {
        bucket = { count: 0, resetAt: now + route.rateLimit.windowMs };
        this.rateLimitBuckets.set(clientKey, bucket);
      }
      bucket.count += 1;
      if (bucket.count > route.rateLimit.max) {
        return {
          status: 429,
          headers: { ...baseHeaders, 'Content-Type': 'application/json', 'Retry-After': '60' },
          body: { error: 'Rate limit exceeded', code: 'RATE_LIMITED' },
        };
      }
    }

    // CSRF / Origin check on state-mutating session requests
    if (
      ['POST', 'PUT', 'PATCH', 'DELETE'].includes(route.method) &&
      !route.csrfExempt &&
      actor.authType === 'session'
    ) {
      const reqOrigin = normHeaders['origin'];
      const reqCsrf = normHeaders['x-csrf-token'];
      if (reqOrigin && !reqOrigin.startsWith('http://localhost') && !reqOrigin.startsWith('http://127.0.0.1')) {
        return {
          status: 403,
          headers: { ...baseHeaders, 'Content-Type': 'application/json' },
          body: { error: 'Cross-origin mutation rejected', code: 'CSRF_ORIGIN_MISMATCH' },
        };
      }
      if (reqCsrf && csrfToken && reqCsrf !== csrfToken) {
        return {
          status: 403,
          headers: { ...baseHeaders, 'Content-Type': 'application/json' },
          body: { error: 'Invalid CSRF token', code: 'CSRF_TOKEN_INVALID' },
        };
      }
    }

    // Central authorization check
    const resourceContext = this.buildResourceContext(actor, params, route.path);
    const decision = can(actor, route.policy, resourceContext);
    if (!decision.allowed) {
      return {
        status: decision.statusCode,
        headers: { ...baseHeaders, 'Content-Type': 'application/json' },
        body: {
          error: decision.statusCode === 404 ? 'Resource not found' : 'Access denied',
          code: decision.reason.toUpperCase(),
        },
      };
    }

    const bodyObj = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;

    try {
      return await this.dispatchAuthorizedRoute(
        route,
        params,
        parsedUrl.searchParams,
        bodyObj,
        actor,
        sessionId,
        baseHeaders
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        status: 400,
        headers: { ...baseHeaders, 'Content-Type': 'application/json' },
        body: { error: message, code: 'BAD_REQUEST' },
      };
    }
  }

  private async dispatchAuthorizedRoute(
    route: RouteDefinition,
    params: Record<string, string>,
    query: URLSearchParams,
    body: Record<string, unknown>,
    actor: AuthActor,
    sessionId: string | null,
    baseHeaders: Record<string, string>
  ): Promise<AppResponse> {
    const json = (status: number, payload: unknown, extraHeaders: Record<string, string> = {}): AppResponse => ({
      status,
      headers: { ...baseHeaders, 'Content-Type': 'application/json', ...extraHeaders },
      body: payload,
    });

    // 1. Health & Readiness
    if (route.method === 'GET' && route.path === '/healthz') {
      return json(200, { status: 'ok', timestamp: new Date().toISOString() });
    }

    if (route.method === 'GET' && route.path === '/readyz') {
      try {
        const schemaVer = this.db.read((st) => st.schema_version);
        const writableProbe = `${this.db.dataDir}/.readyz_probe_${process.pid}`;
        fs.writeFileSync(writableProbe, 'ok');
        fs.unlinkSync(writableProbe);
        const migrationsCurrent = schemaVer === CURRENT_SCHEMA_VERSION;
        return json(migrationsCurrent ? 200 : 503, {
          status: migrationsCurrent ? 'ready' : 'migrations_pending',
          database: 'reachable',
          schema_version: schemaVer,
          expected_schema_version: CURRENT_SCHEMA_VERSION,
          storage: 'writable',
        });
      } catch (err) {
        return json(503, { status: 'not_ready', error: String(err) });
      }
    }

    // 2. PWA Manifest, Service Worker, and UI HTML
    if (route.method === 'GET' && route.path === '/manifest.webmanifest') {
      return json(200, {
        name: 'Self-Hosted Reading & Knowledge Platform',
        short_name: 'ReaderKB',
        start_url: '/',
        display: 'standalone',
        background_color: '#FAF8F5',
        theme_color: '#8B261D',
        share_target: {
          action: '/api/share-target',
          method: 'POST',
          enctype: 'application/x-www-form-urlencoded',
          params: { title: 'title', text: 'text', url: 'url' },
        },
      });
    }

    if (route.method === 'GET' && route.path === '/sw.js') {
      const swCode = `
const SHELL_CACHE = 'rp-shell-v2';
const ITEM_CACHE = 'rp-offline-items-v2';
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll(['/', '/manifest.webmanifest'])));
});
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(caches.match(e.request).then((cached) => cached || fetch(e.request)));
});`;
      return {
        status: 200,
        headers: { ...baseHeaders, 'Content-Type': 'application/javascript' },
        body: swCode.trim(),
      };
    }

    if (route.method === 'GET' && route.path === '/') {
      const screenParam = (query.get('screen') || 'library') as
        | 'library'
        | 'reader'
        | 'settings'
        | 'command-palette'
        | 'error-state'
        | 'pdf-reader';
      const themeParam = (query.get('theme') ||
        (actor.user?.settings.theme && actor.user.settings.theme !== 'system'
          ? actor.user.settings.theme
          : 'editorial-light')) as ThemeId;
      const safeTheme: ThemeId = THEMES[themeParam] ? themeParam : 'editorial-light';

      const items = actor.user
        ? this.db.read((st) => Object.values(st.items).filter((i) => this.db.canUserReadItem(actor.user!.id, i)))
        : [];
      const activeId = query.get('id') || items[0]?.id;
      const activeItem = activeId ? this.db.read((st) => st.items[activeId]) : undefined;
      const rev =
        activeItem?.current_revision_id
          ? this.db.read((st) => st.item_revisions[activeItem.current_revision_id!])
          : undefined;

      const html = renderAppScreenHtml({
        screen: screenParam,
        theme: safeTheme,
        userSettings: actor.user?.settings,
        items,
        activeItem,
        sanitizedReaderHtml: rev?.sanitized_html,
        toc: rev?.toc,
        errorMessage: activeItem?.error_message || undefined,
      });

      return {
        status: 200,
        headers: { ...baseHeaders, 'Content-Type': 'text/html; charset=utf-8' },
        body: html,
      };
    }

    // 3. Authentication & Bootstrap
    if (route.method === 'POST' && route.path === '/api/auth/bootstrap') {
      const username = String(body.username || '').trim();
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      if (!username || !email || password.length < 8) {
        return json(400, { error: 'Username, email, and password (>= 8 chars) required' });
      }

      const existingCount = this.db.read((st) => Object.keys(st.users).length);
      if (existingCount > 0) {
        return json(409, { error: 'Bootstrap already completed', code: 'ALREADY_BOOTSTRAPPED' });
      }

      const now = new Date().toISOString();
      const adminUser: User = {
        id: uuidv7(),
        username,
        email,
        password_hash: hashPassword(password),
        role: 'admin',
        settings: {
          theme: 'editorial-light',
          listLayout: 'comfortable',
          reader: {
            width: 'medium',
            fontSize: 18,
            fontFamily: 'serif',
            lineSpacing: 1.7,
            distractionFree: false,
          },
          offlineStorageCapMb: 250,
        },
        created_at: now,
        updated_at: now,
      };

      this.db.transaction((st) => {
        st.users[adminUser.id] = adminUser;
        st.audit_events.push({
          id: uuidv7(),
          actor_id: adminUser.id,
          action: 'auth.admin_bootstrap',
          resource_type: 'user',
          resource_id: adminUser.id,
          metadata: { email },
          created_at: now,
        });
      });

      return json(201, {
        id: adminUser.id,
        username: adminUser.username,
        email: adminUser.email,
        role: adminUser.role,
      });
    }

    if (route.method === 'POST' && route.path === '/api/auth/register') {
      const username = String(body.username || '').trim();
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      const inviteCode = String(body.inviteCode || '').trim();

      if (!username || !email || password.length < 8) {
        return json(400, { error: 'Username, email, and password (>= 8 chars) required' });
      }

      const regMode = process.env.REGISTRATION_MODE || 'invite_only';
      const codeHash = inviteCode ? sha256Hex(inviteCode) : '';

      return this.db.transaction((st) => {
        if (Object.values(st.users).some((u) => u.email === email || u.username === username)) {
          return json(409, { error: 'User already exists', code: 'USER_EXISTS' });
        }

        if (regMode === 'invite_only') {
          const inv = Object.values(st.invitations).find(
            (i) => i.code_hash === codeHash && !i.used_by && Date.parse(i.expires_at) > Date.now()
          );
          if (!inv) {
            return json(403, { error: 'Valid invitation code required', code: 'INVITE_REQUIRED' });
          }
          const now = new Date().toISOString();
          const newUser: User = {
            id: uuidv7(),
            username,
            email,
            password_hash: hashPassword(password),
            role: 'user',
            settings: {
              theme: 'editorial-light',
              listLayout: 'comfortable',
              reader: {
                width: 'medium',
                fontSize: 18,
                fontFamily: 'serif',
                lineSpacing: 1.7,
                distractionFree: false,
              },
              offlineStorageCapMb: 250,
            },
            created_at: now,
            updated_at: now,
          };
          st.users[newUser.id] = newUser;
          inv.used_by = newUser.id;
          return json(201, { id: newUser.id, username: newUser.username, email: newUser.email, role: newUser.role });
        }

        const now = new Date().toISOString();
        const newUser: User = {
          id: uuidv7(),
          username,
          email,
          password_hash: hashPassword(password),
          role: 'user',
          settings: {
            theme: 'editorial-light',
            listLayout: 'comfortable',
            reader: {
              width: 'medium',
              fontSize: 18,
              fontFamily: 'serif',
              lineSpacing: 1.7,
              distractionFree: false,
            },
            offlineStorageCapMb: 250,
          },
          created_at: now,
          updated_at: now,
        };
        st.users[newUser.id] = newUser;
        return json(201, { id: newUser.id, username: newUser.username, email: newUser.email, role: newUser.role });
      });
    }

    if (route.method === 'POST' && route.path === '/api/auth/login') {
      const emailOrUser = String(body.email || body.username || '').trim().toLowerCase();
      const password = String(body.password || '');

      const user = this.db.read((st) =>
        Object.values(st.users).find(
          (u) => u.email.toLowerCase() === emailOrUser || u.username.toLowerCase() === emailOrUser
        )
      );

      if (!user || !verifyPassword(password, user.password_hash)) {
        return json(401, { error: 'Invalid credentials', code: 'INVALID_CREDENTIALS' });
      }

      const rawSessionToken = crypto.randomBytes(32).toString('base64url');
      const csrfToken = crypto.randomBytes(24).toString('base64url');
      const now = Date.now();
      const nowIso = new Date(now).toISOString();

      this.db.transaction((st) => {
        // Rotate any existing caller session
        if (sessionId && st.sessions[sessionId]) {
          st.sessions[sessionId].revoked_at = nowIso;
        }
        const newSessId = uuidv7();
        st.sessions[newSessId] = {
          id: newSessId,
          user_id: user.id,
          token_hash: sha256Hex(rawSessionToken),
          csrf_token: csrfToken,
          created_at: nowIso,
          last_active_at: nowIso,
          idle_expires_at: new Date(now + 7 * 24 * 3600_000).toISOString(),
          absolute_expires_at: new Date(now + 30 * 24 * 3600_000).toISOString(),
          revoked_at: null,
        };
      });

      const isProd = process.env.NODE_ENV === 'production';
      const cookieFlags = `HttpOnly; Path=/; SameSite=Lax${isProd ? '; Secure' : ''}`;
      return json(
        200,
        {
          user: { id: user.id, username: user.username, email: user.email, role: user.role, settings: user.settings },
          sessionToken: rawSessionToken,
          csrfToken,
        },
        {
          'Set-Cookie': `rp_session=${rawSessionToken}; ${cookieFlags}`,
        }
      );
    }

    if (route.method === 'POST' && route.path === '/api/auth/logout') {
      if (sessionId) {
        this.db.transaction((st) => {
          if (st.sessions[sessionId]) {
            st.sessions[sessionId].revoked_at = new Date().toISOString();
          }
        });
      }
      return json(
        200,
        { ok: true },
        { 'Set-Cookie': 'rp_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax' }
      );
    }

    if (route.method === 'POST' && route.path === '/api/auth/sessions/revoke') {
      const userId = actor.user!.id;
      const revokedCount = this.db.transaction((st) => {
        let count = 0;
        const now = new Date().toISOString();
        for (const s of Object.values(st.sessions)) {
          if (s.user_id === userId && !s.revoked_at) {
            s.revoked_at = now;
            count++;
          }
        }
        return count;
      });
      return json(200, { ok: true, revokedCount });
    }

    if (route.method === 'GET' && route.path === '/api/auth/me') {
      const u = actor.user!;
      return json(200, {
        id: u.id,
        username: u.username,
        email: u.email,
        role: u.role,
        settings: u.settings,
      });
    }

    if (route.method === 'PATCH' && route.path === '/api/user/settings') {
      const userId = actor.user!.id;
      const updatedSettings = this.db.transaction((st) => {
        const u = st.users[userId];
        if (typeof body.theme === 'string' && (THEMES[body.theme as ThemeId] || body.theme === 'system')) {
          u.settings.theme = body.theme as User['settings']['theme'];
        }
        if (body.listLayout === 'compact' || body.listLayout === 'comfortable') {
          u.settings.listLayout = body.listLayout;
        }
        if (typeof body.offlineStorageCapMb === 'number') {
          u.settings.offlineStorageCapMb = Math.max(10, Math.min(2000, body.offlineStorageCapMb));
        }
        if (body.reader && typeof body.reader === 'object') {
          const r = body.reader as Record<string, unknown>;
          if (r.width === 'narrow' || r.width === 'medium' || r.width === 'wide') u.settings.reader.width = r.width;
          if (typeof r.fontSize === 'number') u.settings.reader.fontSize = Math.max(12, Math.min(28, r.fontSize));
          if (r.fontFamily === 'serif' || r.fontFamily === 'sans') u.settings.reader.fontFamily = r.fontFamily;
          if (typeof r.lineSpacing === 'number') u.settings.reader.lineSpacing = Math.max(1.2, Math.min(2.4, r.lineSpacing));
          if (typeof r.distractionFree === 'boolean') u.settings.reader.distractionFree = r.distractionFree;
        }
        u.updated_at = new Date().toISOString();
        return u.settings;
      });
      return json(200, { settings: updatedSettings });
    }

    // 4. Admin Routes
    if (route.method === 'POST' && route.path === '/api/admin/invitations') {
      const rawCode = `inv_${crypto.randomBytes(16).toString('base64url')}`;
      const email = body.email ? String(body.email).toLowerCase() : null;
      const now = new Date().toISOString();
      const invId = uuidv7();
      this.db.transaction((st) => {
        st.invitations[invId] = {
          id: invId,
          code_hash: sha256Hex(rawCode),
          email,
          created_by: actor.user!.id,
          used_by: null,
          expires_at: new Date(Date.now() + 7 * 24 * 3600_000).toISOString(),
          created_at: now,
        };
        st.audit_events.push({
          id: uuidv7(),
          actor_id: actor.user!.id,
          action: 'admin.invitation_created',
          resource_type: 'invitation',
          resource_id: invId,
          metadata: { email },
          created_at: now,
        });
      });
      return json(201, { id: invId, inviteCode: rawCode });
    }

    if (route.method === 'POST' && route.path === '/api/admin/password-reset') {
      const targetUserId = String(body.userId || '');
      const newPassword = String(body.newPassword || '');
      if (!targetUserId || newPassword.length < 8) {
        return json(400, { error: 'userId and newPassword (>= 8 chars) required' });
      }
      return this.db.transaction((st) => {
        const target = st.users[targetUserId];
        if (!target) return json(404, { error: 'User not found' });
        const now = new Date().toISOString();
        target.password_hash = hashPassword(newPassword);
        target.updated_at = now;
        for (const s of Object.values(st.sessions)) {
          if (s.user_id === targetUserId && !s.revoked_at) {
            s.revoked_at = now;
          }
        }
        st.audit_events.push({
          id: uuidv7(),
          actor_id: actor.user!.id,
          action: 'admin.password_reset',
          resource_type: 'user',
          resource_id: targetUserId,
          metadata: {},
          created_at: now,
        });
        return json(200, { ok: true });
      });
    }

    if (route.method === 'GET' && route.path === '/api/admin/diagnostics') {
      return this.db.read((st) => {
        const queueDepth: Record<string, number> = {
          queued: 0,
          running: 0,
          completed: 0,
          failed: 0,
          dead_letter: 0,
        };
        const durations: number[] = [];
        for (const j of Object.values(st.jobs)) {
          queueDepth[j.status] = (queueDepth[j.status] || 0) + 1;
          if (typeof j.duration_ms === 'number') durations.push(j.duration_ms);
        }

        let readyItems = 0;
        let partialItems = 0;
        let failedItems = 0;
        for (const it of Object.values(st.items)) {
          if (it.processing_status === 'ready') readyItems++;
          else if (it.processing_status === 'partial') partialItems++;
          else if (it.processing_status === 'failed') failedItems++;
        }

        const feeds = Object.values(st.feeds);
        const avgSearchMs =
          this.searchLatenciesMs.length > 0
            ? Number(
                (this.searchLatenciesMs.reduce((a, b) => a + b, 0) / this.searchLatenciesMs.length).toFixed(3)
              )
            : 0;

        return json(200, {
          queueDepth,
          jobDurationStats: {
            samples: durations.length,
            avgMs: durations.length
              ? Number((durations.reduce((a, b) => a + b, 0) / durations.length).toFixed(2))
              : 0,
          },
          extractionRates: {
            ready: readyItems,
            partial: partialItems,
            failed: failedItems,
          },
          feedPolling: {
            totalFeeds: feeds.length,
            feedsWithErrors: feeds.filter((f) => Boolean(f.last_error)).length,
          },
          searchLatency: {
            samples: this.searchLatenciesMs.length,
            avgMs: avgSearchMs,
          },
          workerHeartbeats: Object.values(st.worker_heartbeats),
        });
      });
    }

    if (route.method === 'GET' && route.path === '/api/admin/audit-events') {
      return this.db.read((st) => json(200, { events: st.audit_events }));
    }

    // 5. Extension Pairing (Section 8.2)
    if (route.method === 'POST' && route.path === '/api/extension/pair/start') {
      const name = String(body.name || 'Chromium Extension').trim();
      const rawPairingCode = `pair_${crypto.randomBytes(8).toString('hex')}`;
      const id = uuidv7();
      const now = new Date().toISOString();
      this.db.transaction((st) => {
        st.pairing_tokens[id] = {
          id,
          user_id: actor.user!.id,
          name,
          pairing_code_hash: sha256Hex(rawPairingCode),
          pairing_expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
          token_hash: null,
          revoked_at: null,
          created_at: now,
        };
      });
      return json(201, { id, pairingCode: rawPairingCode, expiresInSeconds: 600 });
    }

    if (route.method === 'POST' && route.path === '/api/extension/pair/exchange') {
      const pairingCode = String(body.pairingCode || '').trim();
      if (!pairingCode) return json(400, { error: 'pairingCode required' });
      const codeHash = sha256Hex(pairingCode);

      return this.db.transaction((st) => {
        const pt = Object.values(st.pairing_tokens).find(
          (p) =>
            p.pairing_code_hash === codeHash &&
            p.pairing_expires_at &&
            Date.parse(p.pairing_expires_at) > Date.now() &&
            !p.revoked_at
        );
        if (!pt) {
          return json(401, { error: 'Invalid or expired pairing code', code: 'PAIRING_INVALID' });
        }
        const rawExtToken = `ext_${crypto.randomBytes(24).toString('base64url')}`;
        pt.pairing_code_hash = null;
        pt.pairing_expires_at = null;
        pt.token_hash = sha256Hex(rawExtToken);
        return json(200, { tokenId: pt.id, accessToken: rawExtToken, scope: 'capture' });
      });
    }

    if (route.method === 'POST' && route.path === '/api/extension/tokens/:id/revoke') {
      return this.db.transaction((st) => {
        const pt = st.pairing_tokens[params.id];
        if (!pt || pt.user_id !== actor.user!.id) {
          return json(404, { error: 'Token not found' });
        }
        pt.revoked_at = new Date().toISOString();
        return json(200, { ok: true });
      });
    }

    // 6. URL Capture, Bookmarklet, and Web Share Target
    if (
      (route.method === 'POST' && route.path === '/api/items/capture') ||
      (route.method === 'GET' && route.path === '/api/bookmarklet/capture') ||
      (route.method === 'POST' && route.path === '/api/share-target')
    ) {
      const rawUrl = String(body.url || query.get('url') || body.text || '').trim();
      const customTitle = String(body.title || query.get('title') || '').trim();
      const selectedQuote = String(body.selection || '').trim();

      let norm;
      try {
        norm = parseAndNormalizeUrl(rawUrl);
      } catch (err) {
        if (err instanceof UrlValidationError) {
          return json(400, { error: err.message, code: err.code });
        }
        throw err;
      }

      const ownerId = actor.user!.id;
      const outcome = this.db.transaction((st) => {
        // Check duplicate (owner_id, normalized_url)
        const existing = Object.values(st.items).find(
          (i) => i.owner_id === ownerId && i.normalized_url === norm.normalizedUrl
        );
        if (existing) {
          return { duplicate: true, item: existing, jobId: null };
        }

        const now = new Date().toISOString();
        const item: Item = {
          id: uuidv7(),
          owner_id: ownerId,
          url: norm.originalUrl,
          normalized_url: norm.normalizedUrl,
          canonical_url: null,
          possible_duplicate_of: null,
          title: customTitle || norm.hostname,
          author: null,
          publisher: norm.domain,
          domain: norm.domain,
          published_at: null,
          description: selectedQuote || null,
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
        // Persist capture record BEFORE scheduling job (Section 4 & 8.1)
        st.items[item.id] = item;
        this.db.getOrCreateUserItemState(ownerId, item.id);
        this.db.indexSingleItem(item);

        const job = this.db.enqueueJob(
          'capture.extract',
          { itemId: item.id, url: item.normalized_url },
          { idempotencyKey: `capture:${item.id}:1` }
        );
        return { duplicate: false, item, jobId: job.id };
      });

      return json(outcome.duplicate ? 200 : 201, outcome);
    }

    // 7. Library Views, Sorting, Filtering, Cursor Pagination, and Bulk Actions
    if (route.method === 'GET' && route.path === '/api/items') {
      const userId = actor.user!.id;
      const view = query.get('view') || 'all'; // inbox, all, unread, favorites, archived, failed, trashed
      const tagFilter = query.get('tag')?.toLowerCase();
      const colFilter = query.get('collection');
      const domainFilter = query.get('domain')?.toLowerCase();
      const typeFilter = query.get('type');
      const statusFilter = query.get('status');
      const favFilter = query.get('favorite');
      const sortBy = query.get('sort') || 'created_at'; // created_at, title, published_at, reading_time
      const sortDir = query.get('order') === 'asc' ? 1 : -1;
      const limit = Math.max(1, Math.min(100, Number(query.get('limit') || 20)));
      const cursor = query.get('cursor');

      return this.db.read((st) => {
        const rows: Array<{ item: Item; state: ReturnType<ContainedDatabase['getOrCreateUserItemState']>; tags: string[] }> = [];

        for (const item of Object.values(st.items)) {
          if (!this.db.canUserReadItem(userId, item)) continue;
          const uState = this.db.getOrCreateUserItemState(userId, item.id);

          if (view === 'trashed') {
            if (uState.lifecycle !== 'trashed') continue;
          } else {
            if (uState.lifecycle === 'trashed') continue;
          }

          if (view === 'inbox' && (uState.is_read || uState.lifecycle !== 'active')) continue;
          if (view === 'unread' && (uState.is_read || uState.lifecycle !== 'active')) continue;
          if (view === 'favorites' && !uState.is_favorite) continue;
          if (view === 'archived' && uState.lifecycle !== 'archived') continue;
          if (view === 'failed' && item.processing_status !== 'failed') continue;

          if (domainFilter && item.domain.toLowerCase() !== domainFilter) continue;
          if (typeFilter && item.content_type !== typeFilter) continue;
          if (statusFilter && item.processing_status !== statusFilter) continue;
          if (favFilter === 'true' && !uState.is_favorite) continue;

          const itemTags: string[] = [];
          for (const it of Object.values(st.item_tags)) {
            if (it.item_id === item.id) {
              const t = st.tags[it.tag_id];
              if (t) itemTags.push(t.name);
            }
          }
          if (tagFilter && !itemTags.some((t) => t.toLowerCase() === tagFilter)) continue;

          if (colFilter) {
            const inCol = Boolean(st.collection_items[`${colFilter}:${item.id}`]);
            if (!inCol) continue;
          }

          rows.push({ item, state: uState, tags: itemTags });
        }

        rows.sort((a, b) => {
          if (sortBy === 'title') return a.item.title.localeCompare(b.item.title) * sortDir;
          if (sortBy === 'reading_time') return (a.item.reading_time_minutes - b.item.reading_time_minutes) * sortDir;
          if (sortBy === 'published_at') {
            return (a.item.published_at || '').localeCompare(b.item.published_at || '') * sortDir;
          }
          return a.item.created_at.localeCompare(b.item.created_at) * sortDir;
        });

        let startIdx = 0;
        if (cursor) {
          const idx = rows.findIndex((r) => r.item.id === cursor);
          if (idx !== -1) startIdx = idx + 1;
        }
        const page = rows.slice(startIdx, startIdx + limit);
        const nextCursor = startIdx + limit < rows.length ? page[page.length - 1]?.item.id || null : null;

        return json(200, { items: page, nextCursor, totalCount: rows.length });
      });
    }

    if (route.method === 'POST' && route.path === '/api/items/bulk') {
      const userId = actor.user!.id;
      const itemIds = Array.isArray(body.itemIds) ? body.itemIds.map(String) : [];
      const action = String(body.action || ''); // mark_read, mark_unread, favorite, archive, add_tag, add_to_collection

      const updatedCount = this.db.transaction((st) => {
        let count = 0;
        const now = new Date().toISOString();
        for (const id of itemIds) {
          const item = st.items[id];
          if (!item || !this.db.canUserReadItem(userId, item)) continue;
          const uState = this.db.getOrCreateUserItemState(userId, id);
          if (action === 'mark_read') uState.is_read = true;
          else if (action === 'mark_unread') uState.is_read = false;
          else if (action === 'favorite') uState.is_favorite = true;
          else if (action === 'archive') uState.lifecycle = 'archived';
          else if (action === 'add_tag' && body.tagName && item.owner_id === userId) {
            const tName = String(body.tagName).trim();
            const normName = tName.toLowerCase();
            let tag = Object.values(st.tags).find((t) => t.owner_id === userId && t.normalized_name === normName);
            if (!tag) {
              tag = { id: uuidv7(), owner_id: userId, collection_id: null, name: tName, normalized_name: normName, created_at: now };
              st.tags[tag.id] = tag;
            }
            st.item_tags[`${id}:${tag.id}`] = { item_id: id, tag_id: tag.id, added_by: userId, created_at: now };
            this.db.indexSingleItem(item);
          } else if (action === 'add_to_collection' && body.collectionId && item.owner_id === userId) {
            const colId = String(body.collectionId);
            if (st.collections[colId]) {
              st.collection_items[`${colId}:${id}`] = { collection_id: colId, item_id: id, added_by: userId, created_at: now };
              this.db.indexSingleItem(item);
            }
          }
          uState.version += 1;
          uState.updated_at = now;
          count++;
        }
        return count;
      });
      return json(200, { ok: true, updatedCount });
    }

    if (route.method === 'GET' && route.path === '/api/items/:id') {
      const userId = actor.user!.id;
      return this.db.read((st) => {
        const item = st.items[params.id]!;
        const state = this.db.getOrCreateUserItemState(userId, item.id);
        const revision = item.current_revision_id ? st.item_revisions[item.current_revision_id] || null : null;
        const tags = Object.values(st.item_tags)
          .filter((it) => it.item_id === item.id)
          .map((it) => st.tags[it.tag_id])
          .filter(Boolean);
        return json(200, { item, state, revision, tags });
      });
    }

    if (route.method === 'PATCH' && route.path === '/api/items/:id') {
      return this.db.transaction((st) => {
        const item = st.items[params.id]!;
        if (typeof body.title === 'string' && body.title.trim()) item.title = body.title.trim();
        if (typeof body.author === 'string') item.author = body.author.trim() || null;
        if (typeof body.description === 'string') item.description = body.description.trim() || null;
        item.version += 1;
        item.updated_at = new Date().toISOString();
        this.db.indexSingleItem(item);
        return json(200, { item });
      });
    }

    if (route.method === 'POST' && route.path === '/api/items/:id/state') {
      const userId = actor.user!.id;
      return this.db.transaction((st) => {
        const uState = this.db.getOrCreateUserItemState(userId, params.id);
        const now = new Date().toISOString();
        if (typeof body.is_read === 'boolean') uState.is_read = body.is_read;
        if (typeof body.is_favorite === 'boolean') uState.is_favorite = body.is_favorite;
        if (body.lifecycle === 'active' || body.lifecycle === 'archived' || body.lifecycle === 'trashed') {
          uState.lifecycle = body.lifecycle;
          uState.trashed_at = body.lifecycle === 'trashed' ? now : null;
        }
        if (typeof body.progress_percent === 'number') {
          uState.progress_percent = Math.max(0, Math.min(100, body.progress_percent));
          uState.last_read_at = now;
        }
        if (typeof body.progress_page === 'number') {
          uState.progress_page = Math.max(1, body.progress_page);
          uState.last_read_at = now;
        }
        if (typeof body.progress_spine === 'string') {
          uState.progress_spine = body.progress_spine;
          uState.last_read_at = now;
        }
        if (typeof body.offline_cached === 'boolean') {
          uState.offline_cached = body.offline_cached;
        }
        uState.version += 1;
        uState.updated_at = now;
        st.user_item_states[`${userId}:${params.id}`] = uState;
        return json(200, { state: uState });
      });
    }

    if (route.method === 'POST' && (route.path === '/api/items/:id/retry' || route.path === '/api/items/:id/reprocess')) {
      return this.db.transaction((st) => {
        const item = st.items[params.id]!;
        item.processing_status = 'queued';
        item.error_message = null;
        item.error_class = null;
        item.updated_at = new Date().toISOString();
        const job = this.db.enqueueJob(
          'capture.extract',
          { itemId: item.id, url: item.normalized_url },
          { idempotencyKey: `reprocess:${item.id}:${Date.now()}` }
        );
        return json(200, { item, jobId: job.id });
      });
    }

    if (route.method === 'POST' && route.path === '/api/items/:id/restore') {
      const userId = actor.user!.id;
      return this.db.transaction((st) => {
        const uState = this.db.getOrCreateUserItemState(userId, params.id);
        uState.lifecycle = 'active';
        uState.trashed_at = null;
        uState.version += 1;
        uState.updated_at = new Date().toISOString();
        st.user_item_states[`${userId}:${params.id}`] = uState;
        return json(200, { state: uState });
      });
    }

    if (route.method === 'DELETE' && route.path === '/api/items/:id') {
      const permanent = query.get('permanent') === 'true' || body.permanent === true;
      if (permanent) {
        this.db.permanentlyDeleteItem(params.id, actor.user!.id);
        return json(200, { ok: true, deleted: 'permanent' });
      }
      const userId = actor.user!.id;
      return this.db.transaction((st) => {
        const uState = this.db.getOrCreateUserItemState(userId, params.id);
        uState.lifecycle = 'trashed';
        uState.trashed_at = new Date().toISOString();
        uState.version += 1;
        uState.updated_at = uState.trashed_at;
        st.user_item_states[`${userId}:${params.id}`] = uState;
        return json(200, { ok: true, deleted: 'trashed', state: uState });
      });
    }

    // 8. Documents (PDF & EPUB upload and secure download)
    if (route.method === 'POST' && route.path === '/api/documents/upload') {
      const filename = String(body.filename || 'document.pdf').trim();
      const base64Data = String(body.dataBase64 || '');
      if (!base64Data) return json(400, { error: 'dataBase64 is required' });
      const buf = Buffer.from(base64Data, 'base64');

      const lowerName = filename.toLowerCase();
      const ownerId = actor.user!.id;
      const now = new Date().toISOString();

      if (lowerName.endsWith('.pdf')) {
        const parsedPdf = parsePdfBuffer(buf, filename);
        const blobId = this.db.blobs.put(buf);
        const itemId = uuidv7();
        const item: Item = {
          id: itemId,
          owner_id: ownerId,
          url: `file:///documents/${itemId}/${encodeURIComponent(filename)}`,
          normalized_url: `https://documents.local/${itemId}/${encodeURIComponent(filename)}`,
          canonical_url: null,
          possible_duplicate_of: null,
          title: parsedPdf.title,
          author: null,
          publisher: 'Uploaded PDF',
          domain: 'documents.local',
          published_at: now,
          description: parsedPdf.plainText.slice(0, 240) || 'PDF document',
          featured_image: null,
          language: 'en',
          reading_time_minutes: Math.max(1, Math.ceil(parsedPdf.plainText.split(/\s+/).length / 200)),
          content_type: 'pdf',
          processing_status: 'ready',
          error_message: null,
          error_class: null,
          current_revision_id: null,
          blob_id: blobId,
          page_count: parsedPdf.pageCount,
          ocr_status: parsedPdf.ocrStatus,
          outbound_urls: [],
          version: 1,
          created_at: now,
          updated_at: now,
        };
        this.db.transaction((st) => {
          st.items[item.id] = item;
          this.db.getOrCreateUserItemState(ownerId, item.id);
        });
        this.db.applyNewRevision(item.id, {
          extractor_name: EXTRACTOR_NAME,
          extractor_version: EXTRACTOR_VERSION,
          content_hash: sha256Hex(parsedPdf.sanitizedHtml),
          sanitized_html: parsedPdf.sanitizedHtml,
          plain_text: parsedPdf.plainText,
          toc: [],
          spine: [],
          pages: parsedPdf.pages,
        });
        return json(201, { item: this.db.read((st) => st.items[item.id]) });
      }

      if (lowerName.endsWith('.epub')) {
        const parsedEpub = parseEpubBuffer(buf);
        const blobId = this.db.blobs.put(buf);
        const itemId = uuidv7();
        const item: Item = {
          id: itemId,
          owner_id: ownerId,
          url: `file:///documents/${itemId}/${encodeURIComponent(filename)}`,
          normalized_url: `https://documents.local/${itemId}/${encodeURIComponent(filename)}`,
          canonical_url: null,
          possible_duplicate_of: null,
          title: parsedEpub.title,
          author: parsedEpub.author,
          publisher: 'Uploaded EPUB',
          domain: 'documents.local',
          published_at: now,
          description: parsedEpub.plainText.slice(0, 240),
          featured_image: null,
          language: 'en',
          reading_time_minutes: Math.max(1, Math.ceil(parsedEpub.plainText.split(/\s+/).length / 200)),
          content_type: 'epub',
          processing_status: 'ready',
          error_message: null,
          error_class: null,
          current_revision_id: null,
          blob_id: blobId,
          page_count: parsedEpub.spine.length,
          ocr_status: 'none',
          outbound_urls: [],
          version: 1,
          created_at: now,
          updated_at: now,
        };
        this.db.transaction((st) => {
          st.items[item.id] = item;
          this.db.getOrCreateUserItemState(ownerId, item.id);
        });
        this.db.applyNewRevision(item.id, {
          extractor_name: EXTRACTOR_NAME,
          extractor_version: EXTRACTOR_VERSION,
          content_hash: sha256Hex(parsedEpub.sanitizedHtml),
          sanitized_html: parsedEpub.sanitizedHtml,
          plain_text: parsedEpub.plainText,
          toc: parsedEpub.toc,
          spine: parsedEpub.spine,
          pages: [],
        });
        return json(201, { item: this.db.read((st) => st.items[item.id]) });
      }

      return json(400, { error: 'Unsupported document extension: expected .pdf or .epub' });
    }

    if (route.method === 'GET' && route.path === '/api/documents/:id/download') {
      const item = this.db.read((st) => st.items[params.id])!;
      if (!item.blob_id) {
        return json(404, { error: 'No binary blob associated with item' });
      }
      const data = this.db.blobs.get(item.blob_id);
      const ext = item.content_type === 'epub' ? 'epub' : 'pdf';
      const safeFilename = `${item.id}.${ext}`;
      return {
        status: 200,
        headers: {
          ...baseHeaders,
          'Content-Type': item.content_type === 'epub' ? 'application/epub+zip' : 'application/pdf',
          'Content-Disposition': `attachment; filename="${safeFilename}"`,
          'X-Content-Type-Options': 'nosniff',
        },
        body: data,
      };
    }

    // 9. Tags
    if (route.method === 'GET' && route.path === '/api/tags') {
      const userId = actor.user!.id;
      return this.db.read((st) => {
        const tags = Object.values(st.tags).filter((t) => t.owner_id === userId);
        return json(200, { tags });
      });
    }

    if (route.method === 'POST' && route.path === '/api/tags') {
      const name = String(body.name || '').trim();
      if (!name) return json(400, { error: 'Tag name required' });
      const userId = actor.user!.id;
      const collectionId = body.collectionId ? String(body.collectionId) : null;
      const normName = name.toLowerCase();

      return this.db.transaction((st) => {
        const existing = Object.values(st.tags).find(
          (t) => t.owner_id === userId && t.collection_id === collectionId && t.normalized_name === normName
        );
        if (existing) return json(200, { tag: existing });
        const tag = {
          id: uuidv7(),
          owner_id: userId,
          collection_id: collectionId,
          name,
          normalized_name: normName,
          created_at: new Date().toISOString(),
        };
        st.tags[tag.id] = tag;
        return json(201, { tag });
      });
    }

    if (route.method === 'POST' && route.path === '/api/items/:id/tags') {
      const userId = actor.user!.id;
      const name = String(body.name || '').trim();
      if (!name) return json(400, { error: 'Tag name required' });
      const normName = name.toLowerCase();

      return this.db.transaction((st) => {
        const item = st.items[params.id]!;
        let tag = Object.values(st.tags).find(
          (t) => t.owner_id === userId && !t.collection_id && t.normalized_name === normName
        );
        const now = new Date().toISOString();
        if (!tag) {
          tag = { id: uuidv7(), owner_id: userId, collection_id: null, name, normalized_name: normName, created_at: now };
          st.tags[tag.id] = tag;
        }
        st.item_tags[`${item.id}:${tag.id}`] = {
          item_id: item.id,
          tag_id: tag.id,
          added_by: userId,
          created_at: now,
        };
        this.db.indexSingleItem(item);
        return json(200, { tag });
      });
    }

    if (route.method === 'DELETE' && route.path === '/api/items/:id/tags/:tagId') {
      return this.db.transaction((st) => {
        const item = st.items[params.id]!;
        delete st.item_tags[`${item.id}:${params.tagId}`];
        this.db.indexSingleItem(item);
        return json(200, { ok: true });
      });
    }

    // 10. Collections (Flat, Nested, and Shared)
    if (route.method === 'GET' && route.path === '/api/collections') {
      const userId = actor.user!.id;
      return this.db.read((st) => {
        const collections = Object.values(st.collections).filter(
          (c) => c.owner_id === userId || Boolean(st.collection_members[`${c.id}:${userId}`])
        );
        return json(200, { collections });
      });
    }

    if (route.method === 'POST' && route.path === '/api/collections') {
      const name = String(body.name || '').trim();
      if (!name) return json(400, { error: 'Collection name required' });
      const parentId = body.parentId ? String(body.parentId) : null;
      const now = new Date().toISOString();
      const col: Collection = {
        id: uuidv7(),
        owner_id: actor.user!.id,
        parent_id: parentId,
        name,
        description: body.description ? String(body.description) : null,
        version: 1,
        created_at: now,
        updated_at: now,
      };
      this.db.transaction((st) => {
        if (parentId && !st.collections[parentId]) {
          throw new Error('Parent collection not found');
        }
        st.collections[col.id] = col;
      });
      return json(201, { collection: col });
    }

    if (route.method === 'GET' && route.path === '/api/collections/:id') {
      return this.db.read((st) => {
        const col = st.collections[params.id]!;
        const items = Object.values(st.collection_items)
          .filter((ci) => ci.collection_id === col.id)
          .map((ci) => st.items[ci.item_id])
          .filter(Boolean);
        const members = Object.values(st.collection_members).filter((m) => m.collection_id === col.id);
        return json(200, { collection: col, items, members });
      });
    }

    if (route.method === 'PATCH' && route.path === '/api/collections/:id') {
      return this.db.transaction((st) => {
        const col = st.collections[params.id]!;
        if (body.parentId !== undefined) {
          const newParentId = body.parentId ? String(body.parentId) : null;
          if (newParentId) {
            if (newParentId === col.id) {
              return json(400, { error: 'Cannot move collection into itself', code: 'CYCLE_DETECTED' });
            }
            // Walk ancestors of newParentId to prevent moving a collection into its own descendant
            let curr: string | null = newParentId;
            while (curr) {
              if (curr === col.id) {
                return json(400, {
                  error: 'Cannot move collection into its own descendant',
                  code: 'CYCLE_DETECTED',
                });
              }
              curr = st.collections[curr]?.parent_id || null;
            }
          }
          col.parent_id = newParentId;
        }
        if (typeof body.name === 'string' && body.name.trim()) col.name = body.name.trim();
        if (typeof body.description === 'string') col.description = body.description;
        col.version += 1;
        col.updated_at = new Date().toISOString();
        return json(200, { collection: col });
      });
    }

    if (route.method === 'DELETE' && route.path === '/api/collections/:id') {
      const mode = query.get('mode') || String(body.mode || ''); // 'promote' or 'recursive'
      return this.db.transaction((st) => {
        const col = st.collections[params.id]!;
        const children = Object.values(st.collections).filter((c) => c.parent_id === col.id);
        if (children.length > 0 && mode !== 'promote' && mode !== 'recursive') {
          return json(400, {
            error: 'Deleting a parent collection requires mode=promote or mode=recursive',
            code: 'DELETE_MODE_REQUIRED',
          });
        }

        const deleteSingleCol = (cid: string) => {
          delete st.collections[cid];
          for (const [k, ci] of Object.entries(st.collection_items)) {
            if (ci.collection_id === cid) delete st.collection_items[k];
          }
          for (const [k, cm] of Object.entries(st.collection_members)) {
            if (cm.collection_id === cid) delete st.collection_members[k];
          }
        };

        if (mode === 'promote') {
          for (const ch of children) {
            ch.parent_id = col.parent_id;
          }
          deleteSingleCol(col.id);
        } else if (mode === 'recursive') {
          const visit = (cid: string) => {
            for (const ch of Object.values(st.collections).filter((c) => c.parent_id === cid)) {
              visit(ch.id);
            }
            deleteSingleCol(cid);
          };
          visit(col.id);
        } else {
          deleteSingleCol(col.id);
        }
        return json(200, { ok: true });
      });
    }

    if (route.method === 'POST' && route.path === '/api/collections/:id/items') {
      const itemId = String(body.itemId || '');
      const userId = actor.user!.id;
      return this.db.transaction((st) => {
        const item = st.items[itemId];
        // Editors may add their OWN items to the collection (Section 6.6)
        if (!item || item.owner_id !== userId) {
          return json(403, { error: 'Can only add items you own to a collection', code: 'ITEM_OWNER_REQUIRED' });
        }
        st.collection_items[`${params.id}:${itemId}`] = {
          collection_id: params.id,
          item_id: itemId,
          added_by: userId,
          created_at: new Date().toISOString(),
        };
        this.db.indexSingleItem(item);
        return json(200, { ok: true });
      });
    }

    if (route.method === 'DELETE' && route.path === '/api/collections/:id/items/:itemId') {
      return this.db.transaction((st) => {
        delete st.collection_items[`${params.id}:${params.itemId}`];
        const item = st.items[params.itemId];
        if (item) this.db.indexSingleItem(item);
        return json(200, { ok: true });
      });
    }

    if (route.method === 'POST' && route.path === '/api/collections/:id/members') {
      const targetUserId = String(body.userId || '');
      const role = String(body.role || 'viewer') as CollectionRole;
      if (!['owner', 'editor', 'viewer'].includes(role)) {
        return json(400, { error: 'Invalid role' });
      }
      return this.db.transaction((st) => {
        if (!st.users[targetUserId]) return json(404, { error: 'Target user not found' });
        const now = new Date().toISOString();
        st.collection_members[`${params.id}:${targetUserId}`] = {
          collection_id: params.id,
          user_id: targetUserId,
          role,
          invited_by: actor.user!.id,
          created_at: now,
        };
        st.audit_events.push({
          id: uuidv7(),
          actor_id: actor.user!.id,
          action: 'collection.member_invited',
          resource_type: 'collection',
          resource_id: params.id,
          metadata: { targetUserId, role },
          created_at: now,
        });
        return json(201, { member: st.collection_members[`${params.id}:${targetUserId}`] });
      });
    }

    if (route.method === 'PATCH' && route.path === '/api/collections/:id/members/:userId') {
      const role = String(body.role || 'viewer') as CollectionRole;
      return this.db.transaction((st) => {
        const mem = st.collection_members[`${params.id}:${params.userId}`];
        if (!mem) return json(404, { error: 'Member not found' });
        mem.role = role;
        st.audit_events.push({
          id: uuidv7(),
          actor_id: actor.user!.id,
          action: 'collection.role_changed',
          resource_type: 'collection',
          resource_id: params.id,
          metadata: { targetUserId: params.userId, role },
          created_at: new Date().toISOString(),
        });
        return json(200, { member: mem });
      });
    }

    if (route.method === 'DELETE' && route.path === '/api/collections/:id/members/:userId') {
      return this.db.transaction((st) => {
        delete st.collection_members[`${params.id}:${params.userId}`];
        st.audit_events.push({
          id: uuidv7(),
          actor_id: actor.user!.id,
          action: 'collection.member_revoked',
          resource_type: 'collection',
          resource_id: params.id,
          metadata: { targetUserId: params.userId },
          created_at: new Date().toISOString(),
        });
        return json(200, { ok: true });
      });
    }

    // 11. Annotations
    if (route.method === 'GET' && route.path === '/api/items/:id/annotations') {
      const userId = actor.user!.id;
      return this.db.read((st) => {
        // User sees their own private annotations + annotations explicitly shared to collections they belong to
        const userCols = new Set<string>();
        for (const col of Object.values(st.collections)) {
          if (col.owner_id === userId || st.collection_members[`${col.id}:${userId}`]) {
            userCols.add(col.id);
          }
        }
        const annotations = Object.values(st.annotations).filter((a) => {
          if (a.item_id !== params.id) return false;
          if (a.user_id === userId) return true;
          return (a.shared_in_collections || []).some((cid) => userCols.has(cid));
        });
        return json(200, { annotations });
      });
    }

    if (route.method === 'POST' && route.path === '/api/items/:id/annotations') {
      const userId = actor.user!.id;
      return this.db.transaction((st) => {
        const item = st.items[params.id]!;
        const rev = item.current_revision_id ? st.item_revisions[item.current_revision_id] : null;
        const plain = rev ? rev.plain_text : '';

        const startOffset = Number(body.startOffset ?? 0);
        const endOffset = Number(body.endOffset ?? 0);
        const anchor =
          body.exactQuote && typeof body.exactQuote === 'string'
            ? {
                exactQuote: body.exactQuote,
                prefix: String(body.prefix || ''),
                suffix: String(body.suffix || ''),
                startOffset,
                endOffset,
              }
            : buildTextAnchor(plain, startOffset, endOffset);

        const now = new Date().toISOString();
        const ann: Annotation = {
          id: uuidv7(),
          item_id: item.id,
          user_id: userId,
          revision_id: item.current_revision_id || '',
          type: body.type === 'note' ? 'note' : 'highlight',
          exact_quote: anchor.exactQuote,
          prefix: anchor.prefix,
          suffix: anchor.suffix,
          start_offset: anchor.startOffset,
          end_offset: anchor.endOffset,
          page_number: typeof body.pageNumber === 'number' ? body.pageNumber : null,
          spine_item: typeof body.spineItem === 'string' ? body.spineItem : null,
          note: String(body.note || ''),
          color: String(body.color || 'yellow'),
          orphaned: false,
          shared_in_collections: Array.isArray(body.sharedInCollections) ? body.sharedInCollections.map(String) : [],
          version: 1,
          created_at: now,
          updated_at: now,
        };
        st.annotations[ann.id] = ann;
        this.db.indexSingleItem(item);
        return json(201, { annotation: ann });
      });
    }

    if (route.method === 'PATCH' && route.path === '/api/annotations/:id') {
      return this.db.transaction((st) => {
        const ann = st.annotations[params.id]!;
        if (typeof body.note === 'string') ann.note = body.note;
        if (typeof body.color === 'string') ann.color = body.color;
        if (Array.isArray(body.sharedInCollections)) {
          ann.shared_in_collections = body.sharedInCollections.map(String);
        }
        ann.version += 1;
        ann.updated_at = new Date().toISOString();
        const item = st.items[ann.item_id];
        if (item) this.db.indexSingleItem(item);
        return json(200, { annotation: ann });
      });
    }

    if (route.method === 'DELETE' && route.path === '/api/annotations/:id') {
      return this.db.transaction((st) => {
        const ann = st.annotations[params.id]!;
        const item = st.items[ann.item_id];
        delete st.annotations[params.id];
        if (item) this.db.indexSingleItem(item);
        return json(200, { ok: true });
      });
    }

    if (route.method === 'GET' && route.path === '/api/annotations/export') {
      const userId = actor.user!.id;
      return this.db.read((st) => {
        const annotations = Object.values(st.annotations)
          .filter((a) => a.user_id === userId)
          .map((a) => {
            const item = st.items[a.item_id];
            return {
              ...a,
              source_title: item?.title || '',
              source_url: item?.url || '',
            };
          });
        return json(200, { annotations });
      });
    }

    // 12. Search (Lexical + Hybrid RRF)
    if (route.method === 'GET' && route.path === '/api/search') {
      const q = query.get('q') || '';
      const cursor = query.get('cursor') || undefined;
      const limit = Number(query.get('limit') || 20);
      const mode = query.get('mode') === 'hybrid' ? 'hybrid' : 'lexical';

      const res = this.db.searchItems(actor.user!.id, q, { limit, cursor, mode });
      this.searchLatenciesMs.push(res.explain.executionTimeMs);
      if (!res.ok) {
        return json(400, { ok: false, errors: res.errors });
      }
      return json(200, {
        ok: true,
        mode,
        embeddingProvider: process.env.EMBEDDING_PROVIDER || 'lexical_fallback',
        hits: res.hits,
        nextCursor: res.nextCursor,
        explain: res.explain,
      });
    }

    // 13. Feeds (RSS/Atom)
    if (route.method === 'GET' && route.path === '/api/feeds') {
      const userId = actor.user!.id;
      return this.db.read((st) => {
        const feeds = Object.values(st.feeds).filter((f) => f.owner_id === userId);
        return json(200, { feeds });
      });
    }

    if (route.method === 'POST' && route.path === '/api/feeds') {
      const rawUrl = String(body.url || '').trim();
      const norm = parseAndNormalizeUrl(rawUrl);
      const pollInterval = Math.max(5, Number(body.pollIntervalMinutes || 30)); // minimum floor of 5 minutes
      const userId = actor.user!.id;

      return this.db.transaction((st) => {
        const existing = Object.values(st.feeds).find(
          (f) => f.owner_id === userId && f.normalized_url === norm.normalizedUrl
        );
        if (existing) return json(200, { feed: existing });
        const now = new Date().toISOString();
        const feed = {
          id: uuidv7(),
          owner_id: userId,
          url: norm.originalUrl,
          normalized_url: norm.normalizedUrl,
          site_url: null,
          title: String(body.title || norm.hostname),
          description: null,
          etag: null,
          last_modified: null,
          poll_interval_minutes: pollInterval,
          last_polled_at: null,
          last_error: null,
          error_count: 0,
          created_at: now,
          updated_at: now,
        };
        st.feeds[feed.id] = feed;
        this.db.enqueueJob('feed.poll', { feedId: feed.id }, { idempotencyKey: `feed:${feed.id}:init` });
        return json(201, { feed });
      });
    }

    if (route.method === 'POST' && route.path === '/api/feeds/discover') {
      const html = String(body.html || '');
      const baseUrl = String(body.url || 'https://example.com');
      const discovered = discoverFeedsFromHtml(html, baseUrl);
      return json(200, { feeds: discovered });
    }

    if (route.method === 'GET' && route.path === '/api/feeds/:id/entries') {
      return this.db.read((st) => {
        const entries = Object.values(st.feed_entries)
          .filter((e) => e.feed_id === params.id)
          .sort((a, b) => (b.published_at || b.created_at).localeCompare(a.published_at || a.created_at));
        return json(200, { entries });
      });
    }

    if (route.method === 'POST' && route.path === '/api/feeds/:id/refresh') {
      const job = this.db.transaction(() =>
        this.db.enqueueJob(
          'feed.poll',
          { feedId: params.id },
          { idempotencyKey: `feed:${params.id}:${Date.now()}` }
        )
      );
      return json(200, { ok: true, jobId: job.id });
    }

    if (route.method === 'PATCH' && route.path === '/api/feeds/:id') {
      return this.db.transaction((st) => {
        const feed = st.feeds[params.id]!;
        if (typeof body.pollIntervalMinutes === 'number') {
          feed.poll_interval_minutes = Math.max(5, body.pollIntervalMinutes);
        }
        if (typeof body.title === 'string' && body.title.trim()) {
          feed.title = body.title.trim();
        }
        feed.updated_at = new Date().toISOString();
        return json(200, { feed });
      });
    }

    if (route.method === 'DELETE' && route.path === '/api/feeds/:id') {
      return this.db.transaction((st) => {
        delete st.feeds[params.id];
        for (const [k, e] of Object.entries(st.feed_entries)) {
          if (e.feed_id === params.id) delete st.feed_entries[k];
        }
        return json(200, { ok: true });
      });
    }

    if (route.method === 'POST' && route.path === '/api/feeds/:id/entries/:entryId/state') {
      return this.db.transaction((st) => {
        const entry = st.feed_entries[params.entryId];
        if (!entry || entry.feed_id !== params.id) return json(404, { error: 'Feed entry not found' });
        if (typeof body.is_read === 'boolean') entry.is_read = body.is_read;
        return json(200, { entry });
      });
    }

    if (route.method === 'POST' && route.path === '/api/feeds/:id/entries/:entryId/save') {
      const userId = actor.user!.id;
      return this.db.transaction((st) => {
        const entry = st.feed_entries[params.entryId];
        if (!entry || entry.feed_id !== params.id) return json(404, { error: 'Feed entry not found' });

        const norm = parseAndNormalizeUrl(entry.url);
        const now = new Date().toISOString();
        const itemId = uuidv7();
        const item: Item = {
          id: itemId,
          owner_id: userId,
          url: entry.url,
          normalized_url: norm.normalizedUrl,
          canonical_url: null,
          possible_duplicate_of: null,
          title: entry.title,
          author: entry.author,
          publisher: norm.domain,
          domain: norm.domain,
          published_at: entry.published_at,
          description: entry.summary,
          featured_image: null,
          language: 'en',
          reading_time_minutes: 1,
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
          created_at: now,
          updated_at: now,
        };
        st.items[item.id] = item;
        this.db.getOrCreateUserItemState(userId, item.id);
        entry.saved_item_id = item.id;
        this.db.applyNewRevision(item.id, {
          extractor_name: EXTRACTOR_NAME,
          extractor_version: EXTRACTOR_VERSION,
          content_hash: sha256Hex(entry.content_html),
          sanitized_html: entry.content_html,
          plain_text: entry.summary,
          toc: [],
          spine: [],
          pages: [],
        });
        return json(201, { item });
      });
    }

    // 14. Offline Sync
    if (route.method === 'POST' && route.path === '/api/sync') {
      const mutations = (Array.isArray(body.mutations) ? body.mutations : []) as ClientMutation[];
      const results = this.db.applySyncMutations(actor.user!.id, mutations);
      return json(200, { results });
    }

    if (route.method === 'GET' && route.path === '/api/sync/conflicts') {
      const userId = actor.user!.id;
      return this.db.read((st) => {
        const conflicts = Object.values(st.sync_conflicts).filter((c) => c.user_id === userId);
        return json(200, { conflicts });
      });
    }

    // 15. Knowledge Graph & Explainable Recommendations (Section 8.9)
    if (route.method === 'GET' && route.path === '/api/graph') {
      const userId = actor.user!.id;
      const rootItemId = query.get('itemId');
      const depth = Math.max(1, Math.min(3, Number(query.get('depth') || 1)));
      const maxNodes = Math.max(5, Math.min(200, Number(query.get('maxNodes') || 50)));

      return this.db.read((st) => {
        const allUserEdges = Object.values(st.graph_edges).filter((e) => e.owner_id === userId);
        const visitedNodes = new Set<string>();
        const selectedEdges = [];

        if (rootItemId && st.items[rootItemId] && st.items[rootItemId].owner_id === userId) {
          visitedNodes.add(rootItemId);
        } else {
          const firstItem = Object.values(st.items).find((i) => i.owner_id === userId);
          if (firstItem) visitedNodes.add(firstItem.id);
        }

        for (let d = 0; d < depth; d++) {
          const frontier = Array.from(visitedNodes);
          for (const edge of allUserEdges) {
            if (visitedNodes.size >= maxNodes) break;
            if (frontier.includes(edge.source_item_id) || frontier.includes(edge.target_item_id)) {
              visitedNodes.add(edge.source_item_id);
              visitedNodes.add(edge.target_item_id);
              selectedEdges.push(edge);
            }
          }
        }

        const nodes = Array.from(visitedNodes)
          .slice(0, maxNodes)
          .map((id) => st.items[id])
          .filter(Boolean)
          .map((it) => ({
            id: it.id,
            title: it.title,
            domain: it.domain,
            contentType: it.content_type,
          }));

        return json(200, {
          nodes,
          edges: selectedEdges,
          textFallback: selectedEdges.map(
            (e) =>
              `${st.items[e.source_item_id]?.title || e.source_item_id} <-> ${st.items[e.target_item_id]?.title || e.target_item_id} (${e.explanation})`
          ),
        });
      });
    }

    if (route.method === 'POST' && route.path === '/api/graph/links') {
      const sourceId = String(body.sourceItemId || '');
      const targetId = String(body.targetItemId || '');
      const userId = actor.user!.id;
      return this.db.transaction((st) => {
        const s = st.items[sourceId];
        const t = st.items[targetId];
        if (!s || !t || s.owner_id !== userId || t.owner_id !== userId) {
          return json(404, { error: 'Items not found' });
        }
        const edge = {
          id: uuidv7(),
          owner_id: userId,
          source_item_id: sourceId,
          target_item_id: targetId,
          edge_type: 'explicit_link' as const,
          weight: 5,
          explanation: String(body.explanation || `Explicit link between "${s.title}" and "${t.title}"`),
          created_at: new Date().toISOString(),
        };
        st.graph_edges[edge.id] = edge;
        return json(201, { edge });
      });
    }

    if (route.method === 'GET' && route.path === '/api/items/:id/recommendations') {
      const userId = actor.user!.id;
      return this.db.read((st) => {
        const edges = Object.values(st.graph_edges).filter(
          (e) =>
            e.owner_id === userId &&
            (e.source_item_id === params.id || e.target_item_id === params.id)
        );
        const byOther = new Map<string, { score: number; reasons: string[] }>();
        for (const e of edges) {
          const otherId = e.source_item_id === params.id ? e.target_item_id : e.source_item_id;
          const item = st.items[otherId];
          if (!item || !this.db.canUserReadItem(userId, item)) continue;
          const entry = byOther.get(otherId) || { score: 0, reasons: [] };
          entry.score += e.weight;
          entry.reasons.push(e.explanation);
          byOther.set(otherId, entry);
        }

        const recommendations = Array.from(byOther.entries())
          .map(([itemId, info]) => ({
            item: st.items[itemId],
            score: info.score,
            reasons: info.reasons,
          }))
          .sort((a, b) => b.score - a.score);

        return json(200, { recommendations });
      });
    }

    // 16. Export & Import (Section 8.10)
    if (route.method === 'POST' && route.path === '/api/export') {
      const format = (body.format === 'csv' || body.format === 'opml' ? body.format : 'json') as
        | 'json'
        | 'csv'
        | 'opml';
      const exportId = uuidv7();
      const rawToken = crypto.randomBytes(24).toString('base64url');
      const job = this.db.transaction(() =>
        this.db.enqueueJob(
          'export.generate',
          { exportId, userId: actor.user!.id, format, rawToken },
          { idempotencyKey: `export:${exportId}` }
        )
      );
      return json(202, {
        exportId,
        jobId: job.id,
        downloadToken: rawToken,
        downloadPath: `/api/export/${exportId}/download?token=${rawToken}`,
      });
    }

    if (route.method === 'GET' && route.path === '/api/export/:id/download') {
      const token = query.get('token') || '';
      const artifact = this.db.read((st) => st.export_artifacts[params.id])!;
      if (!token || sha256Hex(token) !== artifact.download_token_hash) {
        return json(403, { error: 'Invalid download token', code: 'INVALID_EXPORT_TOKEN' });
      }
      if (Date.parse(artifact.expires_at) <= Date.now()) {
        return json(410, { error: 'Export link has expired', code: 'EXPORT_EXPIRED' });
      }
      const data = this.db.blobs.get(artifact.blob_id);
      const mime =
        artifact.format === 'csv'
          ? 'text/csv'
          : artifact.format === 'opml'
            ? 'text/x-opml'
            : 'application/json';
      return {
        status: 200,
        headers: {
          ...baseHeaders,
          'Content-Type': mime,
          'Content-Disposition': `attachment; filename="export-${artifact.id}.${artifact.format}"`,
          'X-Content-Type-Options': 'nosniff',
        },
        body: data.toString('utf8'),
      };
    }

    if (route.method === 'POST' && route.path === '/api/import') {
      const format = String(body.format || 'json').toLowerCase(); // json, csv, bookmarks_html, pocket_html, opml, txt
      const dryRun = body.dryRun === true;
      const rawContent = typeof body.content === 'string' ? body.content : JSON.stringify(body.data || body);
      const userId = actor.user!.id;

      let imported = 0;
      let updated = 0;
      let duplicate = 0;
      let skipped = 0;
      let failed = 0;

      const candidateUrls: Array<{ url: string; title?: string; tags?: string[] }> = [];

      if (format === 'json') {
        let parsed: Record<string, unknown>;
        try {
          parsed = typeof body.data === 'object' && body.data ? (body.data as Record<string, unknown>) : JSON.parse(rawContent);
        } catch {
          return json(400, { error: 'Invalid JSON import payload' });
        }
        if (parsed.schema_version !== '2.0' && parsed.schema_version !== '1.0') {
          return json(400, { error: 'Unsupported import schema_version' });
        }
        const itemsArr = Array.isArray(parsed.items) ? parsed.items : [];
        for (const rawIt of itemsArr) {
          if (!rawIt || typeof rawIt !== 'object') {
            failed++;
            continue;
          }
          const r = rawIt as Record<string, unknown>;
          candidateUrls.push({
            url: String(r.url || ''),
            title: r.title ? String(r.title) : undefined,
          });
        }
      } else if (format === 'bookmarks_html' || format === 'pocket_html') {
        for (const m of rawContent.matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
          candidateUrls.push({ url: m[1], title: m[2].replace(/<[^>]+>/g, '').trim() });
        }
      } else if (format === 'opml') {
        for (const m of rawContent.matchAll(/<outline[^>]+xmlUrl=["']([^"']+)["'][^>]*>/gi)) {
          const titleM = /text=["']([^"']+)["']/i.exec(m[0]);
          candidateUrls.push({ url: m[1], title: titleM ? titleM[1] : undefined });
        }
      } else if (format === 'csv' || format === 'txt') {
        const lines = rawContent.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        for (const line of lines) {
          if (line.toLowerCase().startsWith('url,')) continue;
          const firstCell = line.split(',')[0].replace(/^"|"$/g, '').trim();
          if (firstCell) candidateUrls.push({ url: firstCell });
        }
      } else {
        return json(400, { error: `Unsupported import format: ${format}` });
      }

      const applyChunk = () => {
        for (const cand of candidateUrls) {
          let norm;
          try {
            norm = parseAndNormalizeUrl(cand.url);
          } catch {
            failed++;
            continue;
          }
          const existing = this.db.read((st) =>
            Object.values(st.items).find((i) => i.owner_id === userId && i.normalized_url === norm.normalizedUrl)
          );
          if (existing) {
            duplicate++;
            continue;
          }
          imported++;
          if (!dryRun) {
            const now = new Date().toISOString();
            const item: Item = {
              id: uuidv7(),
              owner_id: userId,
              url: norm.originalUrl,
              normalized_url: norm.normalizedUrl,
              canonical_url: null,
              possible_duplicate_of: null,
              title: cand.title || norm.hostname,
              author: null,
              publisher: norm.domain,
              domain: norm.domain,
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
            this.db.transaction((st) => {
              st.items[item.id] = item;
              this.db.getOrCreateUserItemState(userId, item.id);
              this.db.indexSingleItem(item);
            });
          }
        }
      };

      applyChunk();

      return json(200, {
        dryRun,
        counts: { imported, updated, duplicate, skipped, failed },
      });
    }

    return json(404, { error: 'Unhandled route' });
  }
}
