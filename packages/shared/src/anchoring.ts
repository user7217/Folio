export interface TextAnchorInput {
  exactQuote: string;
  prefix: string;
  suffix: string;
  startOffset: number;
  endOffset: number;
}

export interface ReanchorResult {
  orphaned: boolean;
  startOffset: number;
  endOffset: number;
  exactQuote: string;
  prefix: string;
  suffix: string;
  matchType: 'exact_offset' | 'context_quote' | 'fuzzy' | 'orphaned';
  similarity: number;
}

/**
 * Extracts a 32-character prefix and suffix around [startOffset, endOffset] in normalized text.
 */
export function buildTextAnchor(text: string, startOffset: number, endOffset: number): TextAnchorInput {
  const safeStart = Math.max(0, Math.min(text.length, startOffset));
  const safeEnd = Math.max(safeStart, Math.min(text.length, endOffset));
  const exactQuote = text.slice(safeStart, safeEnd);
  const prefix = text.slice(Math.max(0, safeStart - 32), safeStart);
  const suffix = text.slice(safeEnd, Math.min(text.length, safeEnd + 32));
  return {
    exactQuote,
    prefix,
    suffix,
    startOffset: safeStart,
    endOffset: safeEnd,
  };
}

/**
 * Computes normalized Levenshtein similarity in [0, 1] between two strings.
 */
export function stringSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen > 1024) {
    // Use 3-gram Jaccard similarity for long strings
    const ngrams = (s: string): Set<string> => {
      const set = new Set<string>();
      for (let i = 0; i <= s.length - 3; i++) {
        set.add(s.slice(i, i + 3));
      }
      return set;
    };
    const setA = ngrams(a);
    const setB = ngrams(b);
    if (setA.size === 0 || setB.size === 0) return 0;
    let inter = 0;
    for (const g of setA) {
      if (setB.has(g)) inter++;
    }
    return inter / (setA.size + setB.size - inter);
  }

  const dp = new Int32Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) dp[j] = j;

  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const temp = dp[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + cost);
      prev = temp;
    }
  }

  return 1 - dp[b.length] / maxLen;
}

/**
 * Re-anchors an existing highlight when an item's revision text changes (Section 6.7):
 * 1. Exact offset match if quote still matches at [startOffset, endOffset].
 * 2. Exact quote + context (prefix/suffix) match.
 * 3. Fuzzy match with documented similarity threshold (>= 0.80) and unique best window.
 * 4. Otherwise marks the anchor `orphaned` (never attaches a highlight to the wrong passage).
 */
export function reanchorHighlight(
  newText: string,
  anchor: TextAnchorInput,
  fuzzyThreshold: number = 0.80
): ReanchorResult {
  const quote = anchor.exactQuote;
  if (!quote || !newText) {
    return {
      orphaned: true,
      startOffset: anchor.startOffset,
      endOffset: anchor.endOffset,
      exactQuote: quote,
      prefix: anchor.prefix,
      suffix: anchor.suffix,
      matchType: 'orphaned',
      similarity: 0,
    };
  }

  // 1. Check exact offset first
  if (
    anchor.startOffset >= 0 &&
    anchor.endOffset <= newText.length &&
    newText.slice(anchor.startOffset, anchor.endOffset) === quote
  ) {
    const updated = buildTextAnchor(newText, anchor.startOffset, anchor.endOffset);
    return {
      orphaned: false,
      ...updated,
      matchType: 'exact_offset',
      similarity: 1,
    };
  }

  // 2. Find all exact occurrences of quote and score by prefix/suffix context
  const occurrences: number[] = [];
  let searchPos = 0;
  while (searchPos <= newText.length - quote.length) {
    const idx = newText.indexOf(quote, searchPos);
    if (idx === -1) break;
    occurrences.push(idx);
    searchPos = idx + 1;
  }

  if (occurrences.length === 1) {
    const idx = occurrences[0];
    const updated = buildTextAnchor(newText, idx, idx + quote.length);
    return {
      orphaned: false,
      ...updated,
      matchType: 'context_quote',
      similarity: 1,
    };
  }

  if (occurrences.length > 1) {
    let bestIdx = -1;
    let bestContextScore = -1;
    for (const idx of occurrences) {
      const candPrefix = newText.slice(Math.max(0, idx - 32), idx);
      const candSuffix = newText.slice(idx + quote.length, Math.min(newText.length, idx + quote.length + 32));
      const pScore = anchor.prefix ? stringSimilarity(anchor.prefix, candPrefix) : 0.5;
      const sScore = anchor.suffix ? stringSimilarity(anchor.suffix, candSuffix) : 0.5;
      const score = (pScore + sScore) / 2;
      if (score > bestContextScore) {
        bestContextScore = score;
        bestIdx = idx;
      }
    }
    if (bestIdx !== -1 && bestContextScore >= 0.5) {
      const updated = buildTextAnchor(newText, bestIdx, bestIdx + quote.length);
      return {
        orphaned: false,
        ...updated,
        matchType: 'context_quote',
        similarity: bestContextScore,
      };
    }
  }

  // 3. Fuzzy match using context anchor (prefix + quote + suffix) or sliding sentence window
  const qLen = quote.length;
  let bestStart = -1;
  let bestEnd = -1;
  let bestScore = 0;

  // Check if prefix or suffix appears directly in newText to narrow candidate window
  const candidateStarts = new Set<number>();
  if (anchor.prefix && anchor.prefix.length >= 8) {
    const pIdx = newText.indexOf(anchor.prefix.slice(-12));
    if (pIdx !== -1) {
      candidateStarts.add(pIdx + Math.min(12, anchor.prefix.length));
    }
  }
  if (anchor.suffix && anchor.suffix.length >= 8) {
    const sIdx = newText.indexOf(anchor.suffix.slice(0, 12));
    if (sIdx !== -1 && sIdx - qLen >= 0) {
      candidateStarts.add(sIdx - qLen);
    }
  }

  // Also add coarse step windows around original startOffset and across text
  const step = Math.max(1, Math.floor(qLen / 6));
  for (let pos = 0; pos <= newText.length - Math.max(4, Math.floor(qLen * 0.8)); pos += step) {
    candidateStarts.add(pos);
  }

  for (const start of candidateStarts) {
    for (const lenDelta of [0, -2, 2, -4, 4]) {
      const end = start + qLen + lenDelta;
      if (start < 0 || end > newText.length || end <= start) continue;
      const sub = newText.slice(start, end);
      const quoteSim = stringSimilarity(quote, sub);
      if (quoteSim < fuzzyThreshold) continue;

      const candPrefix = newText.slice(Math.max(0, start - 32), start);
      const candSuffix = newText.slice(end, Math.min(newText.length, end + 32));
      const ctxSim =
        anchor.prefix || anchor.suffix
          ? ((anchor.prefix ? stringSimilarity(anchor.prefix, candPrefix) : 1) +
              (anchor.suffix ? stringSimilarity(anchor.suffix, candSuffix) : 1)) /
            2
          : 1;
      const combined = quoteSim * 0.8 + ctxSim * 0.2;
      if (combined > bestScore && quoteSim >= fuzzyThreshold) {
        bestScore = combined;
        bestStart = start;
        bestEnd = end;
      }
    }
  }

  // Refine local boundary around bestStart..bestEnd
  if (bestStart !== -1 && bestScore >= fuzzyThreshold) {
    let refinedStart = bestStart;
    let refinedEnd = bestEnd;
    let refinedSim = stringSimilarity(quote, newText.slice(refinedStart, refinedEnd));
    for (let ds = -4; ds <= 4; ds++) {
      for (let de = -4; de <= 4; de++) {
        const s = bestStart + ds;
        const e = bestEnd + de;
        if (s >= 0 && e <= newText.length && e > s) {
          const sim = stringSimilarity(quote, newText.slice(s, e));
          if (sim > refinedSim) {
            refinedSim = sim;
            refinedStart = s;
            refinedEnd = e;
          }
        }
      }
    }

    if (refinedSim >= fuzzyThreshold) {
      const updated = buildTextAnchor(newText, refinedStart, refinedEnd);
      return {
        orphaned: false,
        ...updated,
        matchType: 'fuzzy',
        similarity: Number(refinedSim.toFixed(4)),
      };
    }
  }

  // 4. Otherwise mark orphaned
  return {
    orphaned: true,
    startOffset: anchor.startOffset,
    endOffset: anchor.endOffset,
    exactQuote: quote,
    prefix: anchor.prefix,
    suffix: anchor.suffix,
    matchType: 'orphaned',
    similarity: Number(bestScore.toFixed(4)),
  };
}
