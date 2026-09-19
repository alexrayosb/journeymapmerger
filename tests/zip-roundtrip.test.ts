/**
 * Read → detect → plan → execute → write → re-read, on two small archives
 * that carry the realistic nastiness: different root depths and folder
 * names, a deflated entry, junk, a '..' entry, a duplicate path, a shared
 * waypoint with different content. Verified with zip.js AND Info-ZIP.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { detectWorldRoots } from '../src/merge/detect.ts';
import { buildMergePlan } from '../src/merge/plan.ts';
import { indexWorld } from '../src/merge/world-index.ts';
import { openArchive, type Archive } from '../src/zip/reader.ts';
import { ArchiveWriter } from '../src/zip/writer.ts';
import { executeMergePlan } from '../src/workers/pipeline.ts';
import { BlobWriter } from '@zip.js/zip.js';
import { CLEAR, makePng, readPixels, type Rgba } from './helpers/png.ts';
import { sharpCompositor } from './helpers/sharp-compositor.ts';
import {
  buildZip,
  daysBefore,
  hasInfoZip,
  infoZipInspect,
  patchNames,
  text,
  toBlob,
} from './helpers/zip-fixtures.ts';

const RED: Rgba = [255, 0, 0, 255];
const BLUE: Rgba = [0, 0, 255, 255];
const GREEN: Rgba = [0, 255, 0, 255];
const A_ROOT = 'journeymap/data/mp/GTNH~Server~1/';
const B_ROOT = 'our~gtnh~world~10~0~0~5~/';

let zipA: Uint8Array;
let zipB: Uint8Array;
let tileA: Uint8Array;
let tileB: Uint8Array;
let onlyA: Uint8Array;

beforeAll(async () => {
  tileA = await makePng(16, 16, (x) => (x < 8 ? RED : CLEAR));
  tileB = await makePng(16, 16, (x, y) => (x === 0 && y === 0 ? GREEN : x >= 8 ? BLUE : CLEAR));
  onlyA = await makePng(16, 16, () => RED);
  const dupFirst = await makePng(4, 4, () => RED);
  const dupLast = await makePng(4, 4, () => BLUE);

  const rawA = await buildZip([
    { path: 'journeymap/', directory: true },
    { path: `${A_ROOT}DIM0/day/0,0.png`, data: tileA, mtime: daysBefore(5) },
    { path: `${A_ROOT}DIM0/day/1,0.png`, data: onlyA, level: 6 }, // deflated pass-through
    { path: `${A_ROOT}DIM0/day/9,9.png`, data: dupFirst },
    { path: `${A_ROOT}DIM0/day/9,8.png`, data: dupLast }, // patched below into a duplicate of 9,9
    { path: `${A_ROOT}waypoints/Home_1,2,3.json`, data: text('{"name":"Home","from":"A"}') },
    { path: `${A_ROOT}colorpalette.json`, data: text('{}') },
    { path: '__MACOSX/._junk.png', data: text('junk') },
    { path: 'ZS/evil.png', data: text('evil') }, // patched below into ../evil.png
  ]);
  zipA = patchNames(
    patchNames(rawA, `${A_ROOT}DIM0/day/9,8.png`, `${A_ROOT}DIM0/day/9,9.png`),
    'ZS/evil.png',
    '../evil.png',
  );

  zipB = await buildZip([
    { path: `${B_ROOT}DIM0/day/0,0.png`, data: tileB, mtime: daysBefore(1) },
    { path: `${B_ROOT}DIM0/day/0,1.png`, data: tileB },
    { path: `${B_ROOT}waypoints/Home_1,2,3.json`, data: text('{"name":"Home","from":"B"}') },
    { path: `${B_ROOT}waypoints/Base_4,5,6.json`, data: text('{"name":"Base"}') },
  ]);
});

async function merge(priority: 'auto' | 'a' | 'b') {
  const a = await openArchive(toBlob(zipA), 'A.zip');
  const b = await openArchive(toBlob(zipB), 'B.zip');
  const rootA = detectWorldRoots(a.entries)[0];
  const rootB = detectWorldRoots(b.entries)[0];
  if (!rootA || !rootB) throw new Error('roots not detected');
  const plan = buildMergePlan(indexWorld(a.entries, rootA), indexWorld(b.entries, rootB), {
    priority,
  });
  const writer = new ArchiveWriter(new BlobWriter('application/zip'));
  const progress: number[] = [];
  const result = await executeMergePlan(plan, { a, b }, writer, {
    compositor: sharpCompositor,
    onProgress: (p) => progress.push(p.done),
  });
  const blob = await writer.close();
  if (!blob) throw new Error('no output blob');
  await a.close();
  await b.close();
  return { a, b, plan, result, progress, out: new Uint8Array(await blob.arrayBuffer()) };
}

const EXPECTED_OUTPUT = [
  'GTNH~Server~1/DIM0/day/0,0.png',
  'GTNH~Server~1/DIM0/day/0,1.png',
  'GTNH~Server~1/DIM0/day/1,0.png',
  'GTNH~Server~1/DIM0/day/9,9.png',
  'GTNH~Server~1/colorpalette.json',
  'GTNH~Server~1/waypoints/Base_4,5,6.json',
  'GTNH~Server~1/waypoints/Home_1,2,3.json',
];

describe('zip round trip', () => {
  it('reads both archives, skipping junk, directories and traversal entries', async () => {
    const a = await openArchive(toBlob(zipA), 'A.zip');
    expect(a.skipped.map((s) => `${s.reason}:${s.path}`).sort()).toEqual([
      'directory:journeymap/',
      'junk:__MACOSX/._junk.png',
      'traversal:../evil.png',
    ]);
    expect(a.entries.map((e) => e.path)).not.toContain('../evil.png');
    const roots = detectWorldRoots(a.entries);
    expect(roots).toHaveLength(1);
    expect(roots[0]).toMatchObject({ name: 'GTNH~Server~1', tiles: 4, waypoints: 1, others: 1 });
    await a.close();
  });

  it("writes exactly the union under A's folder name, and the output re-reads cleanly", async () => {
    const { plan, result, progress, out } = await merge('auto');
    expect(plan.outputRoot).toBe('GTNH~Server~1');
    expect(result).toMatchObject({ written: 7, copied: 6, composited: 1, compositeFailures: [] });
    expect(progress.at(-1)).toBe(7);

    const reread: Archive = await openArchive(toBlob(out), 'out.zip');
    expect(reread.entries.map((e) => e.path).sort()).toEqual(EXPECTED_OUTPUT);
    expect(reread.skipped).toEqual([]);
    await reread.close();
  });

  it.skipIf(!hasInfoZip())('is a valid archive according to Info-ZIP (external tool)', async () => {
    const { out } = await merge('auto');
    const { testOutput, names } = infoZipInspect(out);
    expect(testOutput).toContain('No errors detected');
    expect(names).toEqual(EXPECTED_OUTPUT);
  });

  it('composites newer over older and never makes an explored pixel transparent', async () => {
    const { out } = await merge('auto');
    const reread = await openArchive(toBlob(out));
    const entry = reread.entries.find((e) => e.path.endsWith('/0,0.png'));
    if (!entry) throw new Error('composite missing');
    const px = await readPixels(await reread.readBytes(entry));
    const pa = await readPixels(tileA);
    const pb = await readPixels(tileB);
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        const o = px.at(x, y);
        const a = pa.at(x, y);
        const b = pb.at(x, y);
        expect(o[3]).toBeGreaterThanOrEqual(Math.max(a[3], b[3]));
        if (b[3] === 255) expect(o).toEqual(b);
        else if (a[3] === 255) expect(o).toEqual(a);
        else expect(o[3]).toBe(0);
      }
    }
    expect(px.at(0, 0)).toEqual(GREEN);
    expect(px.at(3, 3)).toEqual(RED);
    expect(px.at(12, 3)).toEqual(BLUE);
    await reread.close();
  });

  it('lets a forced priority put the older tile on top', async () => {
    const { out } = await merge('a');
    const reread = await openArchive(toBlob(out));
    const entry = reread.entries.find((e) => e.path.endsWith('/0,0.png'));
    if (!entry) throw new Error('composite missing');
    const px = await readPixels(await reread.readBytes(entry));
    expect(px.at(0, 0)).toEqual(RED); // A drawn over B's green pixel
    expect(px.at(12, 3)).toEqual(BLUE); // B still fills what A left transparent
    await reread.close();
  });

  it('copies pass-through entries byte-for-byte, keeps the shared waypoint from A, last duplicate wins', async () => {
    const { out } = await merge('auto');
    const reread = await openArchive(toBlob(out));
    const byPath = new Map(reread.entries.map((e) => [e.path, e]));
    const get = async (p: string) => {
      const e = byPath.get(p);
      if (!e) throw new Error(`missing ${p}`);
      return reread.readBytes(e);
    };
    expect(await get('GTNH~Server~1/DIM0/day/1,0.png')).toEqual(onlyA);
    expect(byPath.get('GTNH~Server~1/DIM0/day/1,0.png')?.handle.compressionMethod).toBe(8); // still deflated
    expect(
      new TextDecoder().decode(await get('GTNH~Server~1/waypoints/Home_1,2,3.json')),
    ).toContain('"from":"A"');
    const dup = await readPixels(await get('GTNH~Server~1/DIM0/day/9,9.png'));
    expect(dup.at(0, 0)).toEqual(BLUE);
    expect(byPath.get('GTNH~Server~1/DIM0/day/0,0.png')?.mtime).toBe(daysBefore(1).getTime());
    expect(byPath.get('GTNH~Server~1/DIM0/day/1,0.png')?.mtime).toBe(daysBefore(0).getTime());
    await reread.close();
  });

  it('stops promptly when cancelled', async () => {
    const a = await openArchive(toBlob(zipA));
    const b = await openArchive(toBlob(zipB));
    const rootA = detectWorldRoots(a.entries)[0];
    const rootB = detectWorldRoots(b.entries)[0];
    if (!rootA || !rootB) throw new Error('roots');
    const plan = buildMergePlan(indexWorld(a.entries, rootA), indexWorld(b.entries, rootB), {
      priority: 'auto',
    });
    const writer = new ArchiveWriter(new BlobWriter());
    const controller = new AbortController();
    controller.abort();
    await expect(
      executeMergePlan(plan, { a, b }, writer, {
        compositor: sharpCompositor,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    await writer.close();
    await a.close();
    await b.close();
  });
});
