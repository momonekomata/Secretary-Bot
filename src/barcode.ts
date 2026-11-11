import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader';

/**
 * Product barcodes (EAN-13, EAN-8, UPC-A, UPC-E) read from photos with ZXing (WebAssembly), on the NAS itself:
 * no AI and no network. The decoder ships with the package; it is loaded from there instead of the CDN the
 * library uses by default.
 */

let ready: Promise<unknown> | null = null;

function prepare() {
  ready ??= Promise.resolve().then(() => {
    const wasm = readFileSync(createRequire(import.meta.url).resolve('zxing-wasm/reader/zxing_reader.wasm'));
    return prepareZXingModule({ overrides: { wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer }, fireImmediately: true });
  });
  return ready;
}

/** True for an EAN-8, UPC-A (12), EAN-13 or GTIN-14 number whose check digit is right. */
export function validBarcode(code: string): boolean {
  if (!/^(\d{8}|\d{12,14})$/.test(code)) return false;
  const digits = [...code].map(Number);
  const check = digits.pop()!;
  // From the right, digits are weighted 3, 1, 3, 1, …
  const sum = digits.reverse().reduce((s, d, i) => s + d * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}

/** Just the digits of a barcode as typed or read ("8 850999 220017" → "8850999220017"). */
export const barcodeDigits = (code: string) => code.replace(/\D/g, '');

/** Product barcodes in an image (JPEG/PNG bytes), valid ones only. Never throws: no barcode → []. */
export async function findBarcodes(image: Buffer): Promise<string[]> {
  try {
    await prepare();
    const results = await readBarcodes(new Uint8Array(image), { formats: ['EAN13', 'EAN8', 'UPCA', 'UPCE'], tryHarder: true, maxNumberOfSymbols: 4 });
    // UPC-E (short codes on small packs) has its own check digit rule: trust the decoder's check for those.
    return [...new Set(results.filter((r) => r.isValid && (r.format === 'UPCE' || validBarcode(r.text))).map((r) => r.text))];
  } catch {
    return [];
  }
}
