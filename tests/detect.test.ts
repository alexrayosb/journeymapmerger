import { describe, expect, it } from 'vitest';
import { compareDims, detectWorldRoots } from '../src/merge/detect.ts';
import type { EntryInfo } from '../src/merge/types.ts';

const e = (path: string): EntryInfo => ({ path, size: 1, mtime: 0 });

describe('detectWorldRoots', () => {
  it('finds a world nested under journeymap/data/mp/<name>/', () => {
    const roots = detectWorldRoots([
      e('journeymap/data/mp/GTNH~Server~1/DIM0/day/0,0.png'),
      e('journeymap/data/mp/GTNH~Server~1/DIM0/night/0,0.png'),
      e('journeymap/data/mp/GTNH~Server~1/DIM-1/day/0,0.png'),
      e('journeymap/data/mp/GTNH~Server~1/waypoints/Home_1,2,3.json'),
      e('journeymap/data/mp/GTNH~Server~1/colorpalette.json'),
      e('journeymap/config/journeymap.core.config'),
    ]);
    expect(roots).toEqual([
      {
        prefix: 'journeymap/data/mp/GTNH~Server~1/',
        name: 'GTNH~Server~1',
        dims: ['DIM0', 'DIM-1'],
        tiles: 3,
        waypoints: 1,
        others: 1,
      },
    ]);
  });

  it('finds a world zipped as its own folder, and one at the zip root', () => {
    expect(detectWorldRoots([e('our~gtnh~world~10~0~0~5~/DIM0/day/0,0.png')])[0]).toMatchObject({
      prefix: 'our~gtnh~world~10~0~0~5~/',
      name: 'our~gtnh~world~10~0~0~5~',
      tiles: 1,
    });
    expect(detectWorldRoots([e('DIM0/day/0,0.png'), e('waypoints/a.json')])[0]).toMatchObject({
      prefix: '',
      name: '',
      tiles: 1,
      waypoints: 1,
    });
  });

  it('ranks several worlds by tile count and lists them all', () => {
    const roots = detectWorldRoots([
      e('journeymap/data/mp/small/DIM0/day/0,0.png'),
      e('journeymap/data/mp/big/DIM0/day/0,0.png'),
      e('journeymap/data/mp/big/DIM0/day/1,0.png'),
      e('journeymap/data/sp/New World/DIM0/day/0,0.png'),
      e('journeymap/data/sp/New World/DIM0/3/0,0.png'),
      e('journeymap/data/sp/New World/DIM0/3/1,0.png'),
    ]);
    expect(roots.map((r) => r.name)).toEqual(['New World', 'big', 'small']);
  });

  it('returns nothing for archives without JourneyMap data', () => {
    expect(detectWorldRoots([e('README.txt'), e('photos/cat.png'), e('DIM0')])).toEqual([]);
    expect(detectWorldRoots([])).toEqual([]);
  });

  it('counts non-tile files under a DIM as others, and a waypoints-only world', () => {
    const roots = detectWorldRoots([
      e('w/DIM0/day/notes.txt'),
      e('w/DIM0/stray.png'),
      e('w/waypoints/a.json'),
      e('w/waypoints/nested/b.json'),
    ]);
    expect(roots).toEqual([
      { prefix: 'w/', name: 'w', dims: ['DIM0'], tiles: 0, waypoints: 1, others: 3 },
    ]);
    expect(detectWorldRoots([e('w/waypoints/a.json')])[0]).toMatchObject({
      tiles: 0,
      waypoints: 1,
    });
  });

  it('assigns unanchored files to the deepest enclosing root only', () => {
    const roots = detectWorldRoots([
      e('a/DIM0/day/0,0.png'),
      e('a/b/DIM0/day/0,0.png'),
      e('a/b/colorpalette.json'),
      e('a/colorpalette.json'),
      e('elsewhere/readme.txt'),
    ]);
    expect(roots.find((r) => r.prefix === 'a/b/')?.others).toBe(1);
    expect(roots.find((r) => r.prefix === 'a/')?.others).toBe(1);
  });
});

describe('compareDims', () => {
  it('orders DIM0 first, then by numeric id', () => {
    expect(['DIM7', 'DIM-1', 'DIM1', 'DIM0', 'DIM-11'].sort(compareDims)).toEqual([
      'DIM0',
      'DIM-11',
      'DIM-1',
      'DIM1',
      'DIM7',
    ]);
  });
});
