import { describe, expect, it } from 'vitest';
import { parseTileName, tileName } from '../src/merge/tile-name.ts';

describe('parseTileName', () => {
  it('parses positive and negative region coordinates', () => {
    expect(parseTileName('0,0.png')).toEqual({ rx: 0, rz: 0 });
    expect(parseTileName('-3,12.png')).toEqual({ rx: -3, rz: 12 });
    expect(parseTileName('7,-1.png')).toEqual({ rx: 7, rz: -1 });
  });

  it('rejects anything that is not a bare tile file name', () => {
    expect(parseTileName('day/0,0.png')).toBeNull();
    expect(parseTileName('0,0.PNG')).toBeNull();
    expect(parseTileName('0.0.png')).toBeNull();
    expect(parseTileName('a,b.png')).toBeNull();
    expect(parseTileName('0,0.png.bak')).toBeNull();
    expect(parseTileName('')).toBeNull();
  });

  it('round-trips through tileName', () => {
    for (const name of ['0,0.png', '-15,4.png', '100,-100.png']) {
      const coords = parseTileName(name);
      expect(coords).not.toBeNull();
      if (coords) expect(tileName(coords)).toBe(name);
    }
  });
});
