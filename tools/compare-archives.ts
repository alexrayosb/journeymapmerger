/**
 * Compare two merged archives for content equality, independent of how the
 * bytes were packed (store vs deflate, entry order, extra fields).
 *
 *   node tools/compare-archives.ts <ours.zip> <reference.zip>
 *
 * Both are extracted with Info-ZIP. Every file must exist on both sides;
 * PNGs must decode (sharp) to identical RGBA pixels, other files must be
 * byte-identical. mtimes are compared at 2-second precision and reported
 * as warnings only. Exit code 1 on any content mismatch.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

function extract(zip: string, into: string): void {
  mkdirSync(into, { recursive: true });
  execFileSync('unzip', ['-o', '-q', zip, '-d', into], { stdio: 'inherit' });
}

function walk(dir: string, base = dir, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const abs = path.join(dir, name);
    if (statSync(abs).isDirectory()) walk(abs, base, out);
    else out.push(path.relative(base, abs).split(path.sep).join('/'));
  }
  return out.sort();
}

async function pixels(file: string): Promise<{ w: number; h: number; data: Buffer }> {
  const { data, info } = await sharp(file)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { w: info.width, h: info.height, data };
}

async function main(): Promise<void> {
  const [ours, ref] = process.argv.slice(2);
  if (!ours || !ref) {
    console.error('usage: node tools/compare-archives.ts <ours.zip> <reference.zip>');
    process.exit(2);
  }
  const work = mkdtempSync(path.join(os.tmpdir(), 'jm-cmp-'));
  try {
    const dirO = path.join(work, 'ours');
    const dirR = path.join(work, 'ref');
    extract(path.resolve(ours), dirO);
    extract(path.resolve(ref), dirR);
    const listO = walk(dirO);
    const listR = walk(dirR);
    const setO = new Set(listO);
    const setR = new Set(listR);
    const onlyO = listO.filter((f) => !setR.has(f));
    const onlyR = listR.filter((f) => !setO.has(f));
    let mismatches = 0;
    let mtimeWarnings = 0;
    let pngs = 0;
    let others = 0;
    for (const f of onlyO) console.log(`ONLY IN OURS      ${f}`);
    for (const f of onlyR) console.log(`ONLY IN REFERENCE ${f}`);
    mismatches += onlyO.length + onlyR.length;

    for (const rel of listO) {
      if (!setR.has(rel)) continue;
      const fo = path.join(dirO, rel);
      const fr = path.join(dirR, rel);
      if (rel.endsWith('.png')) {
        pngs++;
        const [po, pr] = await Promise.all([pixels(fo), pixels(fr)]);
        if (po.w !== pr.w || po.h !== pr.h || !po.data.equals(pr.data)) {
          mismatches++;
          let diff = 0;
          const n = Math.min(po.data.length, pr.data.length);
          for (let i = 0; i < n; i += 4) {
            if (
              po.data[i] !== pr.data[i] ||
              po.data[i + 1] !== pr.data[i + 1] ||
              po.data[i + 2] !== pr.data[i + 2] ||
              po.data[i + 3] !== pr.data[i + 3]
            )
              diff++;
          }
          console.log(
            `PIXEL MISMATCH    ${rel}  (${String(diff)} px differ, ${String(po.w)}x${String(po.h)} vs ${String(pr.w)}x${String(pr.h)})`,
          );
        }
      } else {
        others++;
        if (!readFileSync(fo).equals(readFileSync(fr))) {
          mismatches++;
          console.log(`BYTE MISMATCH     ${rel}`);
        }
      }
      const dt = Math.abs(statSync(fo).mtimeMs - statSync(fr).mtimeMs);
      if (dt > 2000) {
        mtimeWarnings++;
        if (mtimeWarnings <= 5)
          console.log(`mtime differs     ${rel}  (${String(Math.round(dt / 1000))} s)`);
      }
    }
    console.log(
      `compared ${String(listO.length)} files (${String(pngs)} PNG pixel-exact, ${String(others)} byte-exact): ` +
        `${String(mismatches)} mismatches, ${String(mtimeWarnings)} mtime warnings`,
    );
    process.exitCode = mismatches === 0 ? 0 : 1;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

await main();
