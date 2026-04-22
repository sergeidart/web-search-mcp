#!/usr/bin/env node

import assert from 'node:assert/strict';
import http from 'node:http';
import { chunkIntoParagraphs, MAX_CHUNK_LENGTH } from '../dist/paragraph-chunker.js';
import {
  hasPdfMagicBytes,
  isPdfContentType,
  isPdfUrl,
} from '../dist/utils.js';
import { extractPdfText } from '../dist/pdf-utils.js';
import { ResultStore } from '../dist/result-store.js';
import { EnhancedContentExtractor } from '../dist/enhanced-content-extractor.js';

function createTinyPdf(text) {
  const escaped = text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const stream = `BT /F1 24 Tf 72 720 Td (${escaped}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /MediaBox [0 0 612 792] /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`,
  ];

  let body = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body, 'latin1'));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });

  const xrefOffset = Buffer.byteLength(body, 'latin1');
  body += `xref\n0 ${objects.length + 1}\n`;
  body += '0000000000 65535 f \n';
  for (const offset of offsets) {
    body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(body, 'latin1');
}

async function main() {
  const hardChunks = chunkIntoParagraphs('x'.repeat(5000));
  assert.ok(hardChunks.length > 1, 'hard token should split into multiple chunks');
  assert.ok(hardChunks.every(chunk => chunk.length <= MAX_CHUNK_LENGTH), 'hard token chunks stay under max length');

  const japaneseText = 'これは日本語の長い文章です。'.repeat(400);
  const japaneseChunks = chunkIntoParagraphs(japaneseText);
  assert.ok(japaneseChunks.length > 1, 'long Japanese text should split');
  assert.ok(japaneseChunks.every(chunk => chunk.length <= MAX_CHUNK_LENGTH), 'Japanese chunks stay under max length');

  assert.equal(isPdfUrl('https://example.com/report.pdf'), true);
  assert.equal(isPdfUrl('https://example.com/report.PDF#page=2'), true);
  assert.equal(isPdfUrl('https://example.com/download?id=123&format=pdf'), true);
  assert.equal(isPdfContentType('application/pdf; charset=binary'), true);

  const tinyPdf = createTinyPdf('Hello PDF Text');
  assert.equal(hasPdfMagicBytes(tinyPdf), true);

  const pdfText = await extractPdfText(tinyPdf);
  assert.match(pdfText, /Hello PDF Text/);
  assert.equal(pdfText.includes('%PDF-'), false, 'extracted PDF text should not include raw PDF bytes');

  const server = http.createServer((request, response) => {
    if (request.url === '/pdf-by-type') {
      response.writeHead(200, { 'Content-Type': 'application/pdf' });
      response.end(tinyPdf);
      return;
    }
    if (request.url === '/pdf-by-magic') {
      response.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      response.end(tinyPdf);
      return;
    }
    response.writeHead(404);
    response.end();
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const extractor = new EnhancedContentExtractor();
  try {
    assert.match(await extractor.extractContent({ url: `${baseUrl}/pdf-by-type` }), /Hello PDF Text/);
    assert.match(await extractor.extractContent({ url: `${baseUrl}/pdf-by-magic` }), /Hello PDF Text/);
  } finally {
    await extractor.closeAll();
    await new Promise(resolve => server.close(resolve));
  }

  const store = new ResultStore();
  store.initialize();
  try {
    const timestamp = new Date().toISOString();
    const ids = store.storeResults([
      {
        title: 'Japanese',
        url: 'https://example.com/ja',
        description: '',
        fullContent: japaneseText,
        contentPreview: '',
        wordCount: 1,
        timestamp,
        fetchStatus: 'success',
      },
      {
        title: 'Russian',
        url: 'https://example.com/ru',
        description: '',
        fullContent: 'Это русский абзац для проверки поиска.',
        contentPreview: '',
        wordCount: 6,
        timestamp,
        fetchStatus: 'success',
      },
      {
        title: 'Short',
        url: 'https://example.com/ai',
        description: '',
        fullContent: 'AI',
        contentPreview: '',
        wordCount: 1,
        timestamp,
        fetchStatus: 'success',
      },
      {
        title: 'PDF',
        url: 'https://example.com/report.pdf',
        description: '',
        fullContent: pdfText,
        contentPreview: '',
        wordCount: 3,
        timestamp,
        fetchStatus: 'success',
      },
    ]);

    assert.equal(ids.length, 4);
    assert.ok(store.search('日本語').length > 0, 'trigram FTS should find Japanese substring');
    assert.ok(store.search('русский').length > 0, 'trigram FTS should find Russian text');
    assert.ok(store.search('AI').length > 0, 'short query fallback should find two-character text');

    const pdfParagraphs = store.getResultParagraphs(ids[3]);
    assert.ok(pdfParagraphs.length > 0);
    assert.equal(pdfParagraphs.some(paragraph => paragraph.content.includes('%PDF-')), false);
  } finally {
    store.close();
  }

  console.log('Content processing tests passed');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
