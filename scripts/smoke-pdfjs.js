import fs from 'node:fs';
import path from 'node:path';
import * as url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

async function main() {
  const pdfjs = await import('pdfjs-dist/build/pdf.mjs');
  const samplePath = path.join(__dirname, '../.data/sample.pdf');
  const buf = fs.readFileSync(samplePath);
  const data = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  const task = pdfjs.getDocument({
    data,
    disableFontFace: true,
    useSystemFonts: true,
    isEvalSupported: false,
    disableRange: true,
    cMapUrl: undefined,
    cMapPacked: true,
  });
  const doc = await task.promise;
  console.log('PDF pages:', doc.numPages);
  const page = await doc.getPage(1);
  const content = await page.getTextContent();
  console.log('Tokens on page 1:', content.items?.length ?? 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
