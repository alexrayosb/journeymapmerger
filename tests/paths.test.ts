import { describe, expect, it } from 'vitest';
import {
  classifyWorldPath,
  isSafeArchivePath,
  normalizeArchivePath,
  tileRelativePath,
} from '../src/merge/paths.ts';

describe('normalizeArchivePath', () => {
  it('keeps ordinary paths and normalizes separators and dot segments', () => {
    expect(normalizeArchivePath('DIM0/day/0,0.png')).toEqual({
      ok: true,
      path: 'DIM0/day/0,0.png',
    });
    expect(normalizeArchivePath('journeymap\\data\\mp\\x\\DIM0\\day\\0,0.png')).toEqual({
      ok: true,
      path: 'journeymap/data/mp/x/DIM0/day/0,0.png',
    });
    expect(normalizeArchivePath('./a/./b//c.json')).toEqual({ ok: true, path: 'a/b/c.json' });
    expect(normalizeArchivePath('/leading/slash.png')).toEqual({
      ok: true,
      path: 'leading/slash.png',
    });
  });

  it('rejects traversal, drive letters, control characters, directories, junk', () => {
    expect(normalizeArchivePath('../evil.png')).toEqual({ ok: false, problem: 'traversal' });
    expect(normalizeArchivePath('a/../../evil.png')).toEqual({ ok: false, problem: 'traversal' });
    expect(normalizeArchivePath('a/..\\evil.png')).toEqual({ ok: false, problem: 'traversal' });
    expect(normalizeArchivePath('C:/Users/x/evil.png')).toEqual({ ok: false, problem: 'absolute' });
    expect(normalizeArchivePath('a/b\u0000c.png')).toEqual({ ok: false, problem: 'control-chars' });
    expect(normalizeArchivePath('DIM0/day/')).toEqual({ ok: false, problem: 'directory' });
    expect(normalizeArchivePath('')).toEqual({ ok: false, problem: 'empty' });
    expect(normalizeArchivePath('/')).toEqual({ ok: false, problem: 'directory' });
    expect(normalizeArchivePath('__MACOSX/x/._0,0.png')).toEqual({ ok: false, problem: 'junk' });
    expect(normalizeArchivePath('x/.DS_Store')).toEqual({ ok: false, problem: 'junk' });
    expect(normalizeArchivePath('x/Thumbs.db')).toEqual({ ok: false, problem: 'junk' });
  });

  it('isSafeArchivePath accepts only already-normalized paths', () => {
    expect(isSafeArchivePath('merged/DIM0/day/0,0.png')).toBe(true);
    expect(isSafeArchivePath('merged/../x.png')).toBe(false);
    expect(isSafeArchivePath('/merged/x.png')).toBe(false);
    expect(isSafeArchivePath('merged//x.png')).toBe(false);
    expect(isSafeArchivePath('merged/x/')).toBe(false);
  });
});

describe('classifyWorldPath', () => {
  it('recognizes tiles in every layer kind and dimension', () => {
    expect(classifyWorldPath('DIM0/day/3,-2.png')).toEqual({
      kind: 'tile',
      tile: { dim: 'DIM0', layer: 'day', rx: 3, rz: -2 },
    });
    expect(classifyWorldPath('DIM-1/night/0,0.png').kind).toBe('tile');
    expect(classifyWorldPath('DIM1/topo/0,0.png').kind).toBe('tile');
    expect(classifyWorldPath('DIM7/day/0,0.png').kind).toBe('tile');
    expect(classifyWorldPath('DIM0/0/0,0.png').kind).toBe('tile');
    expect(classifyWorldPath('DIM0/15/0,0.png').kind).toBe('tile');
  });

  it('does not treat lookalikes as tiles', () => {
    expect(classifyWorldPath('DIM0/16/0,0.png').kind).toBe('other');
    expect(classifyWorldPath('DIM0/Day/0,0.png').kind).toBe('other');
    expect(classifyWorldPath('dim0/day/0,0.png').kind).toBe('other');
    expect(classifyWorldPath('DIM0/day/0,0.PNG').kind).toBe('other');
    expect(classifyWorldPath('DIM0/day/0,0.png.bak').kind).toBe('other');
    expect(classifyWorldPath('DIM0/day/extra/0,0.png').kind).toBe('other');
    expect(classifyWorldPath('DIM0/day/thumb.png').kind).toBe('other');
    expect(classifyWorldPath('DIMx/day/0,0.png').kind).toBe('other');
  });

  it('recognizes waypoints only directly under waypoints/', () => {
    expect(classifyWorldPath('waypoints/Home_12,64,-30.json')).toEqual({
      kind: 'waypoint',
      id: 'Home_12,64,-30',
    });
    expect(classifyWorldPath('waypoints/.json').kind).toBe('other');
    expect(classifyWorldPath('waypoints/sub/x.json').kind).toBe('other');
    expect(classifyWorldPath('waypoints/x.txt').kind).toBe('other');
    expect(classifyWorldPath('colorpalette.json').kind).toBe('other');
  });

  it('tileRelativePath round-trips', () => {
    const c = classifyWorldPath('DIM-1/day/-7,12.png');
    expect(c.kind).toBe('tile');
    if (c.kind === 'tile') expect(tileRelativePath(c.tile)).toBe('DIM-1/day/-7,12.png');
  });
});
