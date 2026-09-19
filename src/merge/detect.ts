/**
 * World-folder detection. Pure.
 *
 * A JourneyMap world folder is whatever directory holds `DIM*` folders
 * and/or a `waypoints` folder. People zip at every depth (`journeymap/`,
 * `journeymap/data/mp/<name>/`, the world folder itself, even the DIM
 * level), and the folder name is the player's own server-list text with
 * non-word runs replaced by `~`, so two players' folders rarely match.
 * This module finds every candidate and ranks them; the caller (or the
 * user) picks.
 */
import { WAYPOINTS_DIR, isDimName } from './paths.ts';
import type { EntryInfo, WorldRoot } from './types.ts';

interface Tally {
  dims: Set<string>;
  tiles: number;
  waypoints: number;
  others: number;
}

/** Index of the anchor segment (a DIM folder or `waypoints`), or -1. */
function anchorIndex(segments: readonly string[]): number {
  return segments.findIndex((s) => isDimName(s) || s === WAYPOINTS_DIR);
}

export function detectWorldRoots(entries: readonly EntryInfo[]): WorldRoot[] {
  const tallies = new Map<string, Tally>();
  const unanchored: string[] = [];

  for (const entry of entries) {
    const segments = entry.path.split('/');
    const anchor = anchorIndex(segments);
    if (anchor < 0 || anchor === segments.length - 1) {
      unanchored.push(entry.path);
      continue;
    }
    const prefix = anchor === 0 ? '' : segments.slice(0, anchor).join('/') + '/';
    let tally = tallies.get(prefix);
    if (!tally) {
      tally = { dims: new Set(), tiles: 0, waypoints: 0, others: 0 };
      tallies.set(prefix, tally);
    }
    const anchorSegment = segments[anchor];
    if (anchorSegment === WAYPOINTS_DIR) {
      if (segments.length === anchor + 2) tally.waypoints++;
      else tally.others++;
    } else if (anchorSegment !== undefined) {
      tally.dims.add(anchorSegment);
      if (segments.length === anchor + 3 && segments[anchor + 2]?.endsWith('.png')) tally.tiles++;
      else tally.others++;
    }
  }

  // Files with no DIM/waypoints anchor (colorpalette.json, stray notes...)
  // belong to the deepest candidate root whose prefix they sit under.
  const prefixes = [...tallies.keys()].sort((x, y) => y.length - x.length);
  for (const path of unanchored) {
    const owner = prefixes.find((p) => path.startsWith(p));
    if (owner !== undefined) {
      const tally = tallies.get(owner);
      if (tally) tally.others++;
    }
  }

  const roots: WorldRoot[] = [...tallies.entries()].map(([prefix, t]) => ({
    prefix,
    name: prefix === '' ? '' : (prefix.slice(0, -1).split('/').pop() ?? ''),
    dims: [...t.dims].sort(compareDims),
    tiles: t.tiles,
    waypoints: t.waypoints,
    others: t.others,
  }));
  roots.sort(
    (x, y) => y.tiles - x.tiles || y.waypoints - x.waypoints || x.prefix.localeCompare(y.prefix),
  );
  return roots;
}

/** DIM0 first, then by numeric id: DIM-1, DIM1, DIM7... */
export function compareDims(x: string, y: string): number {
  const nx = Number(x.slice(3));
  const ny = Number(y.slice(3));
  if (nx === 0 || ny === 0) return nx === ny ? 0 : nx === 0 ? -1 : 1;
  return nx - ny || x.localeCompare(y);
}
