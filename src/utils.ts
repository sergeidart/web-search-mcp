/**
 * Utility functions for the web search MCP server
 */

export function cleanText(text: string, maxLength: number = 10000): string {
  const normalized = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => line.replace(/[^\S\n]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return maxLength > 0 ? normalized.substring(0, maxLength) : normalized;
}

export function getWordCount(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;

  const segmenter = getIntlSegmenter();
  if (segmenter) {
    let count = 0;
    for (const segment of segmenter.segment(trimmed)) {
      if (segment.isWordLike) count++;
    }
    if (count > 0) return count;
  }

  const unicodeWords = trimmed.match(/[\p{L}\p{N}]+/gu);
  return unicodeWords ? unicodeWords.length : 0;
}

export function getContentPreview(text: string, maxLength: number = 500): string {
  const cleaned = cleanText(text, maxLength);
  return cleaned.length === maxLength ? cleaned + '...' : cleaned;
}

export function generateTimestamp(): string {
  return new Date().toISOString();
}

export function validateUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export function sanitizeQuery(query: string): string {
  return query.trim().substring(0, 1000); // Limit query length
}

export function getAcceptLanguage(): string {
  const configured = process.env.ACCEPT_LANGUAGE?.trim();
  return configured || 'en-US,en;q=0.9';
}

export function getPrimaryLocale(): string {
  const firstLanguage = getAcceptLanguage().split(',')[0]?.trim();
  return firstLanguage?.split(';')[0]?.trim() || 'en-US';
}

export function getNavigatorLanguages(): string[] {
  return getAcceptLanguage()
    .split(',')
    .map(value => value.split(';')[0]?.trim())
    .filter((value): value is string => Boolean(value));
}

export function getMaxPdfBytes(): number {
  const configured = process.env.MAX_PDF_BYTES;
  const parsed = configured ? parseInt(configured, 10) : 20000000;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 20000000;
}

export function getRandomUserAgent(): string {
  const userAgents = [
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
  ];
  return userAgents[Math.floor(Math.random() * userAgents.length)];
}

export function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function isPdfUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const pathname = decodeURIComponent(parsed.pathname).toLowerCase();
    if (pathname.endsWith('.pdf')) return true;

    for (const [key, value] of parsed.searchParams.entries()) {
      const lowerKey = key.toLowerCase();
      const lowerValue = value.toLowerCase();
      if (
        lowerValue === 'pdf' ||
        lowerValue.endsWith('.pdf') ||
        lowerValue.includes('application/pdf') ||
        (lowerKey.includes('pdf') && lowerValue !== 'false')
      ) {
        return true;
      }
    }

    return /(?:^|[?&])(?:format|type|filetype|contenttype|mime|download)=pdf(?:&|$)/i.test(url);
  } catch {
    // If URL parsing fails, check the raw string as fallback
    return /(?:\.pdf(?:[?#].*)?$|[?&](?:format|type|filetype|contenttype|mime|download)=pdf(?:&|$))/i.test(url);
  }
}

export function isPdfContentType(contentType: string | undefined): boolean {
  return Boolean(contentType && /\b(application|binary)\/(?:x-)?pdf\b/i.test(contentType));
}

export function hasPdfMagicBytes(data: Uint8Array): boolean {
  const sample = Buffer.from(data.subarray(0, Math.min(data.byteLength, 1024))).toString('latin1');
  return sample.includes('%PDF-');
}

export function isTextLikeContentType(contentType: string | undefined): boolean {
  if (!contentType) return true;
  return /^(text\/|application\/(?:xhtml\+xml|xml|json|ld\+json|javascript|ecmascript)|image\/svg\+xml)\b/i.test(contentType);
}

export function looksLikeBinary(data: Uint8Array): boolean {
  const sample = data.subarray(0, Math.min(data.byteLength, 4096));
  if (sample.byteLength === 0) return false;

  let suspicious = 0;
  for (const byte of sample) {
    if (byte === 0) return true;
    const isAllowedControl = byte === 9 || byte === 10 || byte === 12 || byte === 13;
    if (byte < 32 && !isAllowedControl) suspicious++;
  }

  return suspicious / sample.byteLength > 0.08;
}

export function decodeTextBuffer(data: Uint8Array, contentType: string | undefined): string {
  const charset = contentType?.match(/charset=([^;\s]+)/i)?.[1]?.replace(/['"]/g, '').trim() || 'utf-8';
  try {
    return new TextDecoder(charset, { fatal: false }).decode(data);
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(data);
  }
}

type SegmenterLike = {
  segment(input: string): Iterable<{ isWordLike?: boolean }>;
};

function getIntlSegmenter(): SegmenterLike | null {
  const intlWithSegmenter = Intl as typeof Intl & {
    Segmenter?: new (
      locale?: string | string[],
      options?: { granularity?: 'grapheme' | 'word' | 'sentence' },
    ) => SegmenterLike;
  };

  return intlWithSegmenter.Segmenter ? new intlWithSegmenter.Segmenter(undefined, { granularity: 'word' }) : null;
}
