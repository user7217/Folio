const TRACKING_PARAMS = new Set([
  'fbclid',
  'gclid',
  'dclid',
  'msclkid',
  'mc_cid',
  'mc_eid',
  'ref_src',
  '_hsenc',
  '_hsmi',
  'igshid',
  'twclid',
  'yclid',
  'vero_id',
  'mkt_tok'
]);

export function isTrackingParam(key: string): boolean {
  const lower = key.toLowerCase();
  return lower.startsWith('utm_') || TRACKING_PARAMS.has(lower);
}

export interface NormalizedUrlResult {
  originalUrl: string;
  normalizedUrl: string;
  hostname: string;
  domain: string;
  protocol: 'http:' | 'https:';
  port: string;
}

/**
 * Single canonical URL parser and normalizer used for both validation and fetching.
 * - Rejects non-http/https schemes and embedded credentials.
 * - Lowercases scheme and host.
 * - Strips default ports (80 for http, 443 for https) and fragments (#...).
 * - Strips documented tracking parameters (utm_*, fbclid, gclid, etc.).
 * - Sorts remaining query parameters deterministically.
 */
export function parseAndNormalizeUrl(rawInput: string): NormalizedUrlResult {
  if (!rawInput || typeof rawInput !== 'string') {
    throw new UrlValidationError('URL must be a non-empty string', 'INVALID_URL');
  }
  const trimmed = rawInput.trim();
  if (trimmed.length > 4096) {
    throw new UrlValidationError('URL exceeds maximum length of 4096 characters', 'URL_TOO_LONG');
  }
  // Reject control characters or whitespace inside URL
  if (/[\u0000-\u001f\u007f\s]/.test(trimmed)) {
    throw new UrlValidationError('URL contains control characters or spaces', 'INVALID_CHARS');
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new UrlValidationError(`Malformed URL: ${trimmed}`, 'MALFORMED_URL');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new UrlValidationError(`Disallowed URL scheme: ${parsed.protocol}`, 'DISALLOWED_SCHEME');
  }

  if (parsed.username || parsed.password) {
    throw new UrlValidationError('Embedded credentials in URL are not allowed', 'EMBEDDED_CREDENTIALS');
  }

  if (!parsed.hostname) {
    throw new UrlValidationError('URL is missing hostname', 'MISSING_HOST');
  }

  // Strip fragment
  parsed.hash = '';

  // Normalize hostname (lowercase, strip trailing dot)
  const cleanHost = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (!cleanHost) {
    throw new UrlValidationError('Empty hostname after normalization', 'EMPTY_HOST');
  }
  parsed.hostname = cleanHost;

  // Strip default ports explicitly
  if ((parsed.protocol === 'http:' && parsed.port === '80') || (parsed.protocol === 'https:' && parsed.port === '443')) {
    parsed.port = '';
  }

  // Filter and sort query parameters
  const keptParams: Array<[string, string]> = [];
  for (const [k, v] of parsed.searchParams.entries()) {
    if (!isTrackingParam(k)) {
      keptParams.push([k, v]);
    }
  }
  keptParams.sort((a, b) => {
    if (a[0] !== b[0]) return a[0].localeCompare(b[0]);
    return a[1].localeCompare(b[1]);
  });

  const newSearch = new URLSearchParams();
  for (const [k, v] of keptParams) {
    newSearch.append(k, v);
  }
  const searchStr = newSearch.toString();
  parsed.search = searchStr ? `?${searchStr}` : '';

  // Normalize empty path to '/'
  if (!parsed.pathname) {
    parsed.pathname = '/';
  }

  const domain = cleanHost.startsWith('www.') ? cleanHost.slice(4) : cleanHost;

  return {
    originalUrl: trimmed,
    normalizedUrl: parsed.toString(),
    hostname: cleanHost,
    domain,
    protocol: parsed.protocol,
    port: parsed.port,
  };
}

export class UrlValidationError extends Error {
  public readonly code: string;
  public readonly errorClass: 'permanent' = 'permanent';

  constructor(message: string, code: string) {
    super(message);
    this.name = 'UrlValidationError';
    this.code = code;
  }
}

/**
 * Redacts query strings and credentials from URLs before logging (Section 9.3).
 */
export function redactUrlForLog(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    u.username = '';
    u.password = '';
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch {
    return '[invalid-url]';
  }
}
