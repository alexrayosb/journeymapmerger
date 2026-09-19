/**
 * Archive path hygiene and JourneyMap path classification. Pure.
 *
 * Every path read from a zip goes through `normalizeArchivePath` before
 * anything else looks at it; every path written goes through it again.
 * That is the zip-slip defence: nothing with '..', an absolute prefix, or
 * control characters is ever indexed or written.
 */
import { parseTileName, tileName } from './tile-name.ts';
import type { Classified, TileRef } from './types.ts';

export type PathProblem =
  'directory' | 'empty' | 'traversal' | 'absolute' | 'control-chars' | 'junk';

export type NormalizedPath =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly problem: PathProblem };

const JUNK_TOP = new Set(['__MACOSX']);
const JUNK_FILE = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const DRIVE_PREFIX = /^[A-Za-z]:/;

export function normalizeArchivePath(raw: string): NormalizedPath {
  if (CONTROL_CHARS.test(raw)) return { ok: false, problem: 'control-chars' };
  const slashed = raw.replace(/\\/g, '/');
  if (DRIVE_PREFIX.test(slashed)) return { ok: false, problem: 'absolute' };
  if (slashed.endsWith('/')) return { ok: false, problem: 'directory' };
  const segments: string[] = [];
  for (const segment of slashed.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') return { ok: false, problem: 'traversal' };
    segments.push(segment);
  }
  if (segments.length === 0) return { ok: false, problem: 'empty' };
  const first = segments[0];
  const last = segments[segments.length - 1];
  if ((first !== undefined && JUNK_TOP.has(first)) || (last !== undefined && JUNK_FILE.has(last))) {
    return { ok: false, problem: 'junk' };
  }
  return { ok: true, path: segments.join('/') };
}

/** True for an already-normalized path (round-trips through normalizeArchivePath). */
export function isSafeArchivePath(path: string): boolean {
  const n = normalizeArchivePath(path);
  return n.ok && n.path === path;
}

export const DIM_NAME = /^DIM-?\d+$/;
const LAYER_NAME = /^(day|night|topo|[0-9]|1[0-5])$/;
export const WAYPOINTS_DIR = 'waypoints';

export function isDimName(segment: string): boolean {
  return DIM_NAME.test(segment);
}

export function isLayerName(segment: string): boolean {
  return LAYER_NAME.test(segment);
}

/** Classify a path relative to a world root. */
export function classifyWorldPath(rel: string): Classified {
  const segments = rel.split('/');
  if (segments.length === 3) {
    const [dim, layer, file] = segments;
    if (
      dim !== undefined &&
      layer !== undefined &&
      file !== undefined &&
      isDimName(dim) &&
      isLayerName(layer)
    ) {
      const coords = parseTileName(file);
      if (coords) return { kind: 'tile', tile: { dim, layer, rx: coords.rx, rz: coords.rz } };
    }
  } else if (segments.length === 2) {
    const [dir, file] = segments;
    if (dir === WAYPOINTS_DIR && file !== undefined && file.endsWith('.json') && file.length > 5) {
      return { kind: 'waypoint', id: file.slice(0, -5) };
    }
  }
  return { kind: 'other' };
}

export function tileRelativePath(tile: TileRef): string {
  return `${tile.dim}/${tile.layer}/${tileName({ rx: tile.rx, rz: tile.rz })}`;
}
