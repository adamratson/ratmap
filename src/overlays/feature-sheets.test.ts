import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import maplibregl from 'maplibre-gl';
import { SAC_GRADES, sacCssColor } from './sac';
import type { StatusCentre } from '../ui/status';

const savePlaceMock = vi.hoisted(() => vi.fn());
vi.mock('../search/saved-places', () => ({ savePlace: savePlaceMock }));

const { PeakTooltip, renderCoordsSheet, renderPathSheet, renderPeakSheet } = await import(
  './feature-sheets'
);

const BEN_NEVIS = new maplibregl.LngLat(-5.00360, 56.79685);
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

let body: HTMLElement;
let status: { toast: Mock<StatusCentre['toast']> };

beforeEach(() => {
  body = document.createElement('div');
  document.body.append(body);
  status = { toast: vi.fn() };
  savePlaceMock.mockReset();
  savePlaceMock.mockResolvedValue(undefined);
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('the summit card', () => {
  it('shows the name, height and position', () => {
    renderPeakSheet(body, { name: 'Ben Nevis', ele: 1345 }, BEN_NEVIS, { status });

    expect(body.querySelector('h2')!.textContent).toBe('Ben Nevis');
    expect(body.querySelector('.sheet-ele')!.textContent).toBe('1345 m');
    expect(body.querySelector('.sheet-coords')!.textContent).toBe('56.79685, -5.00360');
  });

  it('treats the name as text — OSM names are anyone’s to edit', () => {
    renderPeakSheet(body, { name: '<img src=x onerror="alert(1)">' }, BEN_NEVIS, { status });

    expect(body.querySelector('img')).toBeNull();
    expect(body.querySelector('h2')!.textContent).toBe('<img src=x onerror="alert(1)">');
  });

  it('says what it does not know rather than leaving gaps', () => {
    renderPeakSheet(body, { name: '  ' }, BEN_NEVIS, { status });

    expect(body.querySelector('h2')!.textContent).toBe('Unnamed summit');
    expect(body.querySelector('.sheet-ele')!.textContent).toBe('Elevation unknown');
  });

  it('marks a Munro, and only a Munro', () => {
    renderPeakSheet(body, { name: 'Ben Nevis', lists: 'munro' }, BEN_NEVIS, { status });
    expect(body.querySelector('.sheet-munro-badge')).not.toBeNull();

    renderPeakSheet(body, { name: 'Cow Hill' }, BEN_NEVIS, { status });
    expect(body.querySelector('.sheet-munro-badge')).toBeNull();
  });

  it('links to Wikidata with the id encoded, and only when there is one', () => {
    renderPeakSheet(body, { name: 'Ben Nevis', wikidata: 'Q/../x' }, BEN_NEVIS, { status });
    expect(body.querySelector<HTMLAnchorElement>('.sheet-link')!.href).toBe(
      'https://www.wikidata.org/wiki/Q%2F..%2Fx',
    );

    renderPeakSheet(body, { name: 'Cow Hill' }, BEN_NEVIS, { status });
    expect(body.querySelector('.sheet-link')).toBeNull();
  });

  it('saves the summit itself, with its height, and says so', async () => {
    renderPeakSheet(body, { name: 'Ben Nevis', ele: 1345 }, BEN_NEVIS, { status });

    body.querySelector<HTMLButtonElement>('.sheet-save')!.click();
    await flush();

    expect(savePlaceMock).toHaveBeenCalledWith({ name: 'Ben Nevis', lng: -5.0036, lat: 56.79685, ele: 1345 });
    expect(status.toast).toHaveBeenCalledWith('Saved “Ben Nevis”');
  });

  it('reports a failed save as an error, with the reason', async () => {
    savePlaceMock.mockRejectedValue(new Error('quota exceeded'));
    renderPeakSheet(body, { name: 'Ben Nevis' }, BEN_NEVIS, { status });

    body.querySelector<HTMLButtonElement>('.sheet-save')!.click();
    await flush();

    expect(status.toast).toHaveBeenCalledWith(expect.stringContaining('quota exceeded'), { kind: 'error' });
  });
});

describe('the path grade card', () => {
  const t3 = SAC_GRADES.find((entry) => entry.grade === 3)!;

  it('quotes the grade in the SAC’s own words, in its own colour', () => {
    renderPathSheet(body, { properties: { name: 'Mountain Track' }, grade: t3 } as never);

    const line = body.querySelector<HTMLElement>('.sheet-sac-grade')!;
    expect(body.querySelector('h2')!.textContent).toBe('Mountain Track');
    expect(line.textContent).toBe(`${t3.short} · ${t3.label}`);
    expect(line.style.color).toBe(sacCssColor(3));
    expect(body.querySelector('.sheet-sac-note')!.textContent).toBe(t3.note);
  });

  it('says a grade assumes summer conditions', () => {
    renderPathSheet(body, { properties: {}, grade: t3 } as never);

    expect(body.querySelector('h2')!.textContent).toBe('Path');
    expect(body.querySelector('.sheet-note')!.textContent).toMatch(/good summer conditions/);
  });
});

describe('the coordinates card', () => {
  it('copies the coordinates and confirms it', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    renderCoordsSheet(body, BEN_NEVIS, { status });

    body.querySelector<HTMLButtonElement>('.sheet-copy')!.click();
    await flush();

    expect(writeText).toHaveBeenCalledWith('56.79685, -5.00360');
    expect(status.toast).toHaveBeenCalledWith('Copied coordinates');
    vi.unstubAllGlobals();
  });

  it('saves the point under its coordinates, having no other name', async () => {
    renderCoordsSheet(body, BEN_NEVIS, { status });

    body.querySelector<HTMLButtonElement>('.sheet-save')!.click();
    await flush();

    expect(savePlaceMock).toHaveBeenCalledWith({ name: '56.79685, -5.00360', lng: -5.0036, lat: 56.79685 });
  });
});

describe('PeakTooltip', () => {
  it('shows the name and height where the pointer is, and hides again', () => {
    const element = document.createElement('div');
    element.hidden = true;
    const tooltip = new PeakTooltip(element);

    tooltip.show({ name: 'Ben Nevis', ele: 1345 }, { x: 120, y: 80 });

    expect(element.hidden).toBe(false);
    expect(element.textContent).toBe('Ben Nevis 1345 m');
    expect([element.style.left, element.style.top]).toEqual(['120px', '80px']);

    tooltip.hide();
    expect(element.hidden).toBe(true);
  });

  it('treats the name as text', () => {
    const element = document.createElement('div');
    new PeakTooltip(element).show({ name: '<b>x</b>' }, { x: 0, y: 0 });

    expect(element.querySelector('b')).toBeNull();
  });
});
