import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from 'node:net';
import zlib from 'node:zlib';
import { parseAndNormalizeUrl, UrlValidationError } from './url.js';

export class SsrfError extends Error {
  code;
  errorClass;
  statusCode;

  constructor(
    message,
    code,
    errorClass = 'permanent',
    statusCode
  ) {
    super(message);
    this.name = 'SsrfError';
    this.code = code;
    this.errorClass = errorClass;
    this.statusCode = statusCode;
  }
}

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'metadata.aws.internal',
  'instance-data',
  'kubernetes.default',
  'kubernetes.default.svc',
  'kubernetes.default.svc.cluster.local',
]);

/**
 * Parses any IPv4 literal encoding variant (standard dotted quad, decimal integer,
 * octal, hexadecimal, shortened 1/2/3-part forms, or mixed radix) into a 32-bit unsigned integer.
 * Returns null if the string is not an IPv4 literal variant.
 */
export function parseIpv4LiteralToUint32(host) {
  const clean = host.trim().toLowerCase();
  if (!clean || clean.includes(':')) return null;

  const parts = clean.split('.');
  if (parts.length > 4) return null;

  const parsePart = (part) => {
    if (!part) return null;
    if (/^0x[0-9a-f]+$/i.test(part)) {
      const val = Number.parseInt(part.slice(2), 16);
      return Number.isSafeInteger(val) && val >= 0 ? val : null;
    }
    if (/^0[0-7]+$/.test(part)) {
      const val = Number.parseInt(part.slice(1), 8);
      return Number.isSafeInteger(val) && val >= 0 ? val : null;
    }
    if (/^(0|[1-9][0-9]*)$/.test(part)) {
      const val = Number.parseInt(part, 10);
      return Number.isSafeInteger(val) && val >= 0 ? val : null;
    }
    return null;
  };

  const parsedParts = [];
  for (const p of parts) {
    const val = parsePart(p);
    if (val === null) return null;
    parsedParts.push(val);
  }

  if (parsedParts.length === 1) {
    const v = parsedParts[0];
    if (v < 0 || v > 0xffffffff) return null;
    return v >>> 0;
  }
  if (parsedParts.length === 2) {
    if (parsedParts[0] > 0xff || parsedParts[1] > 0xffffff) return null;
    return ((parsedParts[0] << 24) | parsedParts[1]) >>> 0;
  }
  if (parsedParts.length === 3) {
    if (parsedParts[0] > 0xff || parsedParts[1] > 0xff || parsedParts[2] > 0xffff) return null;
    return ((parsedParts[0] << 24) | (parsedParts[1] << 16) | parsedParts[2]) >>> 0;
  }
  if (parsedParts.length === 4) {
    if (parsedParts.some((x) => x > 0xff)) return null;
    return ((parsedParts[0] << 24) | (parsedParts[1] << 16) | (parsedParts[2] << 8) | parsedParts[3]) >>> 0;
  }
  return null;
}

export function uint32ToIpv4String(num) {
  return [
    (num >>> 24) & 0xff,
    (num >>> 16) & 0xff,
    (num >>> 8) & 0xff,
    num & 0xff,
  ].join('.');
}

function inCidr32(ip, baseIp, prefixBits) {
  if (prefixBits === 0) return true;
  const mask = prefixBits === 32 ? 0xffffffff : (~0 << (32 - prefixBits)) >>> 0;
  return (ip & mask) >>> 0 === (baseIp & mask) >>> 0;
}

function ip4(a, b, c, d) {
  return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
}

const BLOCKED_IPV4_RANGES = [
  { base: ip4(0, 0, 0, 0), bits: 8, reason: 'UNSPECIFIED_IPV4' },
  { base: ip4(10, 0, 0, 0), bits: 8, reason: 'PRIVATE_RFC1918_10' },
  { base: ip4(100, 64, 0, 0), bits: 10, reason: 'CGNAT_100_64' },
  { base: ip4(127, 0, 0, 0), bits: 8, reason: 'LOOPBACK_127' },
  { base: ip4(169, 254, 0, 0), bits: 16, reason: 'LINK_LOCAL_AND_METADATA' },
  { base: ip4(172, 16, 0, 0), bits: 12, reason: 'PRIVATE_RFC1918_172' },
  { base: ip4(192, 0, 0, 0), bits: 24, reason: 'IETF_PROTOCOL_ASSIGNMENTS' },
  { base: ip4(192, 0, 2, 0), bits: 24, reason: 'TEST_NET_1' },
  { base: ip4(192, 88, 99, 0), bits: 24, reason: '6TO4_RELAY_ANYCAST' },
  { base: ip4(192, 168, 0, 0), bits: 16, reason: 'PRIVATE_RFC1918_192' },
  { base: ip4(198, 18, 0, 0), bits: 15, reason: 'BENCHMARK_TESTING' },
  { base: ip4(198, 51, 100, 0), bits: 24, reason: 'TEST_NET_2' },
  { base: ip4(203, 0, 113, 0), bits: 24, reason: 'TEST_NET_3' },
  { base: ip4(224, 0, 0, 0), bits: 4, reason: 'MULTICAST_IPV4' },
  { base: ip4(240, 0, 0, 0), bits: 4, reason: 'RESERVED_IPV4' },
  { base: ip4(255, 255, 255, 255), bits: 32, reason: 'BROADCAST_IPV4' },
];

export function checkIpv4Uint32Safety(ipNum) {
  for (const r of BLOCKED_IPV4_RANGES) {
    if (inCidr32(ipNum, r.base, r.bits)) {
      return { safe: false, reason: r.reason };
    }
  }
  return { safe: true };
}

/**
 * Parses an IPv6 address (with optional brackets stripped) into 8 16-bit groups.
 */
export function parseIpv6Groups(raw) {
  let addr = raw.trim().toLowerCase();
  if (addr.startsWith('[') && addr.endsWith(']')) {
    addr = addr.slice(1, -1);
  }
  // Reject zone identifiers (%eth0) immediately as link-local / interface-scoped
  if (addr.includes('%')) {
    return null;
  }

  // Handle embedded IPv4 at the end (e.g. ::ffff:127.0.0.1 or ::192.168.1.1)
  const lastColon = addr.lastIndexOf(':');
  if (lastColon !== -1 && addr.slice(lastColon + 1).includes('.')) {
    const v4Part = addr.slice(lastColon + 1);
    const v4Num = parseIpv4LiteralToUint32(v4Part);
    if (v4Num === null) return null;
    const hi = (v4Num >>> 16) & 0xffff;
    const lo = v4Num & 0xffff;
    addr = `${addr.slice(0, lastColon)}:${hi.toString(16)}:${lo.toString(16)}`;
  }

  if (!net.isIPv6(addr)) return null;

  const halves = addr.split('::');
  if (halves.length > 2) return null;

  const left = halves[0] ? halves[0].split(':').map((x) => Number.parseInt(x, 16)) : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':').map((x) => Number.parseInt(x, 16)) : [];
  if (left.some(Number.isNaN) || right.some(Number.isNaN)) return null;

  const missing = 8 - (left.length + right.length);
  if (halves.length === 1 && missing !== 0) return null;
  if (missing < 0) return null;

  return [...left, ...new Array(missing).fill(0), ...right];
}

export function checkIpSafety(ipOrLiteral) {
  const clean = ipOrLiteral.trim().replace(/^\[|\]$/g, '');
  if (clean.includes('%')) {
    return { safe: false, reason: 'IPV6_ZONE_ID_BLOCKED' };
  }

  // First check IPv4 (including octal, hex, decimal, shortened)
  const v4Num = parseIpv4LiteralToUint32(clean);
  if (v4Num !== null) {
    const res = checkIpv4Uint32Safety(v4Num);
    return {
      safe: res.safe,
      normalizedIp: uint32ToIpv4String(v4Num),
      reason: res.reason,
    };
  }

  // Check IPv6
  const groups = parseIpv6Groups(clean);
  if (groups !== null) {
    // Unspecified ::
    if (groups.every((g) => g === 0)) {
      return { safe: false, reason: 'UNSPECIFIED_IPV6' };
    }
    // Loopback ::1
    if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) {
      return { safe: false, reason: 'LOOPBACK_IPV6' };
    }
    // IPv4-mapped ::ffff:0:0/96, IPv4-compatible ::/96, or SIIT IPv4-translated ::ffff:0:0:0/96 (::ffff:0:w.x.y.z)
    if (
      groups[0] === 0 &&
      groups[1] === 0 &&
      groups[2] === 0 &&
      groups[3] === 0 &&
      ((groups[4] === 0 && (groups[5] === 0xffff || groups[5] === 0)) ||
        (groups[4] === 0xffff && groups[5] === 0))
    ) {
      const embeddedV4 = ((groups[6] << 16) | groups[7]) >>> 0;
      const v4Check = checkIpv4Uint32Safety(embeddedV4);
      if (!v4Check.safe) {
        return { safe: false, reason: `IPV4_MAPPED_${v4Check.reason}` };
      }
      return { safe: true, normalizedIp: clean };
    }
    // NAT64 64:ff9b::/96 (RFC 6052) and 64:ff9b:1::/48 (RFC 8215 local-use NAT64)
    if (groups[0] === 0x0064 && groups[1] === 0xff9b) {
      if (groups[2] === 0x0001) {
        return { safe: false, reason: 'NAT64_LOCAL_USE_IPV6' };
      }
      const embeddedV4 = ((groups[6] << 16) | groups[7]) >>> 0;
      const v4Check = checkIpv4Uint32Safety(embeddedV4);
      if (!v4Check.safe) {
        return { safe: false, reason: `NAT64_${v4Check.reason}` };
      }
    }
    // 6to4 2002::/16 embeds IPv4 in groups[1] and groups[2]
    if (groups[0] === 0x2002) {
      const embeddedV4 = ((groups[1] << 16) | groups[2]) >>> 0;
      const v4Check = checkIpv4Uint32Safety(embeddedV4);
      if (!v4Check.safe) {
        return { safe: false, reason: `6TO4_${v4Check.reason}` };
      }
    }
    // Teredo 2001:0000::/32
    if (groups[0] === 0x2001 && groups[1] === 0x0000) {
      return { safe: false, reason: 'TEREDO_IPV6' };
    }
    // Documentation 2001:db8::/32
    if (groups[0] === 0x2001 && groups[1] === 0x0db8) {
      return { safe: false, reason: 'DOCUMENTATION_IPV6' };
    }
    // Unique Local fc00::/7 (fc00..fdff)
    if ((groups[0] & 0xfe00) === 0xfc00) {
      return { safe: false, reason: 'ULA_IPV6' };
    }
    // Link-Local fe80::/10 (fe80..febf)
    if ((groups[0] & 0xffc0) === 0xfe80) {
      return { safe: false, reason: 'LINK_LOCAL_IPV6' };
    }
    // Site-local deprecated fec0::/10
    if ((groups[0] & 0xffc0) === 0xfec0) {
      return { safe: false, reason: 'SITE_LOCAL_IPV6' };
    }
    // Multicast ff00::/8
    if ((groups[0] & 0xff00) === 0xff00) {
      return { safe: false, reason: 'MULTICAST_IPV6' };
    }

    return { safe: true, normalizedIp: clean };
  }

  return { safe: false, reason: 'INVALID_IP_ADDRESS' };
}

/**
 * Validates a URL's scheme, credentials, port, hostname, and resolved IP addresses,
 * returning the pinned IP address to connect to directly (preventing DNS rebinding).
 */
export async function validateAndPinDestination(
  rawUrl,
  options = {}
) {
  // Pre-check raw host before URL constructor normalizes exotic IPv4 encodings
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/(.*)$/.exec(rawUrl.trim());
  if (!schemeMatch) {
    throw new SsrfError('Invalid URL or missing scheme', 'DISALLOWED_SCHEME', 'permanent');
  }
  const scheme = `${schemeMatch[1].toLowerCase()}:`;
  if (scheme !== 'http:' && scheme !== 'https:') {
    throw new SsrfError(`Disallowed scheme: ${scheme}`, 'DISALLOWED_SCHEME', 'permanent');
  }

  const authorityPart = schemeMatch[2].split(/[/?#\\]/)[0];
  if (authorityPart.includes('@')) {
    throw new SsrfError('Embedded credentials in URL are forbidden', 'EMBEDDED_CREDENTIALS', 'permanent');
  }

  const rawHostOnly = authorityPart.startsWith('[')
    ? authorityPart.slice(0, authorityPart.indexOf(']') + 1)
    : authorityPart.split(':')[0];

  // Check if rawHostOnly is an exotic IPv4 literal (octal, hex, decimal integer, shortened)
  const rawIpv4 = parseIpv4LiteralToUint32(rawHostOnly);
  if (rawIpv4 !== null) {
    const check = checkIpv4Uint32Safety(rawIpv4);
    if (!check.safe) {
      throw new SsrfError(
        `Blocked IPv4 literal (${rawHostOnly} -> ${uint32ToIpv4String(rawIpv4)}): ${check.reason}`,
        check.reason || 'BLOCKED_IP',
        'permanent'
      );
    }
  }

  let normalized;
  try {
    normalized = parseAndNormalizeUrl(rawUrl);
  } catch (err) {
    if (err instanceof UrlValidationError) {
      throw new SsrfError(err.message, err.code, 'permanent');
    }
    throw err;
  }

  const hostname = normalized.hostname;
  if (
    BLOCKED_HOSTNAMES.has(hostname) ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal')
  ) {
    throw new SsrfError(`Blocked hostname: ${hostname}`, 'BLOCKED_HOSTNAME', 'permanent');
  }

  const defaultPort = normalized.protocol === 'https:' ? 443 : 80;
  const port = normalized.port ? Number.parseInt(normalized.port, 10) : defaultPort;
  const allowedPorts = new Set([80, 443, ...(options.allowedPorts || [])]);
  if (!allowedPorts.has(port)) {
    throw new SsrfError(`Disallowed port: ${port}`, 'DISALLOWED_PORT', 'permanent');
  }

  // If hostname is already an IP literal
  const strippedHost = hostname.replace(/^\[|\]$/g, '');
  if (parseIpv4LiteralToUint32(strippedHost) !== null || parseIpv6Groups(strippedHost) !== null || strippedHost.includes('%')) {
    const ipCheck = checkIpSafety(strippedHost);
    if (!ipCheck.safe || !ipCheck.normalizedIp) {
      throw new SsrfError(`Blocked IP address ${hostname}: ${ipCheck.reason}`, ipCheck.reason || 'BLOCKED_IP', 'permanent');
    }
    return {
      normalizedUrl: normalized.normalizedUrl,
      hostname,
      pinnedIp: ipCheck.normalizedIp,
      family: strippedHost.includes(':') ? 6 : 4,
      port,
      protocol: normalized.protocol,
    };
  }

  // Resolve DNS and validate ALL returned records
  const resolver =
    options.resolver ||
    (async () => {
      const lookedUp = await dns.promises.lookup(hostname, { all: true });
      return lookedUp.map((r) => ({ address: r.address, family: (r.family === 6 ? 6 : 4) }));
    });

  const records = await resolver(hostname);
  if (!records || records.length === 0) {
    throw new SsrfError(`No DNS records resolved for ${hostname}`, 'DNS_NOT_FOUND', 'transient');
  }

  for (const rec of records) {
    const ipCheck = checkIpSafety(rec.address);
    if (!ipCheck.safe) {
      throw new SsrfError(
        `DNS resolution for ${hostname} returned blocked IP ${rec.address} (${ipCheck.reason})`,
        ipCheck.reason || 'DNS_REBIND_BLOCKED',
        'permanent'
      );
    }
  }

  const first = records[0];
  const firstCheck = checkIpSafety(first.address);
  return {
    normalizedUrl: normalized.normalizedUrl,
    hostname,
    pinnedIp: firstCheck.normalizedIp || first.address,
    family: first.family,
    port,
    protocol: normalized.protocol,
  };
}

const DEFAULT_ALLOWED_MIMES = [
  'text/html',
  'application/xhtml+xml',
  'application/xml',
  'text/xml',
  'application/rss+xml',
  'application/atom+xml',
  'application/Feed+json',
  'application/json',
  'text/plain',
  'application/pdf',
  'application/epub+zip',
];

/**
 * SSRF-safe fetcher with:
 * - DNS resolve-and-pin on initial request and every redirect hop
 * - Manual redirect handling up to maxRedirects (default 5) with loop detection
 * - Streaming byte cap and decompression bomb protection
 * - Strict MIME validation and malformed header rejection
 * - Permanent vs transient error classification
 */
export async function safeFetch(rawUrl, options = {}) {
  const maxRedirects = options.maxRedirects ?? 5;
  const maxBytes = options.maxBytes ?? 5 * 1024 * 1024; // 5 MB default
  const maxDecompressedBytes = options.maxDecompressedBytes ?? 10 * 1024 * 1024; // 10 MB default
  const timeoutMs = options.timeoutMs ?? 10_000;
  const allowedMimes = options.allowedMimePrefixes ?? DEFAULT_ALLOWED_MIMES;

  const visitedUrls = new Set();
  const redirectChain = [];
  let currentUrl = rawUrl;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const pinned = await validateAndPinDestination(currentUrl, {
      allowedPorts: options.allowedPorts,
      resolver: options.resolver,
    });

    if (visitedUrls.has(pinned.normalizedUrl)) {
      throw new SsrfError(`Redirect loop detected at ${pinned.normalizedUrl}`, 'REDIRECT_LOOP', 'permanent');
    }
    visitedUrls.add(pinned.normalizedUrl);

    const activeTransport = options.transport || ((req, signal) => new Promise((resolve, reject) => {
      const u = new URL(req.url);
      const isHttps = u.protocol === "https:";
      const mod = isHttps ? https : http;
      const clientReq = mod.request({
        host: req.pinnedIp,
        port: u.port ? Number(u.port) : (isHttps ? 443 : 80),
        path: u.pathname + u.search,
        method: "GET",
        headers: req.headers,
        servername: req.hostname,
        signal,
      }, (res) => {
        const hdrs = {};
        for (const [k, v] of Object.entries(res.headers)) {
          if (v !== undefined) hdrs[k] = Array.isArray(v) ? v.join(", ") : String(v);
        }
        resolve({ status: res.statusCode || 200, headers: hdrs, body: res });
      });
      clientReq.on("error", reject);
      clientReq.end();
    }));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new SsrfError('Fetch timed out', 'FETCH_TIMEOUT', 'transient')), timeoutMs);

    let rawRes;
    try {
      rawRes = await activeTransport(
        {
          url: pinned.normalizedUrl,
          pinnedIp: pinned.pinnedIp,
          hostname: pinned.hostname,
          headers: {
            Host: pinned.hostname,
            'User-Agent': 'SelfHostedReader/2.0',
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            ...(options.headers || {}),
          },
        },
        controller.signal
      );
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof SsrfError) throw err;
      if (controller.signal.aborted) {
        throw new SsrfError('Request timed out', 'FETCH_TIMEOUT', 'transient');
      }
      throw new SsrfError(
        err instanceof Error ? err.message : 'Network transport error',
        'NETWORK_ERROR',
        'transient'
      );
    } finally {
      clearTimeout(timer);
    }

    const destroyRawBody = () => {
      if (
        !Buffer.isBuffer(rawRes.body) &&
        rawRes.body &&
        typeof (rawRes.body).destroy === 'function'
      ) {
        (rawRes.body).destroy();
      }
    };

    // Validate response headers for malformed CRLF or control characters
    const normalizedHeaders = {};
    for (const [k, v] of Object.entries(rawRes.headers || {})) {
      if (/[\r\n\u0000]/.test(k) || /[\r\n\u0000]/.test(String(v))) {
        destroyRawBody();
        throw new SsrfError('Malformed response header containing control characters', 'MALFORMED_HEADERS', 'permanent');
      }
      normalizedHeaders[k.toLowerCase()] = String(v);
    }

    // Check redirect statuses (301, 302, 303, 307, 308)
    if ([301, 302, 303, 307, 308].includes(rawRes.status)) {
      destroyRawBody();
      if (hop === maxRedirects) {
        throw new SsrfError(`Maximum redirects (${maxRedirects}) exceeded`, 'MAX_REDIRECTS_EXCEEDED', 'permanent');
      }
      const location = normalizedHeaders['location'];
      if (!location) {
        throw new SsrfError('Redirect response missing Location header', 'INVALID_REDIRECT', 'permanent');
      }
      let nextUrl;
      try {
        nextUrl = new URL(location, pinned.normalizedUrl).toString();
      } catch {
        throw new SsrfError(`Malformed redirect Location: ${location}`, 'INVALID_REDIRECT', 'permanent');
      }
      redirectChain.push(pinned.normalizedUrl);
      currentUrl = nextUrl;
      continue;
    }

    // Check 304 Not Modified (for conditional GET in feeds)
    if (rawRes.status === 304) {
      destroyRawBody();
      return {
        finalUrl: pinned.normalizedUrl,
        pinnedIp: pinned.pinnedIp,
        status: 304,
        headers: normalizedHeaders,
        body: Buffer.alloc(0),
        contentType: '',
        redirectChain,
      };
    }

    // Classify HTTP error statuses
    if (rawRes.status >= 400) {
      destroyRawBody();
      const isTransient = rawRes.status === 408 || rawRes.status === 429 || rawRes.status >= 500;
      throw new SsrfError(
        `HTTP error status ${rawRes.status}`,
        `HTTP_${rawRes.status}`,
        isTransient ? 'transient' : 'permanent',
        rawRes.status
      );
    }

    // Check Content-Length header if present
    if (normalizedHeaders['content-length']) {
      const cl = Number.parseInt(normalizedHeaders['content-length'], 10);
      if (Number.isFinite(cl) && cl > maxBytes) {
        destroyRawBody();
        throw new SsrfError(
          `Response Content-Length (${cl}) exceeds limit (${maxBytes})`,
          'BODY_TOO_LARGE',
          'permanent'
        );
      }
    }

    // Check MIME type
    const rawContentType = normalizedHeaders['content-type'] || 'text/html';
    const mimeType = rawContentType.split(';')[0].trim().toLowerCase();
    const mimeAllowed = allowedMimes.some((prefix) => mimeType === prefix.toLowerCase() || mimeType.startsWith(prefix.toLowerCase()));
    if (!mimeAllowed) {
      destroyRawBody();
      throw new SsrfError(`Disallowed MIME type: ${mimeType}`, 'UNEXPECTED_MIME_TYPE', 'permanent');
    }

    // Read streaming body enforcing maxBytes
    const chunks = [];
    let totalBytes = 0;
    if (Buffer.isBuffer(rawRes.body)) {
      if (rawRes.body.length > maxBytes) {
        throw new SsrfError(`Response body (${rawRes.body.length} bytes) exceeds limit (${maxBytes})`, 'BODY_TOO_LARGE', 'permanent');
      }
      chunks.push(rawRes.body);
      totalBytes = rawRes.body.length;
    } else {
      for await (const chunk of rawRes.body) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        totalBytes += buf.length;
        if (totalBytes > maxBytes) {
          destroyRawBody();
          throw new SsrfError(`Streaming response exceeded byte cap (${maxBytes})`, 'BODY_TOO_LARGE', 'permanent');
        }
        chunks.push(buf);
      }
    }

    let finalBody = Buffer.concat(chunks, totalBytes);

    // Handle Content-Encoding with decompression bomb cap
    const encoding = (normalizedHeaders['content-encoding'] || '').toLowerCase();
    if (encoding === 'gzip' || encoding === 'deflate') {
      try {
        finalBody = zlib.unzipSync(finalBody, { maxOutputLength: maxDecompressedBytes });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('maxOutputLength') || msg.includes('Cannot create a Buffer')) {
          throw new SsrfError('Decompression bomb detected: decompressed size exceeds limit', 'DECOMPRESSION_BOMB', 'permanent');
        }
        throw new SsrfError(`Decompression failed: ${msg}`, 'INVALID_ENCODING', 'permanent');
      }
    } else if (encoding === 'br') {
      try {
        finalBody = zlib.brotliDecompressSync(finalBody, { maxOutputLength: maxDecompressedBytes });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('maxOutputLength') || msg.includes('Cannot create a Buffer')) {
          throw new SsrfError('Brotli decompression bomb detected', 'DECOMPRESSION_BOMB', 'permanent');
        }
        throw new SsrfError(`Brotli decompression failed: ${msg}`, 'INVALID_ENCODING', 'permanent');
      }
    }

    return {
      finalUrl: pinned.normalizedUrl,
      pinnedIp: pinned.pinnedIp,
      status: rawRes.status,
      headers: normalizedHeaders,
      body: finalBody,
      contentType: mimeType,
      redirectChain,
    };
  }

  throw new SsrfError(`Maximum redirects (${maxRedirects}) exceeded`, 'MAX_REDIRECTS_EXCEEDED', 'permanent');
}
