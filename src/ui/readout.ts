// A measured value, rendered as a readout: the number in mono, the unit smaller and muted
// (plans/signature-style.md, principle 1 — "numbers are the product").
//
// Takes the already-formatted string rather than a number and a unit, so the formatters
// (formatDistance, formatElevation, …) stay the single source of how a value is written,
// and every string-only caller of them — toasts, GPX, aria text — is untouched. Anything
// that isn't "<number> <unit>" ("—", "T3", "Elevation unknown") is written as plain text:
// the readout is a presentation of a figure, never a reason to mangle a sentence.
//
// The space between value and unit is a real text node, so `textContent` reads exactly
// the formatter's output — which is what the e2e suite asserts against.

const FIGURE = /^([−-]?[\d.,]+)\s?(m|km|kB|MB|GB|%|min|hr)$/;

export function fillReadout(target: HTMLElement, text: string): void {
  target.classList.add('readout');
  target.replaceChildren();

  const match = FIGURE.exec(text);
  if (!match) {
    target.textContent = text;
    return;
  }

  const [, value, unit] = match;
  const valueEl = document.createElement('span');
  valueEl.className = 'readout-value';
  valueEl.textContent = value;

  const unitEl = document.createElement('span');
  unitEl.className = 'readout-unit';
  unitEl.textContent = unit;

  // "45%" has no space in the source string, and must not grow one.
  const gap = text.slice(value.length, text.length - unit.length);
  target.append(valueEl, gap, unitEl);
}
