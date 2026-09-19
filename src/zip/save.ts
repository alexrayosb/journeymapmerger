/**
 * Where the merged archive goes. Chrome/Edge can stream straight to a file
 * the user picks (showSaveFilePicker); everywhere else the archive is built
 * in memory and offered as a download.
 *
 * The picker needs a user gesture, so callers invoke pickSaveTarget() as the
 * first thing in the click handler, before any other await.
 */
import { BlobWriter } from '@zip.js/zip.js';
import type { WriterTarget } from './writer.ts';

interface SaveFilePickerOptions {
  suggestedName?: string;
  types?: { description?: string; accept: Record<string, string[]> }[];
}

declare global {
  interface Window {
    showSaveFilePicker?: (options?: SaveFilePickerOptions) => Promise<FileSystemFileHandle>;
  }
}

export interface SaveTarget {
  readonly kind: 'stream' | 'download';
  readonly writerTarget: WriterTarget;
  /** After the archive is closed: commit the file, or start the download. */
  finish(closed: Blob | undefined): Promise<void>;
  /** After a failure: discard the partial output. */
  abort(): Promise<void>;
}

export function canStreamToDisk(): boolean {
  return typeof window.showSaveFilePicker === 'function';
}

export interface PickOptions {
  /** Skip the picker and use the in-memory download path (tests, ?save=download). */
  forceDownload?: boolean;
}

/** Returns null when the user closed the save dialog without choosing. */
export async function pickSaveTarget(
  suggestedName: string,
  options: PickOptions = {},
): Promise<SaveTarget | null> {
  if (!options.forceDownload && canStreamToDisk() && window.showSaveFilePicker) {
    let handle: FileSystemFileHandle;
    try {
      handle = await window.showSaveFilePicker({
        suggestedName,
        types: [{ description: 'Zip archive', accept: { 'application/zip': ['.zip'] } }],
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return null;
      throw err;
    }
    const writable = await handle.createWritable();
    return {
      kind: 'stream',
      writerTarget: writable,
      finish: () => Promise.resolve(), // ZipWriter.close() closed the stream, which commits the file
      abort: () => writable.abort().catch(() => undefined),
    };
  }

  return {
    kind: 'download',
    writerTarget: new BlobWriter('application/zip'),
    finish: (closed) => {
      if (!closed) throw new Error('no archive produced');
      const url = URL.createObjectURL(closed);
      const link = document.createElement('a');
      link.href = url;
      link.download = suggestedName;
      link.rel = 'noopener';
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => {
        URL.revokeObjectURL(url);
      }, 60_000);
      return Promise.resolve();
    },
    abort: () => Promise.resolve(),
  };
}
