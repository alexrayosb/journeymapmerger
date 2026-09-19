/** Hostile and broken inputs: never a hang, never a silent loss, never an escape. */
import { randomBytes } from 'node:crypto';
import { BlobWriter } from '@zip.js/zip.js';
import { describe, expect, it } from 'vitest';
import { detectWorldRoots } from '../src/merge/detect.ts';
import { buildMergePlan } from '../src/merge/plan.ts';
import { indexWorld } from '../src/merge/world-index.ts';
import { ArchiveError, openArchive } from '../src/zip/reader.ts';
import { ArchiveWriter } from '../src/zip/writer.ts';
import { executeMergePlan } from '../src/workers/pipeline.ts';
import { makePng } from './helpers/png.ts';
import { sharpCompositor } from './helpers/sharp-compositor.ts';
import { buildZip, text, toBlob } from './helpers/zip-fixtures.ts';

describe('hostile archives', () => {
  it('rejects random bytes, an empty file and a truncated archive with a plain message', async () => {
    await expect(
      openArchive(toBlob(new Uint8Array(randomBytes(4096))), 'garbage.zip'),
    ).rejects.toThrow(/garbage\.zip is not a zip archive, or it is damaged\./);
    await expect(openArchive(new Blob([]), 'empty.zip')).rejects.toThrow(/empty\.zip is empty\./);
    const good = await buildZip([{ path: 'w/DIM0/day/0,0.png', data: text('x') }]);
    const truncated = good.slice(0, Math.floor(good.length / 2));
    await expect(openArchive(toBlob(truncated), 'cut.zip')).rejects.toBeInstanceOf(ArchiveError);
  });

  it('opens a zip without JourneyMap data and reports no world roots', async () => {
    const zip = await buildZip([
      { path: 'README.txt', data: text('hello') },
      { path: 'photos/cat.png', data: text('not really a png') },
    ]);
    const archive = await openArchive(toBlob(zip));
    expect(archive.entries).toHaveLength(2);
    expect(detectWorldRoots(archive.entries)).toEqual([]);
    await archive.close();
  });

  it('refuses to write unsafe output paths even when asked directly', async () => {
    const writer = new ArchiveWriter(new BlobWriter());
    await expect(writer.addBytes('../x.png', new Uint8Array(1), new Date())).rejects.toThrow(
      /unsafe/,
    );
    await expect(writer.addBytes('/abs/x.png', new Uint8Array(1), new Date())).rejects.toThrow(
      /unsafe/,
    );
    await expect(writer.addBytes('a//b.png', new Uint8Array(1), new Date())).rejects.toThrow(
      /unsafe/,
    );
    await writer.close();
  });

  it('keeps the path when a shared tile cannot be composited: copies the newer verbatim and reports it', async () => {
    const good = await makePng(4, 4, () => [1, 2, 3, 255]);
    const zipA = await buildZip([
      { path: 'w/DIM0/day/0,0.png', data: good, mtime: new Date(1_000_000) },
    ]);
    const zipB = await buildZip([
      { path: 'w/DIM0/day/0,0.png', data: new Uint8Array(), mtime: new Date(2_000_000) },
    ]); // 0-byte tile, newer
    const a = await openArchive(toBlob(zipA));
    const b = await openArchive(toBlob(zipB));
    const rootA = detectWorldRoots(a.entries)[0];
    const rootB = detectWorldRoots(b.entries)[0];
    if (!rootA || !rootB) throw new Error('roots');
    const plan = buildMergePlan(indexWorld(a.entries, rootA), indexWorld(b.entries, rootB), {
      priority: 'auto',
    });
    expect(plan.tasks[0]?.kind).toBe('composite');
    const writer = new ArchiveWriter(new BlobWriter());
    const result = await executeMergePlan(plan, { a, b }, writer, { compositor: sharpCompositor });
    const blob = await writer.close();
    expect(result).toMatchObject({
      written: 1,
      composited: 0,
      copied: 1,
      compositeFailures: ['DIM0/day/0,0.png'],
    });
    if (!blob) throw new Error('no blob');
    const out = await openArchive(blob);
    expect(out.entries.map((e) => e.path)).toEqual(['w/DIM0/day/0,0.png']);
    await Promise.all([a.close(), b.close(), out.close()]);
  });
});
