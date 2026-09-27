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

// Longest first: unanchored, `m` would otherwise take the front off `min`.
const UNIT = '(?:min|hr|km|kB|MB|GB|m|%)';
const PART = `[−-]?[\\d.,]+\\s?${UNIT}`;
// One figure, or several run together — "3 hr 20 min" is one reading in two units.
const FIGURE = new RegExp(`^${PART}(?: ${PART})*$`);
const PARTS = new RegExp(`([−-]?[\\d.,]+)(\\s?)(${UNIT})`, 'g');

export function fillReadout(target: HTMLElement, text: string): void {
  target.classList.add('readout');
  target.replaceChildren();

  if (!FIGURE.test(text)) {
    target.textContent = text;
    return;
  }

  let last = 0;
  for (const match of text.matchAll(PARTS)) {
    const [whole, value, gap, unit] = match;
    // The space between one figure and the next, as written.
    if (match.index > last) target.append(text.slice(last, match.index));

    const valueEl = document.createElement('span');
    valueEl.className = 'readout-value';
    valueEl.textContent = value;

    const unitEl = document.createElement('span');
    unitEl.className = 'readout-unit';
    unitEl.textContent = unit;

    // "45%" has no space in the source string, and must not grow one.
    target.append(valueEl, gap, unitEl);
    last = match.index + whole.length;
  }
}
