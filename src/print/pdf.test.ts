import { describe, expect, it } from 'vitest';
import { jpegPdf } from './pdf';

// A stand-in for JPEG bytes, including bytes a text encoder would mangle: the writer must
// copy them through untouched.
const FAKE_JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x80, 0x0a, 0xff, 0xd9]);

function pdf(title = 'ratmap 1:25 000'): { bytes: Uint8Array; text: string } {
  const bytes = jpegPdf({
    jpeg: FAKE_JPEG,
    widthPx: 2100,
    heightPx: 2970,
    pageWidthMm: 210,
    pageHeightMm: 297,
    title,
  });
  return { bytes, text: new TextDecoder('latin1').decode(bytes) };
}

describe('jpegPdf', () => {
  it('sizes the page to A4 in points', () => {
    expect(pdf().text).toContain('/MediaBox [0 0 595.28 841.89]');
  });

  it('has an xref whose every offset points at its object', () => {
    const { bytes, text } = pdf();
    const startxref = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(text)![1]);
    expect(text.slice(startxref, startxref + 4)).toBe('xref');

    const entries = text.slice(startxref).split('\n').slice(3, 9);
    entries.forEach((entry, i) => {
      const offset = Number(entry.slice(0, 10));
      const head = new TextDecoder('latin1').decode(bytes.slice(offset, offset + 8));
      expect(head).toBe(`${i + 1} 0 obj\n`);
    });
  });

  it('carries the JPEG byte for byte, with its length', () => {
    const { bytes, text } = pdf();
    expect(text).toContain(`/Length ${FAKE_JPEG.length} >>\nstream\n`);
    const at = text.indexOf('stream\n') + 'stream\n'.length;
    expect([...bytes.slice(at, at + FAKE_JPEG.length)]).toEqual([...FAKE_JPEG]);
    expect(text.slice(at + FAKE_JPEG.length, at + FAKE_JPEG.length + 10)).toBe('\nendstream');
  });

  it('keeps the title to escaped printable ASCII, folding accents and a thin space', () => {
    expect(pdf('Sgùrr (Mòr) \\ 1:25 000').text).toContain('/Title (Sgurr \\(Mor\\) \\\\ 1:25 000)');
  });
});
