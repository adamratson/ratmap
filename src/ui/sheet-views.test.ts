import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BottomSheet } from './sheet';
import { SheetViews } from './sheet-views';

function fakeSheet() {
  const body = document.createElement('div');
  body.tabIndex = -1;
  document.body.append(body);
  return {
    body,
    scrollToTop: vi.fn(),
    open: vi.fn(),
    collapse: vi.fn(),
    detent: vi.fn(() => 'content'),
  };
}

describe('SheetViews', () => {
  let sheet: ReturnType<typeof fakeSheet>;
  let chipsHost: HTMLElement;
  let views: SheetViews;

  beforeEach(() => {
    sheet = fakeSheet();
    chipsHost = document.createElement('div');
    document.body.append(chipsHost);
    views = new SheetViews({ sheet: sheet as unknown as BottomSheet, chipsHost, iconButtons: {} });
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('keeps focus on a chip pressed from the keyboard, though the row is rebuilt', () => {
    // Opening a view re-renders the chips. The pressed one used to be destroyed with focus
    // on it, dropping a keyboard user back to <body> on every press.
    views.setDestinations([
      { view: 'routes', label: 'Routes', open: () => views.open('routes', () => {}) },
      { view: 'layers', label: 'Layers', open: () => views.open('layers', () => {}) },
    ]);
    const layers = () => chipsHost.querySelector<HTMLButtonElement>('[data-chip="layers"]')!;
    layers().focus();

    layers().click();

    expect(document.activeElement).toBe(layers());
    expect(layers().getAttribute('aria-expanded')).toBe('true');
  });

  it('does not take focus into the chips when it was somewhere else', () => {
    views.setDestinations([{ view: 'routes', label: 'Routes', open: () => {} }]);
    const elsewhere = document.createElement('input');
    document.body.append(elsewhere);
    elsewhere.focus();

    views.renderChips();

    expect(document.activeElement).toBe(elsewhere);
  });

  it('moves focus into the sheet when asked, so the view is announced by its label', () => {
    // From a banner's button or a search result, focus would otherwise stay on a control
    // that has nothing more to do with what just opened.
    const banner = document.createElement('button');
    document.body.append(banner);
    banner.focus();

    views.open('install', (body) => {
      body.textContent = 'Steps';
    }, { focus: true });

    expect(document.activeElement).toBe(sheet.body);
    expect(sheet.body.getAttribute('aria-label')).toBe('Add to Home Screen');
  });

  it('still honours a detent passed alongside focus', () => {
    views.open('legend', () => {}, { detent: 'full', focus: true });

    expect(sheet.open).toHaveBeenCalledWith('full');
  });
});
