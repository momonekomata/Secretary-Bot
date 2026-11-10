import { inflateRawSync } from 'node:zlib';
import { t } from './i18n';

/** Reads one file out of a ZIP archive (enough for .docx; no encryption or ZIP64). */
export function unzipEntry(zip: Buffer, wanted: string): Buffer | null {
  // Find the end-of-central-directory record (within the last 64 KB + 22 bytes).
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65_558); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  for (let n = 0; n < count && p + 46 <= zip.length; n++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) return null;
    const method = zip.readUInt16LE(p + 10);
    const compressedSize = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const localOffset = zip.readUInt32LE(p + 42);
    const name = zip.toString('utf8', p + 46, p + 46 + nameLen);
    if (name === wanted) {
      const localNameLen = zip.readUInt16LE(localOffset + 26);
      const localExtraLen = zip.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + localNameLen + localExtraLen;
      const data = zip.subarray(start, start + compressedSize);
      if (method === 0) return Buffer.from(data);
      if (method === 8) return inflateRawSync(data);
      return null;
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unescapeXml = (s: string) => s.replace(/&(amp|lt|gt|quot|apos);/g, (_, e: string) => XML_ENTITIES[e]).replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)));

/** Plain text of a Word .docx file. */
export function docxText(file: Buffer): string {
  const xml = unzipEntry(file, 'word/document.xml');
  if (!xml) throw new Error('This does not look like a Word .docx file.');
  return unescapeXml(
    xml
      .toString('utf8')
      .replace(/<w:tab\/>/g, '\t')
      .replace(/<w:br[^>]*\/>/g, '\n')
      .replace(/<\/w:p>/g, '\n')
      .replace(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g, '$1')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export type DocKind = 'pdf' | 'docx' | 'text' | 'image' | 'unsupported';

const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|xml|html?|ya?ml|log|ini|srt|vtt|py|js|ts|java|c|cpp|cs|go|rb|php|sh|sql)$/i;

export function documentKind(name: string, mime: string): DocKind {
  const m = mime.toLowerCase();
  if (m === 'application/pdf' || /\.pdf$/i.test(name)) return 'pdf';
  if (m.includes('wordprocessingml') || /\.docx$/i.test(name)) return 'docx';
  if (/^image\/(jpeg|png|gif|webp)$/.test(m)) return 'image';
  if (m.startsWith('text/') || /json|xml|csv|yaml|javascript/.test(m) || TEXT_EXT.test(name)) return 'text';
  return 'unsupported';
}

export interface DocumentInput {
  name: string;
  /** Only PDFs are sent to the AI as documents; other kinds become text first. */
  mediaType: 'application/pdf';
  /** base64 */
  data: string;
}

export const MAX_DOC_TEXT = 100_000;

export const MAX_FILE_BYTES = 15 * 1024 * 1024;

/** The user-facing message for a file over MAX_FILE_BYTES. */
export function fileTooBig(name: string): string {
  return t(`${name} is too big for me (max about 15 MB).`, `ไฟล์ ${name} ใหญ่เกินไป (สูงสุดประมาณ 15 MB)`);
}

/** The user-facing message for a voice note over the audio size limit. */
export function voiceTooLong(): string {
  return t('That voice note is too long for me (max about 15 MB).', 'ข้อความเสียงนี้ยาวเกินไป (สูงสุดประมาณ 15 MB)');
}

export interface FileInput {
  images?: { mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'; data: string }[];
  documents?: DocumentInput[];
  /** Text extracted from text-like files and Word documents, added to the user's message. */
  text?: string;
}

/** Turns a file the user sent into something the AI can read. Throws a user-facing error for unsupported files. */
export function fileToInput(name: string, mime: string, buf: Buffer): FileInput {
  if (buf.length > MAX_FILE_BYTES) throw new UserFacingError(fileTooBig(name));
  const kind = documentKind(name, mime);
  const cut = (t: string) => (t.length > MAX_DOC_TEXT ? `${t.slice(0, MAX_DOC_TEXT)}\n[…cut]` : t);
  switch (kind) {
    case 'pdf':
      return { documents: [{ name, mediaType: 'application/pdf', data: buf.toString('base64') }] };
    case 'image':
      return { images: [{ mediaType: mime as 'image/jpeg', data: buf.toString('base64') }] };
    case 'docx':
      return { text: `[File ${name}]\n${cut(docxText(buf))}` };
    case 'text':
      return { text: `[File ${name}]\n${cut(buf.toString('utf8'))}` };
    default:
      throw new UserFacingError(
        t(
          `I can't read ${name} yet. PDF, Word (.docx), text/CSV files and images work; for spreadsheets, upload to Google Sheets or send a CSV.`,
          `ยังอ่านไฟล์ ${name} ไม่ได้ ไฟล์ที่อ่านได้คือ PDF, Word (.docx), ไฟล์ข้อความ/CSV และรูปภาพ ถ้าเป็นสเปรดชีต อัปโหลดขึ้น Google Sheets หรือส่งเป็น CSV แทนนะ`,
        ),
      );
  }
}

/** An error whose message is safe and helpful to show to the user as-is. */
export class UserFacingError extends Error {}
