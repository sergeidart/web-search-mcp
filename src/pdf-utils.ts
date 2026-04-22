import { PDFParse } from 'pdf-parse';
import { cleanText } from './utils.js';

export async function extractPdfText(data: Uint8Array): Promise<string> {
  const parser = new PDFParse({ data });

  try {
    const result = await parser.getText();
    const text = cleanText(result.text, 0);
    if (!text) {
      throw new Error('No extractable text found in PDF');
    }
    return text;
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}
