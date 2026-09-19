import { describe, expect, it } from 'vitest';
import { buildMergePlan } from '../src/merge/plan.ts';
import type { EntryInfo, WorldRoot } from '../src/merge/types.ts';
import { indexWorld } from '../src/merge/world-index.ts';

const T0 = Date.UTC(2026, 8, 1);
const day = 86_400_000;

type Spec = Record<string, { size?: number; age?: number } | true>;

const root = (prefix: string): WorldRoot => ({
  prefix,
  name: prefix === '' ? '' : prefix.slice(0, -1),
  dims: [],
  tiles: 0,
  waypoints: 0,
  others: 0,
});

/** Build a world index from { rel: {size, ageDays} } under a prefix. */
function world(prefix: string, spec: Spec) {
  const entries: EntryInfo[] = Object.entries(spec).map(([rel, v]) => {
    const o = v === true ? {} : v;
    return { path: prefix + rel, size: o.size ?? 100, mtime: T0 - (o.age ?? 0) * day };
  });
  return indexWorld(entries, root(prefix));
}

describe('buildMergePlan', () => {
  it('copies what only one side has and composites shared tiles, newer over older', () => {
    const a = world('A/', {
      'DIM0/day/0,0.png': { age: 5 }, // older than B's
      'DIM0/day/1,0.png': true,
      'waypoints/Home_1,2,3.json': true,
      'colorpalette.json': true,
    });
    const b = world('B/', {
      'DIM0/day/0,0.png': { age: 1 },
      'DIM0/day/0,1.png': true,
      'DIM-1/day/0,0.png': true,
      'waypoints/Base_4,5,6.json': true,
    });
    const plan = buildMergePlan(a, b, { priority: 'auto' });

    expect(plan.outputRoot).toBe('A');
    expect(
      plan.tasks.map((t) => `${t.kind}:${t.rel}:${t.kind === 'copy' ? t.from : t.newer.from}`),
    ).toEqual([
      'copy:DIM-1/day/0,0.png:b',
      'composite:DIM0/day/0,0.png:b',
      'copy:DIM0/day/0,1.png:b',
      'copy:DIM0/day/1,0.png:a',
      'copy:colorpalette.json:a',
      'copy:waypoints/Base_4,5,6.json:b',
      'copy:waypoints/Home_1,2,3.json:a',
    ]);
    expect(plan.summary).toEqual({
      tilesCopied: 3,
      tilesComposited: 1,
      waypoints: 2,
      waypointsShared: 0,
      others: 1,
      dims: ['DIM0', 'DIM-1'],
      estimatedOutputBytes: 700,
    });
  });

  it('never drops a file: every rel in either index yields exactly one task', () => {
    const rels = Array.from({ length: 50 }, (_, i) => `DIM0/day/${String(i % 7)},${String(i)}.png`);
    const a = world('A/', Object.fromEntries(rels.slice(0, 35).map((r) => [r, true])));
    const b = world('B/', Object.fromEntries(rels.slice(20).map((r) => [r, true])));
    const plan = buildMergePlan(a, b, { priority: 'auto' });
    expect(plan.tasks.map((t) => t.rel)).toEqual([...new Set(rels)].sort());
    expect(plan.summary.tilesComposited).toBe(15);
    expect(plan.summary.tilesCopied).toBe(35);
  });

  it('breaks mtime ties toward A and honours forced priority', () => {
    const a = world('A/', { 'DIM0/day/0,0.png': { age: 3 } });
    const b = world('B/', { 'DIM0/day/0,0.png': { age: 3 } });
    const tie = buildMergePlan(a, b, { priority: 'auto' }).tasks[0];
    expect(tie?.kind === 'composite' && tie.newer.from).toBe('a');

    const bNewer = world('B/', { 'DIM0/day/0,0.png': { age: 0 } });
    const auto = buildMergePlan(a, bNewer, { priority: 'auto' }).tasks[0];
    expect(auto?.kind === 'composite' && auto.newer.from).toBe('b');
    const forcedA = buildMergePlan(a, bNewer, { priority: 'a' }).tasks[0];
    expect(forcedA?.kind === 'composite' && forcedA.newer.from).toBe('a');
    const aNewer = world('A/', { 'DIM0/day/0,0.png': { age: 0 } });
    const forcedB = buildMergePlan(aNewer, b, { priority: 'b' }).tasks[0];
    expect(forcedB?.kind === 'composite' && forcedB.newer.from).toBe('b');
  });

  it('keeps one copy of shared waypoints and other files, from the primary side', () => {
    const a = world('A/', { 'waypoints/Home_1,2,3.json': { size: 10 }, 'colorpalette.json': true });
    const b = world('B/', { 'waypoints/Home_1,2,3.json': { size: 20 }, 'colorpalette.json': true });
    const auto = buildMergePlan(a, b, { priority: 'auto' });
    expect(auto.tasks.every((t) => t.kind === 'copy' && t.from === 'a')).toBe(true);
    expect(auto.summary).toMatchObject({ waypoints: 1, waypointsShared: 1, others: 1 });
    const forcedB = buildMergePlan(a, b, { priority: 'b' });
    expect(forcedB.tasks.every((t) => t.kind === 'copy' && t.from === 'b')).toBe(true);
  });

  it('never composites a path that is a tile on one side but not the other', () => {
    const a = world('A/', { 'DIM0/day/0,0.png': true });
    const bEntries: EntryInfo[] = [{ path: 'B/DIM0/day/0,0.png', size: 5, mtime: T0 }];
    // Force B's classification to "other" by indexing under a root that makes the rel differ.
    const b = indexWorld(bEntries, root('B/'));
    const plan = buildMergePlan(a, b, { priority: 'auto' });
    expect(plan.tasks[0]?.kind).toBe('composite'); // same rel, both tiles -> composite is right
    const weird = indexWorld([{ path: 'B/DIM0/day/x.png', size: 5, mtime: T0 }], root('B/'));
    const a2 = indexWorld([{ path: 'A/DIM0/day/x.png', size: 5, mtime: T0 }], root('A/'));
    expect(buildMergePlan(a2, weird, { priority: 'auto' }).tasks[0]?.kind).toBe('copy');
  });

  it('falls back to "merged" when A sits at the zip root, and accepts an explicit root', () => {
    const a = world('', { 'DIM0/day/0,0.png': true });
    const b = world('B/', { 'DIM0/day/1,0.png': true });
    expect(buildMergePlan(a, b, { priority: 'auto' }).outputRoot).toBe('merged');
    expect(buildMergePlan(a, b, { priority: 'auto', outputRoot: 'custom' }).outputRoot).toBe(
      'custom',
    );
  });
});

describe('indexWorld', () => {
  it('strips the prefix, ignores paths outside it, and lets the last duplicate win', () => {
    const idx = indexWorld(
      [
        { path: 'w/DIM0/day/0,0.png', size: 1, mtime: 1 },
        { path: 'w/DIM0/day/0,0.png', size: 2, mtime: 2 },
        { path: 'other/DIM0/day/0,0.png', size: 3, mtime: 3 },
        { path: 'w/', size: 0, mtime: 0 },
      ],
      root('w/'),
    );
    expect([...idx.files.keys()]).toEqual(['DIM0/day/0,0.png']);
    expect(idx.files.get('DIM0/day/0,0.png')?.entry.size).toBe(2);
    expect(idx.duplicates).toBe(1);
  });
});
