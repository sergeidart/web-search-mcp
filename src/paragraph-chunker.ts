export const MIN_CHUNK_LENGTH = 100;
export const MAX_CHUNK_LENGTH = 1800;

const SENTENCE_PATTERN = /[^.!?。！？؟؛]+[.!?。！？؟؛]+(?:["')\]\u300d\u300f\u300b\uff09]+)?|[^.!?。！？؟؛]+$/gu;

/**
 * Split text into paragraph-sized chunks suitable for FTS indexing.
 * Preserves paragraph boundaries where present and enforces MAX_CHUNK_LENGTH
 * even for binary-like text, long URLs, and languages without whitespace.
 */
export function chunkIntoParagraphs(text: string): string[] {
  if (!text || !text.trim()) return [];

  const raw = text
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}|(?=^#{1,6}\s)/m);

  const chunks: string[] = [];
  let buffer = '';

  for (const segment of raw) {
    const trimmed = segment.trim();
    if (!trimmed) continue;

    const candidate = buffer ? `${buffer}\n\n${trimmed}` : trimmed;
    if (candidate.length > MAX_CHUNK_LENGTH) {
      pushSplit(chunks, buffer);
      buffer = '';
      pushSplit(chunks, trimmed);
    } else if (candidate.length >= MIN_CHUNK_LENGTH) {
      chunks.push(candidate);
      buffer = '';
    } else {
      buffer = candidate;
    }
  }

  pushSplit(chunks, buffer);
  return mergeTinyChunks(chunks).flatMap(enforceMaxLength);
}

function pushSplit(chunks: string[], text: string): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  chunks.push(...splitOversizedChunk(trimmed));
}

function splitOversizedChunk(text: string): string[] {
  if (text.length <= MAX_CHUNK_LENGTH) return [text];

  const sentences = text.match(SENTENCE_PATTERN) ?? [text];
  const chunks: string[] = [];
  let buffer = '';

  const flush = () => {
    if (buffer.trim()) {
      chunks.push(buffer.trim());
      buffer = '';
    }
  };

  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (!trimmed) continue;

    const pieces = trimmed.length > MAX_CHUNK_LENGTH ? splitByWords(trimmed) : [trimmed];
    for (const piece of pieces) {
      const next = buffer ? `${buffer} ${piece}` : piece;
      if (next.length > MAX_CHUNK_LENGTH && buffer.length >= MIN_CHUNK_LENGTH) {
        flush();
        buffer = piece;
      } else if (next.length > MAX_CHUNK_LENGTH) {
        flush();
        chunks.push(...hardSplit(piece));
      } else {
        buffer = next;
      }
    }
  }

  flush();
  return mergeTinyChunks(chunks).flatMap(enforceMaxLength);
}

function splitByWords(text: string): string[] {
  const chunks: string[] = [];
  let buffer = '';

  for (const word of text.split(/\s+/u)) {
    if (!word) continue;

    if (word.length > MAX_CHUNK_LENGTH) {
      pushSplit(chunks, buffer);
      buffer = '';
      chunks.push(...hardSplit(word));
      continue;
    }

    const next = buffer ? `${buffer} ${word}` : word;
    if (next.length > MAX_CHUNK_LENGTH && buffer.length >= MIN_CHUNK_LENGTH) {
      chunks.push(buffer);
      buffer = word;
    } else {
      buffer = next;
    }
  }

  pushSplit(chunks, buffer);
  return mergeTinyChunks(chunks).flatMap(enforceMaxLength);
}

function hardSplit(text: string): string[] {
  const chunks: string[] = [];
  let buffer = '';

  for (const char of text) {
    if (buffer.length + char.length > MAX_CHUNK_LENGTH) {
      if (buffer) chunks.push(buffer);
      buffer = char;
    } else {
      buffer += char;
    }
  }

  if (buffer) chunks.push(buffer);
  return chunks;
}

function mergeTinyChunks(chunks: string[]): string[] {
  const merged: string[] = [];

  for (const chunk of chunks) {
    const previous = merged[merged.length - 1];
    if (
      chunk.length < MIN_CHUNK_LENGTH &&
      previous &&
      previous.length + 2 + chunk.length <= MAX_CHUNK_LENGTH
    ) {
      merged[merged.length - 1] = `${previous}\n\n${chunk}`;
    } else {
      merged.push(chunk);
    }
  }

  return merged;
}

function enforceMaxLength(text: string): string[] {
  return text.length <= MAX_CHUNK_LENGTH ? [text] : hardSplit(text);
}
