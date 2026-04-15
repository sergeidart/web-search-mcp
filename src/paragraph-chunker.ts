const MIN_CHUNK_LENGTH = 100;

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

  return chunks;
}
