/**
 * Write side of the zip layer. Entries are either copied verbatim from a
 * source archive (bytes and metadata untouched, so a deflated tile stays
 * deflated and keeps its mtime) or added as fresh bytes stored without
 * compression (PNG does not deflate). Every path is re-validated here:
 * nothing unsafe can be written even if a caller slips.
 */
import { BlobReader, BlobWriter, Uint8ArrayReader, ZipWriter } from '@zip.js/zip.js';
import { isSafeArchivePath } from '../merge/paths.ts';
import type { ArchiveEntry } from './reader.ts';

export type WriterTarget = WritableStream<Uint8Array> | BlobWriter;

export class ArchiveWriter {
  private readonly zip: ZipWriter<unknown>;

  constructor(target: WriterTarget) {
    // keepOrder:false lets concurrent adds finish in completion order;
    // zip64 switches on by itself past 4 GB / 65k entries.
    this.zip = new ZipWriter(target, { level: 0, keepOrder: false, useWebWorkers: false });
  }

  /** Copy an entry byte-for-byte, with its metadata, under a new path. */
  async copyEntry(path: string, source: ArchiveEntry, raw: Blob): Promise<void> {
    assertSafe(path);
    await this.zip.add(path, new BlobReader(raw), { passThrough: true, entry: source.handle });
  }

  /** Add freshly produced bytes, stored uncompressed. */
  async addBytes(path: string, bytes: Uint8Array, mtime: Date): Promise<void> {
    assertSafe(path);
    await this.zip.add(path, new Uint8ArrayReader(bytes), { level: 0, lastModDate: mtime });
  }

  /** Finalize the archive. Returns the Blob when the target was a BlobWriter. */
  async close(): Promise<Blob | undefined> {
    const result: unknown = await this.zip.close();
    return result instanceof Blob ? result : undefined;
  }
}

function assertSafe(path: string): void {
  if (!isSafeArchivePath(path)) throw new Error(`refusing to write unsafe archive path: ${path}`);
}
