/**
 * Independent reference merge (Node). Shares NO code with the app: archives
 * are extracted and re-packed with Info-ZIP, pixels are composited with
 * sharp, world folders are found with a filesystem walk. Its output is the
 * yardstick the browser's output is compared against (compare-archives.ts).
 *
 *   node tools/reference-merge.ts <A.zip> <B.zip> <out.zip>
 *        [--priority auto|a|b] [--root-a <folder>] [--root-b <folder>]
 *
 * Rules (the spec, restated here on purpose):
 *   - world root = a directory holding DIM* or waypoints/ (most PNGs wins)
 *   - only in one input -> copy verbatim (mtime kept)
 *   - tile in both -> newer over older (mtime; tie -> A; --priority forces)
 *   - anything else in both -> A's copy (B's when --priority b)
 *   - output folder = A's world folder name, or "merged" at the zip root
 */
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

type Priority = 'auto' | 'a' | 'b';

interface FileRec {
  rel: string;
  abs: string;
  mtimeMs: number;
  size: number;
}

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function extract(zip: string, into: string): void {
  mkdirSync(into, { recursive: true });
  // -o: overwrite (later duplicates win), -q: quiet. unzip itself refuses
  // '..' paths and strips leading slashes.
  try {
    execFileSync('unzip', ['-o', '-q', zip, '-d', into], { stdio: 'inherit' });
  } catch {
    // unzip exits 1 for warnings (e.g. skipped unsafe names); the files that
    // could be extracted are there. Anything worse surfaces as missing roots.
  }
}

function walk(dir: string, base = dir, out: FileRec[] = []): FileRec[] {
  for (const name of readdirSync(dir)) {
    if (name === '__MACOSX' || name === '.DS_Store') continue;
    const abs = path.join(dir, name);
    const st = statSync(abs);
    if (st.isDirectory()) walk(abs, base, out);
    else
      out.push({
        rel: path.relative(base, abs).split(path.sep).join('/'),
        abs,
        mtimeMs: st.mtimeMs,
        size: st.size,
      });
  }
  return out;
}

const DIM = /^DIM-?\d+$/;

/** Directories that directly contain a DIM* dir or a waypoints dir, ranked by PNG count. */
function findRoots(base: string): { dir: string; pngs: number }[] {
  const roots: { dir: string; pngs: number }[] = [];
  const visit = (dir: string): void => {
    const names = readdirSync(dir);
    const isRoot = names.some(
      (n) => (DIM.test(n) || n === 'waypoints') && statSync(path.join(dir, n)).isDirectory(),
    );
    if (isRoot) roots.push({ dir, pngs: walk(dir).filter((f) => f.rel.endsWith('.png')).length });
    for (const n of names) {
      const p = path.join(dir, n);
      if (statSync(p).isDirectory() && n !== '__MACOSX') visit(p);
    }
  };
  visit(base);
  roots.sort((x, y) => y.pngs - x.pngs || x.dir.localeCompare(y.dir));
  return roots;
}

const isTile = (rel: string): boolean =>
  /^DIM-?\d+\/(day|night|topo|[0-9]|1[0-5])\/-?\d+,-?\d+\.png$/.test(rel);

async function main(): Promise<void> {
  const [zipA, zipB, outZip] = process.argv
    .slice(2)
    .filter((a) => !a.startsWith('--') && !isFlagValue(a));
  if (!zipA || !zipB || !outZip) {
    console.error(
      'usage: node tools/reference-merge.ts <A.zip> <B.zip> <out.zip> [--priority auto|a|b] [--root-a f] [--root-b f]',
    );
    process.exit(2);
  }
  const priority = (arg('--priority') ?? 'auto') as Priority;
  const work = mkdtempSync(path.join(os.tmpdir(), 'jm-ref-'));
  try {
    const dirA = path.join(work, 'A');
    const dirB = path.join(work, 'B');
    extract(path.resolve(zipA), dirA);
    extract(path.resolve(zipB), dirB);

    const pickRoot = (base: string, wanted: string | undefined): string => {
      const roots = findRoots(base);
      const chosen = wanted ? roots.find((r) => path.basename(r.dir) === wanted) : roots[0];
      if (!chosen) throw new Error(`no JourneyMap world folder found in ${base}`);
      return chosen.dir;
    };
    const rootA = pickRoot(dirA, arg('--root-a'));
    const rootB = pickRoot(dirB, arg('--root-b'));
    const filesA = new Map(walk(rootA).map((f) => [f.rel, f]));
    const filesB = new Map(walk(rootB).map((f) => [f.rel, f]));

    const outName = rootA === dirA ? 'merged' : path.basename(rootA);
    const stage = path.join(work, 'out', outName);
    const primary = priority === 'b' ? filesB : filesA;
    let copied = 0;
    let composited = 0;

    const place = (rel: string, from: FileRec): void => {
      const dest = path.join(stage, rel);
      mkdirSync(path.dirname(dest), { recursive: true });
      copyFileSync(from.abs, dest);
      utimesSync(dest, new Date(from.mtimeMs), new Date(from.mtimeMs));
      copied++;
    };

    for (const rel of new Set([...filesA.keys(), ...filesB.keys()])) {
      const fa = filesA.get(rel);
      const fb = filesB.get(rel);
      if (fa && fb) {
        if (isTile(rel)) {
          const aNewer = priority === 'a' || (priority === 'auto' && fa.mtimeMs >= fb.mtimeMs);
          const [older, newer] = aNewer ? [fb, fa] : [fa, fb];
          const dest = path.join(stage, rel);
          mkdirSync(path.dirname(dest), { recursive: true });
          await sharp(older.abs)
            .composite([{ input: newer.abs, blend: 'over' }])
            .png()
            .toFile(dest);
          utimesSync(dest, new Date(newer.mtimeMs), new Date(newer.mtimeMs));
          composited++;
        } else {
          const rec = primary.get(rel);
          if (rec) place(rel, rec);
        }
      } else {
        const rec = fa ?? fb;
        if (rec) place(rel, rec);
      }
    }

    rmSync(path.resolve(outZip), { force: true });
    execFileSync('zip', ['-r', '-0', '-q', path.resolve(outZip), outName], {
      cwd: path.join(work, 'out'),
      stdio: 'inherit',
    });
    console.log(
      `reference merge: ${String(copied)} copied, ${String(composited)} composited -> ${outZip} (root ${outName})`,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function isFlagValue(a: string): boolean {
  const i = process.argv.indexOf(a);
  return i > 0 && (process.argv[i - 1]?.startsWith('--') ?? false);
}

await main();
