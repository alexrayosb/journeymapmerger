/**
 * Grouping tiles by dimension and layer, and reading waypoints. Pure.
 */
import { compareDims } from './detect.ts';
import type { EntryInfo, IndexedFile, TileRef, WorldIndex } from './types.ts';

export const TILE_BLOCKS = 512;

export const tileKey = (rx: number, rz: number): string => `${String(rx)},${String(rz)}`;

export interface LayerTiles<E extends EntryInfo = EntryInfo> {
  readonly dim: string;
  readonly layer: string;
  /** key "rx,rz" → the tile file */
  readonly tiles: ReadonlyMap<string, IndexedFile<E> & { readonly tile: TileRef }>;
  /** Region-coordinate bounds, inclusive. */
  readonly bounds: {
    readonly minX: number;
    readonly maxX: number;
    readonly minZ: number;
    readonly maxZ: number;
  };
}

/** dim → layer → tiles, dims in JourneyMap order, layers day/night/topo then cave slices. */
export function groupTiles<E extends EntryInfo>(
  index: WorldIndex<E>,
): Map<string, Map<string, LayerTiles<E>>> {
  const acc = new Map<string, Map<string, Map<string, IndexedFile<E> & { tile: TileRef }>>>();
  for (const file of index.files.values()) {
    if (file.classified.kind !== 'tile') continue;
    const { tile } = file.classified;
    let layers = acc.get(tile.dim);
    if (!layers) {
      layers = new Map();
      acc.set(tile.dim, layers);
    }
    let tiles = layers.get(tile.layer);
    if (!tiles) {
      tiles = new Map();
      layers.set(tile.layer, tiles);
    }
    tiles.set(tileKey(tile.rx, tile.rz), { ...file, tile });
  }

  const result = new Map<string, Map<string, LayerTiles<E>>>();
  for (const dim of [...acc.keys()].sort(compareDims)) {
    const layers = acc.get(dim);
    if (!layers) continue;
    const out = new Map<string, LayerTiles<E>>();
    for (const layer of [...layers.keys()].sort(compareLayers)) {
      const tiles = layers.get(layer);
      if (!tiles) continue;
      let minX = Infinity;
      let maxX = -Infinity;
      let minZ = Infinity;
      let maxZ = -Infinity;
      for (const { tile } of tiles.values()) {
        minX = Math.min(minX, tile.rx);
        maxX = Math.max(maxX, tile.rx);
        minZ = Math.min(minZ, tile.rz);
        maxZ = Math.max(maxZ, tile.rz);
      }
      out.set(layer, { dim, layer, tiles, bounds: { minX, maxX, minZ, maxZ } });
    }
    result.set(dim, out);
  }
  return result;
}

const LAYER_ORDER = ['day', 'night', 'topo'];

export function compareLayers(x: string, y: string): number {
  const ix = LAYER_ORDER.indexOf(x);
  const iy = LAYER_ORDER.indexOf(y);
  if (ix >= 0 || iy >= 0) return (ix < 0 ? 99 : ix) - (iy < 0 ? 99 : iy);
  return Number(x) - Number(y);
}

export interface Waypoint {
  readonly id: string;
  readonly name: string;
  /** Stored coordinates, as JourneyMap keeps them (overworld scale). */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly color: readonly [number, number, number];
  readonly enabled: boolean;
  /** Dimension ids the waypoint shows in, e.g. [0] or [-1]. */
  readonly dimensions: readonly number[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const num = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;

/** Parse one waypoint JSON document. Returns null when x/z are missing. */
export function parseWaypoint(json: unknown, fallbackId: string): Waypoint | null {
  if (!isRecord(json)) return null;
  const x = json['x'];
  const z = json['z'];
  if (typeof x !== 'number' || typeof z !== 'number') return null;
  const dimsRaw = json['dimensions'];
  const dimensions = Array.isArray(dimsRaw)
    ? dimsRaw.filter((d): d is number => typeof d === 'number' && Number.isInteger(d))
    : [];
  const id = typeof json['id'] === 'string' ? json['id'] : fallbackId;
  const name = typeof json['name'] === 'string' && json['name'] !== '' ? json['name'] : id;
  return {
    id,
    name,
    x,
    y: num(json['y'], 64),
    z,
    color: [
      clampByte(num(json['r'], 255)),
      clampByte(num(json['g'], 255)),
      clampByte(num(json['b'], 255)),
    ],
    enabled: json['enable'] !== false,
    dimensions: dimensions.length > 0 ? dimensions : [0],
  };
}

const clampByte = (v: number): number => Math.max(0, Math.min(255, Math.round(v)));

/** Numeric dimension id of a DIM folder name ("DIM-1" → -1). */
export const dimId = (dim: string): number => Number(dim.slice(3));

/**
 * Where a waypoint sits on the map of a dimension, in block coordinates.
 * JourneyMap stores nether waypoints at overworld scale (x and z times 8)
 * and divides by 8 when drawing the nether, so we do the same.
 */
export function waypointMapPosition(wp: Waypoint, dim: string): { x: number; z: number } {
  return dimId(dim) === -1 ? { x: wp.x / 8, z: wp.z / 8 } : { x: wp.x, z: wp.z };
}

export const waypointInDim = (wp: Waypoint, dim: string): boolean =>
  wp.dimensions.includes(dimId(dim));
