/**
 * The zip-variant matrix: the same small world packed by different tools
 * and at different nesting depths must be detected with the same result,
 * and the things that cannot be merged must be rejected with a plain
 * message. External archivers are used where installed; the Windows-made
 * shapes (Explorer, PowerShell) are reproduced with zip.js since no
 * Windows is at hand.
 */
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { detectWorldRoots } from '../src/merge/detect.ts';
import { buildMergePlan } from '../src/merge/plan.ts';
import { indexWorld } from '../src/merge/world-index.ts';
import { ArchiveError, openArchive } from '../src/zip/reader.ts';
import { ArchiveWriter } from '../src/zip/writer.ts';
import { executeMergePlan } from '../src/workers/pipeline.ts';
import { BlobWriter } from '@zip.js/zip.js';
import { makePng, type Rgba } from './helpers/png.ts';
import { sharpCompositor } from './helpers/sharp-compositor.ts';
import { buildZip, text, toBlob } from './helpers/zip-fixtures.ts';

const has = (tool: string): boolean => {
  try {
    execFileSync('command', ['-v', tool], { stdio: 'ignore', shell: '/bin/sh' });
    return true;
  } catch {
    return false;
  }
};

const WORLD = 'GTNH~Server~1';
const REL_FILES = [
  'DIM0/day/0,0.png',
  'DIM0/day/1,0.png',
  'DIM0/night/0,0.png',
  'DIM-1/day/0,0.png',
  'waypoints/Home_1,2,3.json',
  'colorpalette.json',
];
const EXPECT_ROOT = { name: WORLD, tiles: 4, waypoints: 1, others: 1 };

let work: string;
let tree: string; // <work>/journeymap/data/mp/GTNH~Server~1/...
let tile: Uint8Array;
let zipB: Uint8Array;

beforeAll(async () => {
  work = mkdtempSync(path.join(os.tmpdir(), 'jm-variants-'));
  tile = await makePng(8, 8, () => [10, 200, 30, 255] as Rgba);
  tree = path.join(work, 'journeymap', 'data', 'mp', WORLD);
  for (const rel of REL_FILES) {
    const file = path.join(tree, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(
      file,
      rel.endsWith('.png') ? tile : text(`{"name":"${rel}","x":1,"y":2,"z":3,"dimensions":[0]}`),
    );
  }
  zipB = await buildZip([{ path: 'other~map/DIM0/day/5,5.png', data: tile }]);
});

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

/** Run an archiver in <work> and return the resulting zip bytes. */
function pack(name: string, cmd: string, args: string[]): Uint8Array {
  const out = path.join(work, `${name}.zip`);
  rmSync(out, { force: true });
  execFileSync(
    cmd,
    args.map((a) => a.replace('OUT', out)),
    { cwd: work, stdio: 'ignore' },
  );
  return new Uint8Array(readFileSync(out));
}

/** zip.js-made variant with control over names and timestamp flags. */
async function craft(
  rename: (rel: string) => string,
  options: { extendedTimestamp?: boolean; level?: number; directories?: boolean } = {},
): Promise<Uint8Array> {
  const zip = new ZipWriter(new Uint8ArrayWriter(), {
    useWebWorkers: false,
    extendedTimestamp: options.extendedTimestamp ?? true,
  });
  if (options.directories)
    await zip.add(rename('journeymap/data/mp/GTNH~Server~1/DIM0/day/'), undefined, {
      directory: true,
    });
  for (const rel of REL_FILES) {
    const data = readFileSync(path.join(tree, rel));
    await zip.add(
      rename(`journeymap/data/mp/${WORLD}/${rel}`),
      new Uint8ArrayReader(new Uint8Array(data)),
      {
        level: options.level ?? 6,
      },
    );
  }
  return zip.close();
}

async function expectDetected(zip: Uint8Array, label: string, expectedName = WORLD): Promise<void> {
  const archive = await openArchive(toBlob(zip), `${label}.zip`);
  const roots = detectWorldRoots(archive.entries);
  expect(roots, label).toHaveLength(1);
  expect(roots[0], label).toMatchObject({ ...EXPECT_ROOT, name: expectedName });
  // and it merges: every file lands in the output under the detected name
  const b = await openArchive(toBlob(zipB));
  const rootB = detectWorldRoots(b.entries)[0];
  const rootA = roots[0];
  if (!rootA || !rootB) throw new Error('roots');
  const plan = buildMergePlan(indexWorld(archive.entries, rootA), indexWorld(b.entries, rootB), {
    priority: 'auto',
  });
  const writer = new ArchiveWriter(new BlobWriter());
  const result = await executeMergePlan(plan, { a: archive, b }, writer, {
    compositor: sharpCompositor,
  });
  const blob = await writer.close();
  expect(result.written, label).toBe(REL_FILES.length + 1);
  if (!blob) throw new Error('no output');
  const out = await openArchive(blob);
  const outRoot = expectedName === '' ? 'merged' : expectedName;
  expect(out.entries.map((e) => e.path).sort(), label).toEqual(
    [...REL_FILES.map((r) => `${outRoot}/${r}`), `${outRoot}/DIM0/day/5,5.png`].sort(),
  );
  await Promise.all([archive.close(), b.close(), out.close()]);
}

describe('archivers', () => {
  it.skipIf(!has('zip'))('Info-ZIP zip -r (deflate) and zip -r -0 (store)', async () => {
    await expectDetected(
      pack('infozip-deflate', 'zip', ['-r', '-q', 'OUT', 'journeymap']),
      'infozip-deflate',
    );
    await expectDetected(
      pack('infozip-store', 'zip', ['-r', '-0', '-q', 'OUT', 'journeymap']),
      'infozip-store',
    );
  });

  it.skipIf(!has('ditto'))(
    'macOS Finder "Compress" (ditto, with __MACOSX resource forks)',
    async () => {
      const zip = pack('finder', 'ditto', [
        '-c',
        '-k',
        '--sequesterRsrc',
        '--keepParent',
        'journeymap',
        'OUT',
      ]);
      const archive = await openArchive(toBlob(zip));
      expect(archive.skipped.some((s) => s.reason === 'junk' || s.reason === 'directory')).toBe(
        true,
      );
      await archive.close();
      await expectDetected(zip, 'finder');
    },
  );

  it.skipIf(!has('bsdtar'))('libarchive bsdtar -a (zip)', async () => {
    await expectDetected(pack('bsdtar', 'bsdtar', ['-a', '-cf', 'OUT', 'journeymap']), 'bsdtar');
  });

  it('Windows Explorer shape: deflate, DOS timestamps only, no directory entries', async () => {
    await expectDetected(await craft((n) => n, { extendedTimestamp: false }), 'explorer-like');
  });

  it('PowerShell Compress-Archive shape: backslash separators', async () => {
    await expectDetected(await craft((n) => n.replace(/\//g, '\\')), 'powershell-like');
  });

  it('paths prefixed with ./ and explicit directory entries', async () => {
    await expectDetected(await craft((n) => `./${n}`, { directories: true }), 'dot-slash');
  });
});

describe('nesting depths', () => {
  it('zipped from inside journeymap/, from the world folder, and from the DIM level', async () => {
    await expectDetected(await craft((n) => n.replace(/^journeymap\//, '')), 'from-data');
    await expectDetected(
      await craft((n) => n.replace(/^journeymap\/data\/mp\//, '')),
      'world-folder-root',
    );
    await expectDetected(
      await craft((n) => n.replace(/^journeymap\/data\/mp\/GTNH~Server~1\//, '')),
      'dim-level-root',
      '',
    );
  });

  it('wrapped in extra folders with spaces', async () => {
    await expectDetected(await craft((n) => `Backups 2026/old laptop/${n}`), 'wrapped');
  });

  it('a zip holding both an sp and an mp world offers both, mp with more tiles first', async () => {
    const zip = await buildZip([
      { path: 'journeymap/data/sp/New World/DIM0/day/0,0.png', data: tile },
      { path: 'journeymap/data/mp/GTNH~Server~1/DIM0/day/0,0.png', data: tile },
      { path: 'journeymap/data/mp/GTNH~Server~1/DIM0/day/1,0.png', data: tile },
    ]);
    const archive = await openArchive(toBlob(zip));
    const roots = detectWorldRoots(archive.entries);
    expect(roots.map((r) => r.name)).toEqual(['GTNH~Server~1', 'New World']);
    await archive.close();
  });
});

describe('cleanly rejected', () => {
  it.skipIf(!has('zip'))('a password-protected zip', async () => {
    const zip = pack('encrypted', 'zip', ['-r', '-q', '-P', 'secret', 'OUT', 'journeymap']);
    await expect(openArchive(toBlob(zip), 'locked.zip')).rejects.toThrow(
      /locked\.zip is password protected/,
    );
    await expect(openArchive(toBlob(zip), 'locked.zip')).rejects.toBeInstanceOf(ArchiveError);
  });

  it('a text file renamed to .zip', async () => {
    await expect(
      openArchive(toBlob(text('this is not a zip\n'.repeat(100))), 'notes.zip'),
    ).rejects.toThrow(/notes\.zip is not a zip archive, or it is damaged\./);
  });
});
