// A one-page PDF holding one JPEG, sized to the paper.
//
// Hand-written rather than a library: a page with a single DCTDecode image is six objects,
// and a JPEG goes in as the bytes the canvas already encoded — no decoding, no
// re-compression, no dependency to precache for offline use. The PDF reader decodes it.
//
// Why a PDF at all, rather than window.print(): the print dialog from an installed Home
// Screen web app on iOS is not something this app could confirm works, and a PDF in the
// share sheet is — it opens in Files, Mail or the printer dialog, and on a desktop it is
// a download that prints at the right size from any viewer ("Actual size", not "Fit").

const PT_PER_MM = 72 / 25.4;

export interface JpegPage {
  jpeg: Uint8Array;
  /** The JPEG's own pixel size. */
  widthPx: number;
  heightPx: number;
  /** The paper, in mm. The image fills it exactly. */
  pageWidthMm: number;
  pageHeightMm: number;
  title: string;
}

export function jpegPdf(page: JpegPage): Uint8Array<ArrayBuffer> {
  const w = round(page.pageWidthMm * PT_PER_MM);
  const h = round(page.pageHeightMm * PT_PER_MM);
  const content = `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`;

  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let length = 0;
  const push = (part: string | Uint8Array): void => {
    const bytes = typeof part === 'string' ? encoder.encode(part) : part;
    chunks.push(bytes);
    length += bytes.length;
  };
  const object = (n: number, body: string): void => {
    offsets[n] = length;
    push(`${n} 0 obj\n${body}\nendobj\n`);
  };

  // The comment's high bytes (any will do; these are UTF-8) mark the file as binary for
  // transfer tools, as the PDF spec recommends.
  push('%PDF-1.4\n%âãÏÓ\n');
  object(1, '<< /Type /Catalog /Pages 2 0 R >>');
  object(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  object(
    3,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] ` +
      '/Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>',
  );

  offsets[4] = length;
  push(
    '4 0 obj\n' +
      `<< /Type /XObject /Subtype /Image /Width ${page.widthPx} /Height ${page.heightPx} ` +
      '/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode ' +
      `/Length ${page.jpeg.length} >>\nstream\n`,
  );
  push(page.jpeg);
  push('\nendstream\nendobj\n');

  object(5, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  object(6, `<< /Title (${pdfString(page.title)}) /Producer (ratmap) >>`);

  const xref = length;
  const size = offsets.length;
  push(
    `xref\n0 ${size}\n0000000000 65535 f \n` +
      offsets
        .slice(1)
        .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
        .join('') +
      `trailer\n<< /Size ${size} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xref}\n%%EOF\n`,
  );

  const out = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * A literal string, kept to printable ASCII: anything else would need PDFDocEncoding or
 * UTF-16, which is more machinery than a title is worth. Accents fold to their letter.
 */
function pdfString(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/[\\()]/g, (c) => `\\${c}`);
}
