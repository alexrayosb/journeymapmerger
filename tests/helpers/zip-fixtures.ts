import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface FixtureEntry {
  readonly path: string;
  readonly data?: Uint8Array;
  readonly mtime?: Date;
  /** 0 = stored (default), 1-9 = deflate. */
  readonly level?: number;
  readonly directory?: boolean;
}

export const T0 = new Date(Date.UTC(2026, 8, 1, 12, 0, 0));
export const daysBefore = (days: number): Date => new Date(T0.getTime() - days * 86_400_000);
export const text = (s: string): Uint8Array => new TextEncoder().encode(s);

/** Build a zip in memory with zip.js (the same library the app reads with). */
export async function buildZip(entries: readonly FixtureEntry[]): Promise<Uint8Array> {
  const zip = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false });
  for (const e of entries) {
    if (e.directory) {
      await zip.add(e.path, undefined, { directory: true, lastModDate: e.mtime ?? T0 });
    } else {
      await zip.add(e.path, new Uint8ArrayReader(e.data ?? new Uint8Array()), {
        level: e.level ?? 0,
        lastModDate: e.mtime ?? T0,
      });
    }
  }
  return zip.close();
}

/**
 * Replace every occurrence of an ASCII file name inside raw zip bytes with
 * another of the SAME length. Names are not covered by any checksum, so this
 * crafts archives zip.js itself refuses to write: '..' paths, duplicates.
 */
export function patchNames(zip: Uint8Array, from: string, to: string): Uint8Array {
  if (from.length !== to.length) throw new Error('patchNames needs equal lengths');
  const out = new Uint8Array(zip);
  const needle = text(from);
  const repl = text(to);
  outer: for (let i = 0; i <= out.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (out[i + j] !== needle[j]) continue outer;
    out.set(repl, i);
  }
  return out;
}

export const toBlob = (bytes: Uint8Array): Blob => new Blob([bytes]);

/** True when Info-ZIP's unzip/zipinfo are installed (external verifier). */
export function hasInfoZip(): boolean {
  try {
    execFileSync('unzip', ['-v'], { stdio: 'ignore' });
    execFileSync('zipinfo', ['-h'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Run Info-ZIP against archive bytes: integrity test + sorted entry list. */
export function infoZipInspect(bytes: Uint8Array): { testOutput: string; names: string[] } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'jm-zip-'));
  try {
    const file = path.join(dir, 'out.zip');
    writeFileSync(file, bytes);
    const testOutput = execFileSync('unzip', ['-tq', file], { encoding: 'utf8' });
    const names = execFileSync('zipinfo', ['-1', file], { encoding: 'utf8' })
      .split('\n')
      .filter((n) => n !== '')
      .sort();
    return { testOutput, names };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
