/**
 * Region tile file names: `<rx>,<rz>.png`, where rx/rz are signed integers
 * (region coordinates: one region = 32x32 chunks = 512x512 blocks).
 *
 * Pure module, no DOM. Used by the merge planner and the preview.
 */
export interface TileCoords {
  readonly rx: number;
  readonly rz: number;
}

const TILE_NAME = /^(-?\d+),(-?\d+)\.png$/;

/** Parse a bare file name (no directories). Returns null for anything else. */
export function parseTileName(fileName: string): TileCoords | null {
  const match = TILE_NAME.exec(fileName);
  if (!match) return null;
  const rx = Number(match[1]);
  const rz = Number(match[2]);
  if (!Number.isSafeInteger(rx) || !Number.isSafeInteger(rz)) return null;
  return { rx, rz };
}

export function tileName(coords: TileCoords): string {
  return `${String(coords.rx)},${String(coords.rz)}.png`;
}
