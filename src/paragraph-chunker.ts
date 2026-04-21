const MIN_CHUNK_LENGTH = 100;
const MAX_CHUNK_LENGTH = 1800;

/**
 * Split text into paragraph-sized chunks suitable for FTS indexing.
 * Splits on double-newlines and markdown heading boundaries,
 * then merges tiny fragments with their neighbors.
 */
export function chunkIntoParagraphs(text: string): string[] {
  if (!text || !text.trim()) return [];

  // Split on double-newline or markdown headings (keep heading with its content)
  const raw = text.split(/\n{2,}|(?=^#{1,6}\s)/m);

  const chunks: string[] = [];
  let buffer = '';

  for (const segment of raw) {
    const trimmed = segment.trim();
    if (!trimmed) continue;

    if (buffer.length === 0) {
      buffer = trimmed;
    } else {
      buffer += '\n\n' + trimmed;
    }

    if (buffer.length >= MIN_CHUNK_LENGTH) {
      chunks.push(buffer);
      buffer = '';
    }
  }

  // Flush remaining buffer
  if (buffer.length > 0) {
    if (chunks.length > 0 && buffer.length < MIN_CHUNK_LENGTH) {
      // Merge tiny trailing fragment with the last chunk
      chunks[chunks.length - 1] += '\n\n' + buffer;
    } else {
      chunks.push(buffer);
    }
  }

  return chunks.flatMap(splitOversizedChunk);
}

function splitOversizedChunk(text: string): string[] {
  if (text.length <= MAX_CHUNK_LENGTH) return [text];

  const sentences = text.match(/[^.!?]+[.!?]+(?:["')\]]+)?|[^.!?]+$/g) ?? [text];
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

    if (trimmed.length > MAX_CHUNK_LENGTH) {
      flush();
      chunks.push(...splitByWords(trimmed));
      continue;
    }

    const next = buffer ? `${buffer} ${trimmed}` : trimmed;
    if (next.length > MAX_CHUNK_LENGTH && buffer.length >= MIN_CHUNK_LENGTH) {
      flush();
      buffer = trimmed;
    } else {
      buffer = next;
    }
  }

  flush();
  return mergeTinyChunks(chunks);
}

function splitByWords(text: string): string[] {
  const chunks: string[] = [];
  let buffer = '';

  for (const word of text.split(/\s+/)) {
    if (!word) continue;

    const next = buffer ? `${buffer} ${word}` : word;
    if (next.length > MAX_CHUNK_LENGTH && buffer.length >= MIN_CHUNK_LENGTH) {
      chunks.push(buffer);
      buffer = word;
    } else {
      buffer = next;
    }
  }

  if (buffer) chunks.push(buffer);
  return mergeTinyChunks(chunks);
}

function mergeTinyChunks(chunks: string[]): string[] {
  const merged: string[] = [];

  for (const chunk of chunks) {
    if (chunk.length < MIN_CHUNK_LENGTH && merged.length > 0) {
      merged[merged.length - 1] += `\n\n${chunk}`;
    } else {
      merged.push(chunk);
    }
  }

  return merged;
}
