/**
 * Read side of the zip layer: open an archive lazily (central directory
 * only), hand out normalized entries, read one entry's bytes on demand.
 * No DOM: runs in browsers and in Node (Vitest) alike.
 */
import {
  BlobReader,
  BlobWriter,
  Uint8ArrayWriter,
  ZipReader,
  type FileEntry,
} from '@zip.js/zip.js';
import { normalizeArchivePath, type PathProblem } from '../merge/paths.ts';
import type { EntryInfo } from '../merge/types.ts';

export interface ArchiveEntry extends EntryInfo {
  /** zip.js handle; only the zip layer touches it. */
  readonly handle: FileEntry;
}

export interface SkippedEntry {
  readonly path: string;
  readonly reason: PathProblem;
}

export interface Archive {
  readonly name: string;
  readonly size: number;
  readonly entries: readonly ArchiveEntry[];
  /** Entries never indexed: directories, junk, unsafe paths. */
  readonly skipped: readonly SkippedEntry[];
  /** The entry's stored bytes exactly as they sit in the archive (compressed or not). */
  readRaw(entry: ArchiveEntry): Promise<Blob>;
  /** The entry's decoded content. */
  readBytes(entry: ArchiveEntry): Promise<Uint8Array>;
  close(): Promise<void>;
}

/** Plain-language failure to open an archive. `message` is safe to show. */
export class ArchiveError extends Error {
  override readonly name = 'ArchiveError';
}

const ZIP_OPTIONS = { useWebWorkers: false } as const;

export async function openArchive(file: Blob, name = 'archive.zip'): Promise<Archive> {
  if (file.size === 0) throw new ArchiveError(`${name} is empty.`);
  const reader = new ZipReader(new BlobReader(file), ZIP_OPTIONS);
  let raw;
  try {
    // zip.js would reject the whole archive on one '..' or absolute name.
    // We want the rest of a mostly-fine archive: normalizeArchivePath skips
    // and reports such entries instead, and the writer re-validates paths.
    raw = await reader.getEntries({ filenameValidation: 'tolerant' });
  } catch (cause) {
    await reader.close().catch(() => undefined);
    throw new ArchiveError(`${name} is not a zip archive, or it is damaged.`, { cause });
  }

  if (raw.some((entry) => !entry.directory && entry.encrypted)) {
    await reader.close().catch(() => undefined);
    throw new ArchiveError(`${name} is password protected. Remove the password and zip it again.`);
  }

  const entries: ArchiveEntry[] = [];
  const skipped: SkippedEntry[] = [];
  for (const entry of raw) {
    if (entry.directory) {
      skipped.push({ path: entry.filename, reason: 'directory' });
      continue;
    }
    const normalized = normalizeArchivePath(entry.filename);
    if (!normalized.ok) {
      skipped.push({ path: entry.filename, reason: normalized.problem });
      continue;
    }
    entries.push({
      path: normalized.path,
      size: entry.uncompressedSize,
      mtime: entry.lastModDate.getTime(),
      handle: entry,
    });
  }

  return {
    name,
    size: file.size,
    entries,
    skipped,
    readRaw: (entry) => entry.handle.getData(new BlobWriter(), { passThrough: true }),
    readBytes: (entry) => entry.handle.getData(new Uint8ArrayWriter()),
    close: () => reader.close(),
  };
}
