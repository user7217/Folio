# Article & Document Processing Pipeline

## 1. Web Article Normalization Pipeline

Every captured URL is processed in strict order:
1. **Validate & Normalize (`parseAndNormalizeUrl`)**: Lowercases scheme and host, strips default ports (`:80`, `:443`) and fragments, removes tracking parameters (`utm_*`, `fbclid`, `gclid`, etc.), and sorts remaining query parameters.
2. **SSRF-Safe Fetch (`safeFetch`)**: Resolves DNS, validates all returned IPs against blocked IPv4/IPv6 ranges, pins the connection to the validated IP, revalidates up to 5 redirects, and enforces streaming byte and decompression caps.
3. **Metadata & Body Extraction (`extractArticle`)**: Extracts OpenGraph, JSON-LD, `<meta>`, canonical URL, publication date, author, language, and main `<article>`/`<main>` body. Non-article login walls or empty app shells become `partial` with metadata only.
4. **URL Rewriting & Allowlist Sanitization (`sanitizeHtml`)**: Rewrites relative `href`/`src` attributes against the final base URL, removes dangerous tags/attributes, and adds `rel="noopener noreferrer"`.
5. **Derived Fields & Revisions**: Computes TOC headings, reading time (`ceil(words / 200)`), outbound links, and SHA-256 `content_hash`. Creates a new immutable `ItemRevision`, re-anchors existing highlights, updates embeddings, and refreshes the search index.

## 2. PDF & EPUB Processing

- **PDF (`parsePdfBuffer`)**: Verifies `%PDF-` magic bytes and `%%EOF` trailer, enforces size (50 MB) and page caps (500 pages), extracts page-level text streams, and marks scanned PDFs without text layers as `ocr_status: "no_text_layer"`.
- **EPUB (`parseEpubBuffer`)**: Verifies `PK\x03\x04` magic bytes, enforces zip-slip and zip-bomb caps, parses `META-INF/container.xml` and OPF manifest/spine, and sanitizes every chapter.
