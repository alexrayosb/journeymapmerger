/**
 * "Preview a map": pick any map zip (a merged one included), choose a
 * dimension and layer, pan and zoom, hover waypoints.
 */
import { groupTiles, parseWaypoint, type LayerTiles, type Waypoint } from '../../merge/tiles.ts';
import { indexWorld } from '../../merge/world-index.ts';
import type { Archive, ArchiveEntry } from '../../zip/reader.ts';
import { el } from '../dom.ts';
import { formatInt } from '../format.ts';
import { createMapPicker } from '../map-picker.ts';
import { MapViewer } from './viewer.ts';

export function mountPreviewPanel(container: HTMLElement): void {
  const picker = createMapPicker(
    'preview',
    'Map to preview',
    'Any JourneyMap map zip, including a merged one.',
  );
  const dimSelect = el('select', { id: 'preview-dim', testId: 'preview-dim' });
  const layerSelect = el('select', { id: 'preview-layer', testId: 'preview-layer' });
  const fitButton = el('button', { type: 'button', textContent: 'Fit' });
  const zoomIn = el('button', { type: 'button', textContent: '+', title: 'Zoom in' });
  const zoomOut = el('button', { type: 'button', textContent: '−', title: 'Zoom out' });
  const coords = el('span', { className: 'coords', testId: 'coords' });
  const note = el('p', { className: 'hint', testId: 'preview-note' });
  const controls = el('p', { className: 'controls', hidden: true, testId: 'preview-controls' }, [
    el('label', { htmlFor: 'preview-dim', textContent: 'Dimension ' }),
    dimSelect,
    ' ',
    el('label', { htmlFor: 'preview-layer', textContent: 'Layer ' }),
    layerSelect,
    ' ',
    fitButton,
    ' ',
    zoomOut,
    zoomIn,
    ' ',
    coords,
  ]);

  const viewer = new MapViewer<ArchiveEntry>(coords);
  viewer.element.hidden = true;

  let grouped = new Map<string, Map<string, LayerTiles<ArchiveEntry>>>();
  let waypoints: Waypoint[] = [];
  let archive: Archive | null = null;

  const showLayer = (): void => {
    const layer = grouped.get(dimSelect.value)?.get(layerSelect.value) ?? null;
    if (!archive || !layer) {
      viewer.setLayer(null, { load: () => Promise.reject(new Error('no archive')) }, []);
      return;
    }
    const current = archive;
    viewer.setLayer(
      layer,
      {
        load: (key) => {
          const file = layer.tiles.get(key);
          if (!file) return Promise.reject(new Error(`no tile ${key}`));
          return current.readBytes(file.entry);
        },
      },
      waypoints,
    );
    const shown = waypoints.filter(
      (wp) => wp.enabled && wp.dimensions.includes(Number(layer.dim.slice(3))),
    ).length;
    note.textContent = `${formatInt(layer.tiles.size)} tiles, ${formatInt(shown)} waypoints in this dimension. Drag to pan, scroll to zoom.`;
  };

  const fillLayers = (): void => {
    const layers = grouped.get(dimSelect.value);
    layerSelect.replaceChildren(
      ...[...(layers?.keys() ?? [])].map((layer) =>
        el('option', { value: layer, textContent: layerLabel(layer) }),
      ),
    );
    showLayer();
  };

  dimSelect.addEventListener('change', fillLayers);
  layerSelect.addEventListener('change', showLayer);
  fitButton.addEventListener('click', () => {
    viewer.fit();
  });
  zoomIn.addEventListener('click', () => {
    viewer.zoomBy(1.5);
  });
  zoomOut.addEventListener('click', () => {
    viewer.zoomBy(1 / 1.5);
  });

  picker.onChange(() => {
    void (async () => {
      const { archive: a, chosen } = picker.state;
      archive = a;
      grouped = new Map();
      waypoints = [];
      if (!a || !chosen) {
        controls.hidden = true;
        viewer.element.hidden = true;
        note.textContent = '';
        showLayer();
        return;
      }
      const index = indexWorld(a.entries, chosen);
      grouped = groupTiles(index);
      waypoints = await readWaypoints(a, index);
      if (archive !== a) return; // a newer pick won
      dimSelect.replaceChildren(
        ...[...grouped.keys()].map((dim) =>
          el('option', { value: dim, textContent: dimLabel(dim) }),
        ),
      );
      const hasTiles = grouped.size > 0;
      controls.hidden = !hasTiles;
      viewer.element.hidden = !hasTiles;
      if (!hasTiles) {
        note.textContent = 'This map folder has waypoints but no tiles to draw.';
        return;
      }
      fillLayers();
    })();
  });

  container.append(picker.element, note, controls, viewer.element);
}

async function readWaypoints(
  archive: Archive,
  index: ReturnType<typeof indexWorld<ArchiveEntry>>,
): Promise<Waypoint[]> {
  const out: Waypoint[] = [];
  const decoder = new TextDecoder();
  for (const file of index.files.values()) {
    if (file.classified.kind !== 'waypoint') continue;
    try {
      const json: unknown = JSON.parse(decoder.decode(await archive.readBytes(file.entry)));
      const wp = parseWaypoint(json, file.classified.id);
      if (wp) out.push(wp);
    } catch {
      // unreadable waypoint file: skip, the merge still copies it verbatim
    }
  }
  return out;
}

const DIM_NAMES: Record<string, string> = { DIM0: 'Overworld', 'DIM-1': 'Nether', DIM1: 'The End' };

function dimLabel(dim: string): string {
  const name = DIM_NAMES[dim];
  return name === undefined ? dim : `${name} (${dim})`;
}

function layerLabel(layer: string): string {
  if (layer === 'day' || layer === 'night' || layer === 'topo') return layer;
  return `cave slice ${layer}`;
}
