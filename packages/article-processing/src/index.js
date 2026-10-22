import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { parseAndNormalizeUrl } from '../../shared/src/url.js';

export const EXTRACTOR_NAME = 'contained-readability';
export const EXTRACTOR_VERSION = '2.1.0';

const ALLOWED_TAGS = new Set([
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'p', 'blockquote', 'pre', 'code',
  'ul', 'ol', 'li',
  'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'figure', 'figcaption', 'img', 'a',
  'strong', 'em', 'b', 'i', 'u', 's', 'sub', 'sup',
  'hr', 'br', 'span', 'div', 'article', 'section'
]);

const VOID_TAGS = new Set(['br', 'hr', 'img']);

const DROP_WITH_CONTENT_TAGS = [
  'script', 'style', 'iframe', 'object', 'embed', 'applet',
  'svg', 'math', 'form', 'noscript', 'template', 'head', 'nav', 'footer', 'aside'
];

export function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function decodeHtmlEntities(str) {
  return str
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      const cp = Number.parseInt(hex, 16);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
    })
    .replace(/&#([0-9]+);/g, (_, dec) => {
      const cp = Number.parseInt(dec, 10);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
    })
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&');
}

function sanitizeUrlAttr(rawVal, baseUrl, allowRelative = true) {
  const decoded = decodeHtmlEntities(rawVal).replace(/[\u0000-\u0020\u007f]+/g, '').trim();
  if (!decoded) return null;
  if (/^(javascript|vbscript|data|file|blob|ws|wss):/i.test(decoded)) {
    return null;
  }
  if (decoded.startsWith('#')) {
    return decoded;
  }
  try {
    const resolved = allowRelative && baseUrl ? new URL(decoded, baseUrl) : new URL(decoded);
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
      return null;
    }
    return resolved.toString();
  } catch {
    return null;
  }
}

export function sanitizeImageUrlAttr(rawVal, baseUrl) {
  const decoded = decodeHtmlEntities(rawVal).replace(/[\u0000-\u0020\u007f]+/g, '').trim();
  if (!decoded) return null;
  // Allow safe base64-encoded raster or SVG data URIs on <img>
  if (/^data:image\/(png|jpeg|jpg|gif|webp|svg\+xml);base64,[a-zA-Z0-9+/=]+$/i.test(decoded)) {
    return decoded;
  }
  // Allow local illustration routes served by the web app
  if (/^\/api\/illustrations\/[a-zA-Z0-9_-]+\.svg$/i.test(decoded)) {
    return decoded;
  }
  return sanitizeUrlAttr(decoded, baseUrl, true);
}

function extractFirstSrcFromSrcset(rawSrcset) {
  const decoded = decodeHtmlEntities(rawSrcset).trim();
  if (!decoded) return null;
  const firstCandidate = decoded.split(',')[0]?.trim();
  if (!firstCandidate) return null;
  const urlPart = firstCandidate.split(/\s+/)[0]?.trim();
  return urlPart || null;
}

/**
 * Server-side HTML sanitizer with an explicit allowlist of tags and attributes.
 * - Strips all dangerous tags (<script>, <svg>, <math>, <iframe>, <style>, <form>, etc.)
 * - Strips all event handlers (on*) and style/class/srcdoc/formaction attributes
 * - Rewrites relative URLs against baseUrl and promotes lazy-loaded image attributes (data-src, data-original, srcset)
 * - Enforces rel="noopener noreferrer" on links
 */
export function sanitizeHtml(dirtyHtml, baseUrl = 'https://example.com') {
  if (!dirtyHtml) return '';

  let cleaned = dirtyHtml.replace(/<!--[\s\S]*?-->/g, '');
  cleaned = cleaned.replace(/<!\[CDATA\[[\s\S]*?\]\]>/gi, '');
  cleaned = cleaned.replace(/<!DOCTYPE[^>]*>/gi, '');

  // Repeatedly strip tags whose entire body must be removed (handles nested/malformed tricks)
  let prev = '';
  while (prev !== cleaned) {
    prev = cleaned;
    for (const badTag of DROP_WITH_CONTENT_TAGS) {
      const rePaired = new RegExp(`<${badTag}\\b[^>]*>[\\s\\S]*?<\\/${badTag}\\b[^>]*>`, 'gi');
      cleaned = cleaned.replace(rePaired, '');
      if (badTag === 'script' || badTag === 'style') {
        const reUnclosedBody = new RegExp(`<${badTag}\\b[^>]*>[\\s\\S]*$`, 'gi');
        cleaned = cleaned.replace(reUnclosedBody, '');
      }
      const reUnclosed = new RegExp(`<\\/?${badTag}\\b[^>]*>`, 'gi');
      cleaned = cleaned.replace(reUnclosed, '');
    }
  }

  // Process remaining HTML tags via state-machine tokenizer (allowing '>' inside quoted attributes)
  const out = [];
  const tagRegex = /<\/?([a-zA-Z0-9:-]+)((?:"[^"]*"|'[^']*'|[^'">])*)>/g;
  let lastIndex = 0;
  let match;

  while ((match = tagRegex.exec(cleaned)) !== null) {
    const textChunk = cleaned.slice(lastIndex, match.index);
    if (textChunk) {
      out.push(escapeHtml(decodeHtmlEntities(textChunk)));
    }
    lastIndex = tagRegex.lastIndex;

    const fullMatch = match[0];
    const isClosing = fullMatch.startsWith('</');
    const tagName = match[1].toLowerCase();
    const attrString = match[2] || '';

    if (!ALLOWED_TAGS.has(tagName)) {
      continue;
    }

    if (isClosing) {
      if (!VOID_TAGS.has(tagName)) {
        out.push(`</${tagName}>`);
      }
      continue;
    }

    // Parse attributes safely
    const safeAttrs = [];
    let imgPrimarySrc = null;
    let imgFallbackSrc = null;
    let imgAlt = null;
    const attrRegex = /([a-zA-Z0-9_:-]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
    let attrMatch;
    while ((attrMatch = attrRegex.exec(attrString)) !== null) {
      const attrName = attrMatch[1].toLowerCase();
      const rawVal = attrMatch[2] ?? attrMatch[3] ?? attrMatch[4] ?? '';

      if (attrName.startsWith('on') || attrName === 'style' || attrName === 'srcdoc') {
        continue;
      }

      if (tagName === 'a' && attrName === 'href') {
        const safeHref = sanitizeUrlAttr(rawVal, baseUrl);
        if (safeHref) {
          safeAttrs.push(`href="${escapeHtml(safeHref)}"`);
        }
      } else if (tagName === 'img' && attrName === 'src') {
        const safeSrc = sanitizeImageUrlAttr(rawVal, baseUrl);
        if (safeSrc) {
          imgPrimarySrc = safeSrc;
        }
      } else if (
        tagName === 'img' &&
        (attrName === 'data-src' || attrName === 'data-original' || attrName === 'data-lazy-src')
      ) {
        const safeLazy = sanitizeImageUrlAttr(rawVal, baseUrl);
        if (safeLazy && !imgFallbackSrc) {
          imgFallbackSrc = safeLazy;
        }
      } else if (tagName === 'img' && (attrName === 'srcset' || attrName === 'data-srcset')) {
        const firstSrc = extractFirstSrcFromSrcset(rawVal);
        if (firstSrc) {
          const safeSrcsetUrl = sanitizeImageUrlAttr(firstSrc, baseUrl);
          if (safeSrcsetUrl && !imgFallbackSrc) {
            imgFallbackSrc = safeSrcsetUrl;
          }
        }
      } else if (tagName === 'img' && attrName === 'alt') {
        imgAlt = escapeHtml(decodeHtmlEntities(rawVal));
      } else if (tagName === 'img' && (attrName === 'width' || attrName === 'height')) {
        const dim = Number.parseInt(rawVal, 10);
        if (dim > 1 && dim <= 4096) {
          safeAttrs.push(`${attrName}="${dim}"`);
        }
      } else if ((attrName === 'title' || attrName === 'id') && rawVal) {
        const cleanId = decodeHtmlEntities(rawVal).replace(/[^a-zA-Z0-9_\-:. ]/g, '');
        if (cleanId) {
          safeAttrs.push(`${attrName}="${escapeHtml(cleanId)}"`);
        }
      } else if ((tagName === 'td' || tagName === 'th') && (attrName === 'colspan' || attrName === 'rowspan')) {
        const num = Number.parseInt(rawVal, 10);
        if (num > 0 && num <= 20) {
          safeAttrs.push(`${attrName}="${num}"`);
        }
      }
    }

    if (tagName === 'a') {
      safeAttrs.push('rel="noopener noreferrer"');
      safeAttrs.push('target="_blank"');
    }

    if (tagName === 'img') {
      const resolvedSrc = imgPrimarySrc || imgFallbackSrc;
      if (!resolvedSrc) {
        // Drop img without valid src or fallback lazy src
        continue;
      }
      safeAttrs.unshift(`src="${escapeHtml(resolvedSrc)}"`);
      if (imgAlt !== null) {
        safeAttrs.push(`alt="${imgAlt}"`);
      }
      safeAttrs.push('loading="lazy"');
      safeAttrs.push('decoding="async"');
    }

    const attrPart = safeAttrs.length > 0 ? ` ${safeAttrs.join(' ')}` : '';
    out.push(`<${tagName}${attrPart}>`);
  }

  const tail = cleaned.slice(lastIndex);
  if (tail) {
    out.push(escapeHtml(decodeHtmlEntities(tail)));
  }

  return out.join('').trim();
}

export function extractPlainText(html) {
  return decodeHtmlEntities(
    html
      .replace(/<(script|style|head|svg|math)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<\/(p|div|h[1-6]|li|tr|blockquote|pre|section|article)>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
}

export function computeReadingTimeMinutes(plainText) {
  const words = plainText.trim().split(/\s+/).filter(Boolean).length;
  if (words === 0) return 1;
  return Math.max(1, Math.ceil(words / 200));
}

function getMetaContent(html, namesOrProps) {
  for (const name of namesOrProps) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re1 = new RegExp(
      `<meta[^>]+(?:name|property)=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>`,
      'i'
    );
    const m1 = re1.exec(html);
    if (m1 && m1[1].trim()) return decodeHtmlEntities(m1[1].trim());

    const re2 = new RegExp(
      `<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["']${escaped}["'][^>]*>`,
      'i'
    );
    const m2 = re2.exec(html);
    if (m2 && m2[1].trim()) return decodeHtmlEntities(m2[1].trim());
  }
  return null;
}

/**
 * Full extraction + URL rewriting + sanitization + derived field computation pipeline (Section 8.3).
 */
export function extractArticle(rawHtml, pageUrl) {
  const norm = parseAndNormalizeUrl(pageUrl);
  const baseUrl = norm.normalizedUrl;

  // JSON-LD metadata extraction if present
  let jsonLdTitle = null;
  let jsonLdAuthor = null;
  let jsonLdDate = null;
  let jsonLdPublisher = null;
  let jsonLdDesc = null;
  let jsonLdImage = null;

  const ldMatch = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i.exec(rawHtml);
  if (ldMatch) {
    try {
      const parsedLd = JSON.parse(ldMatch[1].trim());
      const obj = Array.isArray(parsedLd) ? parsedLd[0] : parsedLd;
      if (obj && typeof obj === 'object') {
        if (typeof obj.headline === 'string') jsonLdTitle = obj.headline;
        if (typeof obj.name === 'string' && !jsonLdTitle) jsonLdTitle = obj.name;
        if (typeof obj.description === 'string') jsonLdDesc = obj.description;
        if (typeof obj.datePublished === 'string') jsonLdDate = obj.datePublished;
        if (typeof obj.author === 'string') jsonLdAuthor = obj.author;
        else if (obj.author && typeof obj.author.name === 'string') jsonLdAuthor = obj.author.name;
        if (obj.publisher && typeof obj.publisher.name === 'string') jsonLdPublisher = obj.publisher.name;
        if (typeof obj.image === 'string') jsonLdImage = obj.image;
        else if (obj.image && typeof obj.image.url === 'string') jsonLdImage = obj.image.url;
      }
    } catch {
      // Ignore malformed JSON-LD
    }
  }

  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(rawHtml);
  const rawTitle =
    getMetaContent(rawHtml, ['og:title', 'twitter:title']) ||
    jsonLdTitle ||
    (titleMatch ? decodeHtmlEntities(titleMatch[1].trim()) : '') ||
    norm.hostname;

  const author =
    getMetaContent(rawHtml, ['author', 'article:author', 'dc.creator']) ||
    jsonLdAuthor ||
    null;

  const publisher =
    getMetaContent(rawHtml, ['og:site_name', 'application-name']) ||
    jsonLdPublisher ||
    norm.domain;

  const description =
    getMetaContent(rawHtml, ['og:description', 'description', 'twitter:description']) ||
    jsonLdDesc ||
    null;

  const rawCanonical =
    /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i.exec(rawHtml)?.[1] ||
    /<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["']/i.exec(rawHtml)?.[1] ||
    getMetaContent(rawHtml, ['og:url']) ||
    null;

  let canonicalUrl = null;
  if (rawCanonical) {
    try {
      canonicalUrl = parseAndNormalizeUrl(new URL(rawCanonical, baseUrl).toString()).normalizedUrl;
    } catch {
      canonicalUrl = null;
    }
  }

  const rawPublished =
    getMetaContent(rawHtml, ['article:published_time', 'datePublished', 'pubdate', 'date']) ||
    /<time[^>]+datetime=["']([^"']+)["']/i.exec(rawHtml)?.[1] ||
    jsonLdDate ||
    null;

  let publishedAt = null;
  if (rawPublished && !Number.isNaN(Date.parse(rawPublished))) {
    publishedAt = new Date(rawPublished).toISOString();
  }

  const rawImage = getMetaContent(rawHtml, ['og:image', 'twitter:image', 'twitter:image:src']) || jsonLdImage;
  let featuredImage = rawImage ? sanitizeImageUrlAttr(rawImage, baseUrl) : null;

  const langMatch = /<html[^>]+lang=["']([a-zA-Z-]+)["']/i.exec(rawHtml);
  const language = langMatch ? langMatch[1].toLowerCase() : 'en';

  // Detect non-article pages (login walls, paywall/captcha shells, app shells)
  const isNonArticleMarker =
    /<meta[^>]+name=["']page-type["'][^>]+content=["'](login|app-shell|paywall|captcha)["']/i.test(rawHtml) ||
    /<form[^>]+(?:login|signin|password|auth)/i.test(rawHtml) && !/<article\b/i.test(rawHtml);

  // Locate primary body container: <article>, <main>, or <body>
  const articleMatch = /<article\b[^>]*>([\s\S]*?)<\/article>/i.exec(rawHtml);
  const mainMatch = /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(rawHtml);
  const bodyMatch = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(rawHtml);

  const candidateHtml = articleMatch
    ? articleMatch[1]
    : mainMatch
      ? mainMatch[1]
      : bodyMatch
        ? bodyMatch[1]
        : rawHtml;

  const sanitizedHtml = sanitizeHtml(candidateHtml, baseUrl);
  const plainText = extractPlainText(sanitizedHtml);

  // Fallback featuredImage to the first valid <img src="..."> in sanitizedHtml if og:image was missing
  if (!featuredImage) {
    const firstImgMatch = /<img[^>]+src="([^"]+)"/i.exec(sanitizedHtml);
    if (firstImgMatch && firstImgMatch[1]) {
      featuredImage = decodeHtmlEntities(firstImgMatch[1]);
    }
  }

  // Extract headings and ensure each heading in sanitizedHtml has a deterministic id for TOC
  const toc = [];
  let headingCounter = 0;
  const htmlWithHeadingIds = sanitizedHtml.replace(
    /<(h[1-6])(\s[^>]*)?>([\s\S]*?)<\/\1>/gi,
    (full, tag, attrs = '', inner) => {
      headingCounter++;
      const level = Number.parseInt(tag[1], 10);
      const text = extractPlainText(inner);
      const slug =
        text
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '') || `section-${headingCounter}`;
      const id = `${slug}-${headingCounter}`;
      toc.push({ id, text, level });
      const cleanAttrs = (attrs || '').replace(/\sid="[^"]*"/i, '');
      return `<${tag.toLowerCase()} id="${id}"${cleanAttrs}>${inner}</${tag.toLowerCase()}>`;
    }
  );

  // Extract outbound http(s) URLs from sanitizedHtml
  const outboundSet = new Set();
  const hrefRe = /<a[^>]+href="([^"]+)"/gi;
  let hm;
  while ((hm = hrefRe.exec(htmlWithHeadingIds)) !== null) {
    try {
      const normHref = parseAndNormalizeUrl(hm[1]).normalizedUrl;
      if (normHref !== baseUrl) {
        outboundSet.add(normHref);
      }
    } catch {
      // ignore invalid
    }
  }

  const wordCount = plainText.split(/\s+/).filter(Boolean).length;
  const isPartial = isNonArticleMarker || (wordCount < 15 && !articleMatch);

  const finalHtml = isPartial
    ? `<p>${escapeHtml(description || rawTitle)}</p>`
    : htmlWithHeadingIds;
  const finalPlain = isPartial ? (description || rawTitle) : plainText;
  const contentHash = crypto.createHash('sha256').update(finalHtml).digest('hex');

  return {
    status: isPartial ? 'partial' : 'ready',
    title: rawTitle,
    author,
    publisher,
    domain: norm.domain,
    canonicalUrl,
    publishedAt,
    description,
    featuredImage,
    language,
    readingTimeMinutes: computeReadingTimeMinutes(finalPlain),
    sanitizedHtml: finalHtml,
    plainText: finalPlain,
    toc: isPartial ? [] : toc,
    outboundUrls: Array.from(outboundSet),
    contentHash,
    extractorName: EXTRACTOR_NAME,
    extractorVersion: EXTRACTOR_VERSION,
  };
}

export function discoverFeedsFromHtml(html, baseUrl) {
  const feeds = [];
  const linkRe = /<link\b([^>]+)>/gi;
  let m;
  while ((m = linkRe.exec(html)) !== null) {
    const attrs = m[1];
    if (!/rel=["'][^"']*alternate[^"']*["']/i.test(attrs)) continue;
    const typeMatch = /type=["']([^"']+)["']/i.exec(attrs);
    if (!typeMatch) continue;
    const typeVal = typeMatch[1].toLowerCase();
    if (!typeVal.includes('rss') && !typeVal.includes('atom') && !typeVal.includes('xml')) continue;
    const hrefMatch = /href=["']([^"']+)["']/i.exec(attrs);
    if (!hrefMatch) continue;
    try {
      const resolved = parseAndNormalizeUrl(new URL(hrefMatch[1], baseUrl).toString()).normalizedUrl;
      const titleMatch = /title=["']([^"']+)["']/i.exec(attrs);
      feeds.push({
        url: resolved,
        title: titleMatch ? decodeHtmlEntities(titleMatch[1]) : resolved,
        type: typeVal.includes('atom') ? 'atom' : 'rss',
      });
    } catch {
      // ignore invalid
    }
  }
  return feeds;
}

function extractXmlTag(xml, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = re.exec(xml);
  if (!m) return null;
  const raw = m[1].trim();
  const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/i.exec(raw);
  return decodeHtmlEntities(cdata ? cdata[1].trim() : raw);
}

/**
 * Hostile-safe RSS 2.0 and Atom 1.0 parser with XXE / DOCTYPE / ENTITY rejection (Section 5.1 & 8.5).
 */
export function parseFeedXml(rawXml, feedUrl) {
  if (!rawXml || typeof rawXml !== 'string') {
    throw new Error('Feed XML must be a non-empty string');
  }
  if (rawXml.length > 5 * 1024 * 1024) {
    throw new Error('Feed XML exceeds maximum size');
  }
  if (/<!ENTITY\b/i.test(rawXml) || /<!DOCTYPE[^>]+SYSTEM/i.test(rawXml)) {
    throw new Error('XML external entities (XXE) and DTD ENTITY declarations are forbidden');
  }

  const baseNorm = parseAndNormalizeUrl(feedUrl).normalizedUrl;
  const isAtom = /<feed\b/i.test(rawXml);
  const isRss = /<rss\b|<rdf:RDF\b|<channel\b/i.test(rawXml);
  if (!isAtom && !isRss) {
    throw new Error('Unrecognized feed format: expected RSS or Atom XML');
  }

  // Strip item/entry blocks before reading feed-level metadata
  const headerXml = rawXml.replace(/<(item|entry)\b[\s\S]*?<\/\1>/gi, '');
  const feedTitle = extractXmlTag(headerXml, 'title') || baseNorm;
  const feedDesc = extractXmlTag(headerXml, 'description') || extractXmlTag(headerXml, 'subtitle') || null;
  const siteLinkMatch =
    /<link[^>]+href=["']([^"']+)["']/i.exec(headerXml)?.[1] ||
    extractXmlTag(headerXml, 'link') ||
    null;

  const entries = [];
  const blockRe = /<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let bm;
  while ((bm = blockRe.exec(rawXml)) !== null) {
    const block = bm[2];
    const title = extractXmlTag(block, 'title') || 'Untitled Entry';
    const guid = extractXmlTag(block, 'guid') || extractXmlTag(block, 'id') || null;
    const rawLink =
      /<link[^>]+href=["']([^"']+)["']/i.exec(block)?.[1] ||
      extractXmlTag(block, 'link') ||
      baseNorm;
    let normalizedEntryUrl = baseNorm;
    try {
      normalizedEntryUrl = parseAndNormalizeUrl(new URL(rawLink, baseNorm).toString()).normalizedUrl;
    } catch {
      normalizedEntryUrl = baseNorm;
    }

    const author =
      extractXmlTag(block, 'dc:creator') ||
      extractXmlTag(block, 'name') ||
      extractXmlTag(block, 'author') ||
      null;

    const rawPub =
      extractXmlTag(block, 'pubDate') ||
      extractXmlTag(block, 'published') ||
      extractXmlTag(block, 'updated') ||
      null;
    const publishedAt = rawPub && !Number.isNaN(Date.parse(rawPub)) ? new Date(rawPub).toISOString() : null;

    const rawContent =
      extractXmlTag(block, 'content:encoded') ||
      extractXmlTag(block, 'content') ||
      extractXmlTag(block, 'description') ||
      extractXmlTag(block, 'summary') ||
      '';

    const contentHtml = sanitizeHtml(rawContent, normalizedEntryUrl);
    const summary = extractPlainText(contentHtml).slice(0, 280);

    // Stable deduplication key: GUID if present, otherwise normalized link, otherwise hash of title+date
    const dedupKey = guid
      ? `guid:${guid.trim()}`
      : normalizedEntryUrl !== baseNorm
        ? `url:${normalizedEntryUrl}`
        : `hash:${crypto.createHash('sha256').update(`${title}|${publishedAt || ''}`).digest('hex')}`;

    entries.push({
      guid,
      dedupKey,
      url: normalizedEntryUrl,
      title,
      author,
      summary,
      contentHtml: contentHtml || `<p>${escapeHtml(title)}</p>`,
      publishedAt,
    });
  }

  return {
    title: feedTitle,
    description: feedDesc,
    siteUrl: siteLinkMatch,
    entries,
  };
}

/**
 * Validates and extracts text from a PDF buffer (Section 8.4).
 * Checks %PDF- magic bytes, enforces max size and page cap, extracts text streams,
 * and identifies scanned PDFs with no text layer.
 */
export function parsePdfBuffer(
  buffer,
  filename = 'document.pdf',
  options = {}
) {
  const maxBytes = options.maxBytes ?? 50 * 1024 * 1024;
  const maxPages = options.maxPages ?? 500;

  if (buffer.length > maxBytes) {
    throw new Error(`PDF exceeds size limit of ${maxBytes} bytes`);
  }
  if (buffer.length < 8 || buffer.subarray(0, 5).toString('ascii') !== '%PDF-') {
    throw new Error('Invalid PDF magic bytes: expected %PDF- header');
  }

  const rawStr = buffer.toString('latin1');
  if (!rawStr.includes('%%EOF')) {
    throw new Error('Malformed PDF: missing %%EOF trailer');
  }

  // Extract page objects or text blocks between BT ... ET
  const pageMatches = rawStr.match(/\/Type\s*\/Page\b/g);
  const declaredPageCount = pageMatches ? pageMatches.length : 1;
  if (declaredPageCount > maxPages) {
    throw new Error(`PDF page count (${declaredPageCount}) exceeds limit (${maxPages})`);
  }

  const pages = [];
  const btBlocks = Array.from(rawStr.matchAll(/BT\s+([\s\S]*?)\s+ET/g));

  if (btBlocks.length > 0) {
    for (let i = 0; i < btBlocks.length; i++) {
      const content = btBlocks[i][1];
      const strings = [];
      for (const sm of content.matchAll(/\(([^()\\]*(?:\\.[^()\\]*)*)\)\s*Tj/g)) {
        strings.push(sm[1].replace(/\\([()\\])/g, '$1'));
      }
      for (const tjArr of content.matchAll(/\[([\s\S]*?)\]\s*TJ/g)) {
        for (const sm of tjArr[1].matchAll(/\(([^()\\]*(?:\\.[^()\\]*)*)\)/g)) {
          strings.push(sm[1].replace(/\\([()\\])/g, '$1'));
        }
      }
      const pageText = strings.join(' ').trim();
      pages.push({
        pageNumber: i + 1,
        text: pageText,
      });
    }
  } else {
    for (let p = 1; p <= declaredPageCount; p++) {
      pages.push({ pageNumber: p, text: '' });
    }
  }

  const fullText = pages.map((p) => p.text).filter(Boolean).join('\n\n').trim();
  const hasTextLayer = fullText.length > 0;
  const ocrStatus = hasTextLayer ? 'none' : 'no_text_layer';

  const titleMatch = /\/Title\s*\(([^)]+)\)/.exec(rawStr);
  const title = titleMatch ? titleMatch[1].trim() : filename.replace(/\.pdf$/i, '');

  const sanitizedHtml = hasTextLayer
    ? pages
        .map(
          (p) =>
            `<section id="pdf-page-${p.pageNumber}"><h2>Page ${p.pageNumber}</h2><p>${escapeHtml(p.text)}</p></section>`
        )
        .join('\n')
    : `<section id="pdf-page-1"><p>Scanned PDF (no text layer detected).</p></section>`;

  return {
    title,
    pageCount: Math.max(declaredPageCount, pages.length),
    pages,
    plainText: fullText,
    sanitizedHtml,
    ocrStatus,
  };
}

/**
 * Creates a standard uncompressed/deflate ZIP buffer for testing & packaging EPUBs or backups.
 */
export function createZipArchive(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const dataBuf = entry.data;
    const crc = zlib.crc32(dataBuf);

    const localHeader = Buffer.alloc(30 + nameBuf.length);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(0, 6); // flags
    localHeader.writeUInt16LE(0, 8); // method 0 = store
    localHeader.writeUInt16LE(0, 10); // mod time
    localHeader.writeUInt16LE(0, 12); // mod date
    localHeader.writeUInt32LE(crc >>> 0, 14);
    localHeader.writeUInt32LE(dataBuf.length, 18);
    localHeader.writeUInt32LE(dataBuf.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);
    nameBuf.copy(localHeader, 30);

    localParts.push(localHeader, dataBuf);

    const centralHeader = Buffer.alloc(46 + nameBuf.length);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(crc >>> 0, 16);
    centralHeader.writeUInt32LE(dataBuf.length, 20);
    centralHeader.writeUInt32LE(dataBuf.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    nameBuf.copy(centralHeader, 46);

    centralParts.push(centralHeader);
    offset += localHeader.length + dataBuf.length;
  }

  const centralBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralBuf, eocd]);
}

/**
 * Extracts a ZIP archive with strict zip-slip, entry-count, and expanded-size (zip-bomb) limits.
 */
export function extractZipSafely(
  buffer,
  options = {}
) {
  const maxEntries = options.maxEntries ?? 250;
  const maxExpandedBytes = options.maxExpandedBytes ?? 25 * 1024 * 1024;

  if (buffer.length < 4 || buffer.readUInt32LE(0) !== 0x04034b50) {
    throw new Error('Invalid ZIP/EPUB magic bytes: expected PK\\x03\\x04');
  }

  const files = new Map();
  let pos = 0;
  let totalExpanded = 0;
  let entryCount = 0;

  while (pos + 4 <= buffer.length) {
    const sig = buffer.readUInt32LE(pos);
    if (sig !== 0x04034b50) {
      break;
    }
    entryCount++;
    if (entryCount > maxEntries) {
      throw new Error(`Archive entry count exceeds maximum allowed (${maxEntries})`);
    }
    if (pos + 30 > buffer.length) {
      throw new Error('Truncated ZIP local file header');
    }

    const method = buffer.readUInt16LE(pos + 8);
    const compSize = buffer.readUInt32LE(pos + 18);
    const uncompSize = buffer.readUInt32LE(pos + 22);
    const nameLen = buffer.readUInt16LE(pos + 26);
    const extraLen = buffer.readUInt16LE(pos + 28);

    const dataStart = pos + 30 + nameLen + extraLen;
    const dataEnd = dataStart + compSize;
    if (dataEnd > buffer.length) {
      throw new Error('Truncated ZIP entry payload');
    }

    const rawName = buffer.subarray(pos + 30, pos + 30 + nameLen).toString('utf8');
    // Zip-slip check
    if (
      rawName.startsWith('/') ||
      rawName.startsWith('\\') ||
      rawName.includes('..') ||
      rawName.includes('\u0000') ||
      /^[a-zA-Z]:/.test(rawName)
    ) {
      throw new Error(`Zip-slip path traversal detected in archive entry: ${rawName}`);
    }

    if (uncompSize > maxExpandedBytes || totalExpanded + uncompSize > maxExpandedBytes) {
      throw new Error('Zip-bomb detected: expanded size exceeds limit');
    }

    const rawPayload = buffer.subarray(dataStart, dataEnd);
    let expanded;
    if (method === 0) {
      expanded = Buffer.from(rawPayload);
    } else if (method === 8) {
      expanded = zlib.inflateRawSync(rawPayload, { maxOutputLength: maxExpandedBytes - totalExpanded });
    } else {
      throw new Error(`Unsupported ZIP compression method: ${method}`);
    }

    totalExpanded += expanded.length;
    if (totalExpanded > maxExpandedBytes) {
      throw new Error('Zip-bomb detected: total expanded bytes exceeded limit');
    }

    files.set(rawName, expanded);
    pos = dataEnd;
  }

  return files;
}

export function parseEpubBuffer(
  buffer,
  options = {}
) {
  const entries = extractZipSafely(buffer, options);

  const containerXml = entries.get('META-INF/container.xml')?.toString('utf8');
  if (!containerXml) {
    throw new Error('Invalid EPUB: missing META-INF/container.xml');
  }
  const opfPathMatch = /full-path=["']([^"']+)["']/i.exec(containerXml);
  if (!opfPathMatch) {
    throw new Error('Invalid EPUB: missing rootfile full-path in container.xml');
  }

  const opfPath = opfPathMatch[1];
  const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
  const opfXml = entries.get(opfPath)?.toString('utf8');
  if (!opfXml) {
    throw new Error(`Invalid EPUB: missing OPF package file at ${opfPath}`);
  }

  const title = extractXmlTag(opfXml, 'dc:title') || extractXmlTag(opfXml, 'title') || 'Untitled EPUB';
  const author = extractXmlTag(opfXml, 'dc:creator') || extractXmlTag(opfXml, 'creator') || null;

  // Map manifest item id -> href
  const manifest = new Map();
  for (const im of opfXml.matchAll(/<item\b([^>]+)>/gi)) {
    const attrs = im[1];
    const id = /id=["']([^"']+)["']/i.exec(attrs)?.[1];
    const href = /href=["']([^"']+)["']/i.exec(attrs)?.[1];
    if (id && href) {
      manifest.set(id, opfDir + href);
    }
  }

  const spine = [];
  const toc = [];
  let idx = 0;

  for (const sm of opfXml.matchAll(/<itemref\b([^>]+)>/gi)) {
    const idref = /idref=["']([^"']+)["']/i.exec(sm[1])?.[1];
    if (!idref) continue;
    const href = manifest.get(idref);
    if (!href) continue;
    const chapterBuf = entries.get(href);
    if (!chapterBuf) continue;
    idx++;
    const rawChapter = chapterBuf.toString('utf8');
    const chTitle =
      extractXmlTag(rawChapter, 'title') ||
      extractXmlTag(rawChapter, 'h1') ||
      extractXmlTag(rawChapter, 'h2') ||
      `Chapter ${idx}`;
    const sanitized = sanitizeHtml(rawChapter, 'https://epub.local/');
    const plain = extractPlainText(sanitized);
    const spineId = `spine-${idx}`;
    spine.push({
      id: spineId,
      href,
      title: chTitle,
      sanitized_html: sanitized,
      plain_text: plain,
    });
    toc.push({
      id: spineId,
      text: chTitle,
      level: 1,
    });
  }

  if (spine.length === 0) {
    throw new Error('Invalid EPUB: no readable spine chapters found');
  }

  return {
    title,
    author,
    spine,
    toc,
    sanitizedHtml: spine.map((s) => `<section id="${s.id}"><h2>${escapeHtml(s.title)}</h2>${s.sanitized_html}</section>`).join('\n'),
    plainText: spine.map((s) => s.plain_text).join('\n\n'),
  };
}
