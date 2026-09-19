import { describe, expect, it } from 'vitest';
import {
  compareLayers,
  groupTiles,
  parseWaypoint,
  waypointInDim,
  waypointMapPosition,
} from '../src/merge/tiles.ts';
import type { EntryInfo, WorldRoot } from '../src/merge/types.ts';
import { indexWorld } from '../src/merge/world-index.ts';

const root: WorldRoot = { prefix: 'w/', name: 'w', dims: [], tiles: 0, waypoints: 0, others: 0 };
const e = (path: string): EntryInfo => ({ path: `w/${path}`, size: 1, mtime: 0 });

describe('groupTiles', () => {
  it('groups by dimension then layer with bounds, ignoring non-tiles', () => {
    const idx = indexWorld(
      [
        e('DIM0/day/0,0.png'),
        e('DIM0/day/3,-2.png'),
        e('DIM0/night/0,0.png'),
        e('DIM0/3/1,1.png'),
        e('DIM0/topo/0,0.png'),
        e('DIM-1/day/-1,-1.png'),
        e('DIM7/day/5,5.png'),
        e('waypoints/a.json'),
        e('colorpalette.json'),
      ],
      root,
    );
    const grouped = groupTiles(idx);
    expect([...grouped.keys()]).toEqual(['DIM0', 'DIM-1', 'DIM7']);
    const dim0 = grouped.get('DIM0');
    expect([...(dim0?.keys() ?? [])]).toEqual(['day', 'night', 'topo', '3']);
    const day = dim0?.get('day');
    expect(day?.tiles.size).toBe(2);
    expect(day?.bounds).toEqual({ minX: 0, maxX: 3, minZ: -2, maxZ: 0 });
    expect(day?.tiles.get('3,-2')?.tile).toEqual({ dim: 'DIM0', layer: 'day', rx: 3, rz: -2 });
  });

  it('orders layers day, night, topo, then slices numerically', () => {
    expect(['15', 'topo', '2', 'night', 'day', '0'].sort(compareLayers)).toEqual([
      'day',
      'night',
      'topo',
      '0',
      '2',
      '15',
    ]);
  });
});

describe('waypoints', () => {
  const json = {
    id: 'Home_12,64,-30',
    name: 'Home',
    icon: 'waypoint-normal.png',
    x: 12,
    y: 64,
    z: -30,
    r: 255,
    g: 0,
    b: 0,
    enable: true,
    type: 'Normal',
    origin: 'JourneyMap',
    dimensions: [0],
  };

  it('parses the JourneyMap 5.x fields and defaults the rest', () => {
    expect(parseWaypoint(json, 'fallback')).toEqual({
      id: 'Home_12,64,-30',
      name: 'Home',
      x: 12,
      y: 64,
      z: -30,
      color: [255, 0, 0],
      enabled: true,
      dimensions: [0],
    });
    expect(parseWaypoint({ x: 1, z: 2 }, 'file-id')).toMatchObject({
      id: 'file-id',
      name: 'file-id',
      y: 64,
      color: [255, 255, 255],
      enabled: true,
      dimensions: [0],
    });
  });

  it('rejects documents without coordinates', () => {
    expect(parseWaypoint(null, 'x')).toBeNull();
    expect(parseWaypoint('str', 'x')).toBeNull();
    expect(parseWaypoint({ name: 'no coords' }, 'x')).toBeNull();
    expect(parseWaypoint({ x: '1', z: 2 }, 'x')).toBeNull();
  });

  it('places nether waypoints at stored coordinates divided by 8, others as stored', () => {
    const nether = parseWaypoint({ ...json, x: 800, z: -160, dimensions: [-1] }, 'x');
    if (!nether) throw new Error('parse failed');
    expect(waypointMapPosition(nether, 'DIM-1')).toEqual({ x: 100, z: -20 });
    expect(waypointMapPosition(nether, 'DIM0')).toEqual({ x: 800, z: -160 });
    expect(waypointInDim(nether, 'DIM-1')).toBe(true);
    expect(waypointInDim(nether, 'DIM0')).toBe(false);
  });
});
