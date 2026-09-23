import type { Map as MLMap } from 'maplibre-gl';

// The rail's compass button: puts north back.

export function setUpCompass(map: MLMap, button: HTMLButtonElement): void {
  const needle = button.querySelector<HTMLElement>('.compass-needle')!;

  button.addEventListener('click', () => {
    map.easeTo({ bearing: 0, pitch: 0, duration: 300 });
  });

  // Only present when it has something to undo. A permanent compass on a map that is always
  // north-up is a control that never does anything, taking up the scarcest space there is.
  function render(): void {
    const bearing = map.getBearing();
    button.hidden = Math.abs(bearing) < 1 && map.getPitch() < 1;
    needle.style.transform = `rotate(${-bearing}deg)`;
  }

  map.on('rotate', render);
  map.on('pitch', render);
  render();
}
