import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import maplibregl from 'maplibre-gl';
import { SAC_GRADES, sacCssColor } from './sac';
import type { StatusCentre } from '../ui/status';

const savePlaceMock = vi.hoisted(() => vi.fn());
vi.mock('../search/saved-places', () => ({ savePlace: savePlaceMock }));

const {
  PeakTooltip,
  openInLinks,
  renderAvalancheReadout,
  renderCoordsSheet,
  renderPathSheet,
  renderPeakSheet,
} = await import('./feature-sheets');

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

  it('names the grading scale', () => {
    renderPathSheet(body, { properties: {}, grade: t3 } as never);

    expect(body.querySelector('h2')!.textContent).toBe('Path');
    expect(body.querySelector('.sheet-note')!.textContent).toBe('SAC hiking scale from OpenStreetMap.');
  });
});

describe('the coordinates card', () => {
  const elevation = Promise.resolve(1338.6);

  it('shows the ground height once it has been read', async () => {
    let land!: (metres: number | null) => void;
    renderCoordsSheet(body, BEN_NEVIS, { status, elevation: new Promise((r) => (land = r)) });

    expect(body.querySelector('.sheet-ele')!.textContent).toBe('Reading elevation…');
    land(1338.6);
    await flush();
    expect(body.querySelector('.sheet-ele')!.textContent).toBe('1339 m');
  });

  it('says where the height would come from when there is none to read', async () => {
    renderCoordsSheet(body, BEN_NEVIS, { status, elevation: Promise.resolve(null) });
    await flush();

    expect(body.querySelector('.sheet-ele')!.textContent).toBe('Elevation needs a downloaded region');
  });

  it('reports a failed read rather than leaving it pending', async () => {
    renderCoordsSheet(body, BEN_NEVIS, { status, elevation: Promise.reject(new Error('bad tile')) });
    await flush();

    expect(body.querySelector('.sheet-ele')!.textContent).toBe('Could not read elevation: bad tile');
  });

  it('copies the coordinates and confirms it', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    renderCoordsSheet(body, BEN_NEVIS, { status, elevation });

    body.querySelector<HTMLButtonElement>('.sheet-copy')!.click();
    await flush();

    expect(writeText).toHaveBeenCalledWith('56.79685, -5.00360');
    expect(status.toast).toHaveBeenCalledWith('Copied coordinates');
    vi.unstubAllGlobals();
  });

  it('saves the point under its coordinates, having no other name, with its height', async () => {
    renderCoordsSheet(body, BEN_NEVIS, { status, elevation });
    await flush();

    body.querySelector<HTMLButtonElement>('.sheet-save')!.click();
    await flush();

    expect(savePlaceMock).toHaveBeenCalledWith({
      name: '56.79685, -5.00360',
      lng: -5.0036,
      lat: 56.79685,
      ele: 1338.6,
    });
  });

  it('saves without a height when there is none', async () => {
    renderCoordsSheet(body, BEN_NEVIS, { status, elevation: Promise.resolve(null) });
    await flush();

    body.querySelector<HTMLButtonElement>('.sheet-save')!.click();
    await flush();

    expect(savePlaceMock).toHaveBeenCalledWith({ name: '56.79685, -5.00360', lng: -5.0036, lat: 56.79685 });
  });
});

describe('opening a point in another maps app', () => {
  const hrefs = () =>
    Array.from(body.querySelectorAll<HTMLAnchorElement>('.sheet-open-in a')).map((link) => link.href);

  it('sends the coordinates to each app, in the form each one documents', () => {
    expect(openInLinks(BEN_NEVIS, 'Ben Nevis')).toEqual([
      {
        name: 'Google Maps',
        href: 'https://www.google.com/maps/search/?api=1&query=56.79685%2C-5.00360',
      },
      { name: 'Waze', href: 'https://www.waze.com/ul?ll=56.79685%2C-5.00360' },
      { name: 'Apple Maps', href: 'https://maps.apple.com/?ll=56.79685%2C-5.00360&q=Ben+Nevis' },
    ]);
  });

  it('never searches Google or Waze for the name, which can resolve somewhere else', () => {
    const [google, waze] = openInLinks(BEN_NEVIS, 'Ben Nevis');

    expect(google!.href).not.toContain('Ben');
    expect(waze!.href).not.toContain('Ben');
  });

  it('brings a tap on a repeated world copy back into range', () => {
    const [google] = openInLinks(new maplibregl.LngLat(-5.0036 + 360, 56.79685), 'Ben Nevis');

    expect(google!.href).toContain('query=56.79685%2C-5.00360');
  });

  it('keeps a label with URL syntax in it from breaking out of its parameter', () => {
    const apple = new URL(openInLinks(BEN_NEVIS, 'Sgùrr & Beinn=?#')[2]!.href);

    expect(apple.searchParams.get('q')).toBe('Sgùrr & Beinn=?#');
    expect(apple.searchParams.get('ll')).toBe('56.79685,-5.00360');
    expect(apple.hash).toBe('');
  });

  it('offers all three from a summit, labelling the pin with its name', () => {
    renderPeakSheet(body, { name: 'Ben Nevis' }, BEN_NEVIS, { status });

    expect(hrefs()).toHaveLength(3);
    expect(hrefs()[2]).toContain('q=Ben+Nevis');
  });

  it('offers all three from a bare point, which Apple still needs a label for to drop a pin', () => {
    renderCoordsSheet(body, BEN_NEVIS, { status, elevation: Promise.resolve(null) });

    expect(hrefs()).toHaveLength(3);
    expect(hrefs()[2]).toContain('q=56.79685%2C+-5.00360');
  });

  it('leaves the app in a new tab, sends no referrer, and says where each link goes', () => {
    renderPeakSheet(body, { name: 'Ben Nevis' }, BEN_NEVIS, { status });

    const links = Array.from(body.querySelectorAll<HTMLAnchorElement>('.sheet-open-in a'));
    expect(links.map((link) => link.getAttribute('aria-label'))).toEqual([
      'Open in Google Maps',
      'Open in Waze',
      'Open in Apple Maps',
    ]);
    for (const link of links) {
      expect(link.target).toBe('_blank');
      expect(link.rel).toBe('noreferrer');
    }
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

describe('the avalanche terrain readout', () => {
  const region = (id: string) =>
    ({ id, name: id, bbox: [-8, 54, -0.7, 61], totalBytes: 0, artifacts: [] }) as never;

  async function readout(reading: Parameters<typeof renderAvalancheReadout>[1]) {
    renderAvalancheReadout(body, reading);
    await flush();
    return {
      slope: body.querySelector('.sheet-avalanche-slope')!.textContent,
      caveat: body.querySelector('.sheet-avalanche-caveat')!.textContent,
      forecast: body.querySelector<HTMLElement>('.sheet-avalanche-forecast')!,
    };
  }

  it('gives the angle, the aspect and what that angle means — not a danger level', async () => {
    const { slope } = await readout(
      Promise.resolve({ cell: { slope: 38, aspect: 2 }, region: region('scotland') }),
    );
    expect(slope).toBe('Slope 38°, faces NE. Where most slab avalanches release.');
    expect(slope).not.toMatch(/danger|risk|safe/i);
    expect(body.querySelector('.sheet-avalanche-swatch')).not.toBeNull();
  });

  it('says "under 25°" for a zero cell, never flat or safe', async () => {
    const { slope } = await readout(
      Promise.resolve({ cell: { slope: 0, aspect: null }, region: region('scotland') }),
    );
    expect(slope).toBe('Under 25° here.');
  });

  it('always carries the terrain-only line', async () => {
    const { caveat } = await readout(
      Promise.resolve({ cell: { slope: 0, aspect: null }, region: region('scotland') }),
    );
    expect(caveat).toMatch(/never seen the snow/);
    expect(caveat).toMatch(/slide onto you from above/);
  });

  it('links the region’s forecast service', async () => {
    const { forecast } = await readout(
      Promise.resolve({ cell: { slope: 31, aspect: 5 }, region: region('scotland') }),
    );
    const link = forecast.querySelector('a')!;
    expect(link.href).toBe('https://www.sais.gov.uk/');
    expect(link.textContent).toBe('Scottish Avalanche Information Service');
  });

  it('says so, rather than guessing a link, where no service is listed', async () => {
    const { forecast } = await readout(
      Promise.resolve({ cell: { slope: 31, aspect: 5 }, region: region('georgia') }),
    );
    expect(forecast.querySelector('a')).toBeNull();
    expect(forecast.textContent).toMatch(/No avalanche forecast service is listed/);
  });

  it('asks for a region rather than reporting nothing as no slope', async () => {
    const { slope, forecast } = await readout(Promise.resolve(null));
    expect(slope).toBe('Needs a downloaded region with avalanche terrain.');
    expect(forecast.textContent).toBe('');
  });

  it('is left off the summit card unless asked for', () => {
    renderPeakSheet(body, { name: 'Ben Nevis', ele: 1345 }, BEN_NEVIS, { status });
    expect(body.querySelector('.sheet-avalanche')).toBeNull();
  });

  it('appears on the coordinates card when asked for', async () => {
    renderCoordsSheet(body, BEN_NEVIS, {
      status,
      elevation: Promise.resolve(1300),
      avalanche: Promise.resolve({ cell: { slope: 44, aspect: 1 }, region: region('scotland') }),
    });
    await flush();
    expect(body.querySelector('.sheet-avalanche-slope')!.textContent).toBe(
      'Slope 44°, faces N. Frequent, smaller, more often loose snow than slab.',
    );
  });
});
