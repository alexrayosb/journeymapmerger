/**
 * Merge-pipeline spike (browser side). Throwaway by design; the numbers it
 * produces are the deliverable (see ../README.md).
 *
 * Pipeline under test, minimally:
 *   index   open both zips lazily (zip.js BlobReader over the File), list entries
 *   plan    strip everything above the world folder, classify each relative path:
 *           only-A / only-B -> pass-through (copied verbatim, no re-encode)
 *           both + .png     -> composite (newer by zip mtime drawn over older)
 *           both + other    -> keep A
 *   merge   worker pool composites; everything streams into one zip.js ZipWriter
 *           (store, no deflate) whose target is the chosen sink
 *   close   finalize the archive
 */
import {
  BlobReader,
  BlobWriter,
  Uint8ArrayReader,
  Uint8ArrayWriter,
  ZipReader,
  ZipWriter,
  type FileEntry,
} from '@zip.js/zip.js';
import type { CompositeJob, CompositeResult } from './compositor.worker.ts';

export type Sink = 'opfs' | 'blob' | 'discard';

export interface RunOptions {
  sink: Sink;
  /** compositor workers; default = min(hardwareConcurrency, 8) */
  workers?: number;
  /** entries processed concurrently; default = workers + 2 */
  inflight?: number;
}

export interface SpikeResult {
  ua: string;
  hardwareConcurrency: number;
  workers: number;
  inflight: number;
  sink: Sink;
  inputs: { a: InputInfo; b: InputInfo };
  plan: { passThrough: number; composite: number; keepA: number; skipped: number };
  timesMs: { index: number; plan: number; merge: number; close: number; total: number };
  compositeMs: { decode: number; draw: number; encode: number };
  outputBytes: number;
  outputEntries: number;
  readback: Readback;
  /** Chromium-only performance.memory peak during the run; null elsewhere. */
  jsHeapPeakBytes: number | null;
}

interface InputInfo {
  name: string;
  bytes: number;
  entries: number;
  files: number;
}

const DIM_RE = /^DIM-?\d+$/;

/**
 * Relative path inside the world folder, or null for entries that are not
 * JourneyMap data (directories, __MACOSX junk, .DS_Store, ...).
 */
export function relativeWorldPath(filename: string): string | null {
  const segments = filename.split('/');
  const start = segments.findIndex((s) => DIM_RE.test(s) || s === 'waypoints');
  if (start >= 0) return segments.slice(start).join('/');
  const last = segments.at(-1);
  if (last?.startsWith('colorpalette.')) return last;
  return null;
}

type Task =
  | { kind: 'pass'; rel: string; entry: FileEntry }
  | { kind: 'composite'; rel: string; older: FileEntry; newer: FileEntry };

function plan(a: Map<string, FileEntry>, b: Map<string, FileEntry>): Task[] {
  const tasks: Task[] = [];
  for (const [rel, ea] of a) {
    const eb = b.get(rel);
    if (!eb) {
      tasks.push({ kind: 'pass', rel, entry: ea });
    } else if (rel.endsWith('.png')) {
      const aNewer = ea.lastModDate.getTime() >= eb.lastModDate.getTime();
      tasks.push({
        kind: 'composite',
        rel,
        older: aNewer ? eb : ea,
        newer: aNewer ? ea : eb,
      });
    } else {
      tasks.push({ kind: 'pass', rel, entry: ea }); // keep A
    }
  }
  for (const [rel, eb] of b) {
    if (!a.has(rel)) tasks.push({ kind: 'pass', rel, entry: eb });
  }
  return tasks;
}

async function indexZip(
  file: File,
): Promise<{ info: InputInfo; files: Map<string, FileEntry>; skipped: number }> {
  const reader = new ZipReader(new BlobReader(file));
  const entries = await reader.getEntries();
  const files = new Map<string, FileEntry>();
  let skipped = 0;
  let fileCount = 0;
  for (const entry of entries) {
    if (entry.directory) continue;
    fileCount++;
    const rel = relativeWorldPath(entry.filename);
    if (rel === null) {
      skipped++;
      continue;
    }
    files.set(rel, entry);
  }
  return {
    info: { name: file.name, bytes: file.size, entries: entries.length, files: fileCount },
    files,
    skipped,
  };
}

class CompositorPool {
  private readonly idle: Worker[] = [];
  private readonly waiting: ((w: Worker) => void)[] = [];
  readonly stats = { decode: 0, draw: 0, encode: 0 };

  readonly size: number;

  constructor(size: number) {
    this.size = size;
    for (let i = 0; i < size; i++) {
      this.idle.push(
        new Worker(new URL('./compositor.worker.ts', import.meta.url), { type: 'module' }),
      );
    }
  }

  private acquire(): Promise<Worker> {
    const w = this.idle.pop();
    if (w) return Promise.resolve(w);
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  private release(w: Worker): void {
    const next = this.waiting.shift();
    if (next) next(w);
    else this.idle.push(w);
  }

  async composite(job: CompositeJob): Promise<Uint8Array> {
    const worker = await this.acquire();
    try {
      const result = await new Promise<CompositeResult>((resolve, reject) => {
        worker.onmessage = (e: MessageEvent<CompositeResult | { error: string }>) => {
          if ('error' in e.data) reject(new Error(e.data.error));
          else resolve(e.data);
        };
        worker.onerror = (e) => {
          reject(new Error(e.message));
        };
        worker.postMessage(job, [job.older, job.newer]);
      });
      this.stats.decode += result.decodeMs;
      this.stats.draw += result.drawMs;
      this.stats.encode += result.encodeMs;
      return new Uint8Array(result.png);
    } finally {
      this.release(worker);
    }
  }

  terminate(): void {
    for (const w of this.idle) w.terminate();
  }
}

export interface Readback {
  bytes: number;
  /** entries found by re-opening the finished archive with zip.js; -1 if not readable back */
  entries: number;
  zip64: boolean;
}

interface SinkHandle {
  target: WritableStream<Uint8Array> | BlobWriter;
  /** Called after ZipWriter.close(); re-opens the archive and reports on it. */
  finish(closeResult: unknown): Promise<Readback>;
}

async function readBack(archive: Blob): Promise<Readback> {
  const reader = new ZipReader(new BlobReader(archive));
  const entries = await reader.getEntries();
  await reader.close();
  return {
    bytes: archive.size,
    entries: entries.filter((e) => !e.directory).length,
    zip64: entries.some((e) => e.zip64),
  };
}

async function openSink(kind: Sink): Promise<SinkHandle> {
  if (kind === 'opfs') {
    const root = await navigator.storage.getDirectory();
    const name = 'spike-out.zip';
    const handle = await root.getFileHandle(name, { create: true });
    const stream = await handle.createWritable({ keepExistingData: false });
    return {
      target: stream,
      finish: async () => {
        const info = await readBack(await handle.getFile());
        await root.removeEntry(name);
        return info;
      },
    };
  }
  if (kind === 'blob') {
    return {
      target: new BlobWriter('application/zip'),
      finish: (closeResult) =>
        closeResult instanceof Blob
          ? readBack(closeResult)
          : Promise.resolve({ bytes: -1, entries: -1, zip64: false }),
    };
  }
  let bytes = 0;
  return {
    target: new WritableStream<Uint8Array>({
      write(chunk) {
        bytes += chunk.byteLength;
      },
    }),
    finish: () => Promise.resolve({ bytes, entries: -1, zip64: false }),
  };
}

function readJsHeap(): number | null {
  const perf = performance as unknown as { memory?: { usedJSHeapSize: number } };
  return perf.memory?.usedJSHeapSize ?? null;
}

const log = (line: string): void => {
  console.log(`[spike] ${line}`);
  const pre = document.getElementById('log');
  if (pre) pre.textContent += line + '\n';
};

export async function run(fileA: File, fileB: File, options: RunOptions): Promise<SpikeResult> {
  const hw = navigator.hardwareConcurrency;
  const workers = options.workers ?? Math.min(hw, 8);
  const inflight = options.inflight ?? workers + 2;
  let heapPeak = readJsHeap();
  const heapTimer = setInterval(() => {
    const now = readJsHeap();
    if (now !== null && (heapPeak === null || now > heapPeak)) heapPeak = now;
  }, 200);

  try {
    const tStart = performance.now();
    const [a, b] = await Promise.all([indexZip(fileA), indexZip(fileB)]);
    const tIndexed = performance.now();
    log(
      `indexed A=${String(a.files.size)} B=${String(b.files.size)} data files in ${(tIndexed - tStart).toFixed(0)} ms`,
    );

    const tasks = plan(a.files, b.files);
    const tPlanned = performance.now();
    const counts = { passThrough: 0, composite: 0, keepA: 0, skipped: a.skipped + b.skipped };
    for (const t of tasks) {
      if (t.kind === 'composite') counts.composite++;
      else if (a.files.has(t.rel) && b.files.has(t.rel)) counts.keepA++;
      else counts.passThrough++;
    }
    log(
      `plan: ${String(counts.passThrough)} pass-through, ${String(counts.composite)} composite, ${String(counts.keepA)} keep-A`,
    );

    const sink = await openSink(options.sink);
    const writer = new ZipWriter(sink.target, { level: 0, keepOrder: false, useWebWorkers: false });
    const pool = new CompositorPool(workers);

    let next = 0;
    let done = 0;
    const runOne = async (task: Task): Promise<void> => {
      if (task.kind === 'pass') {
        // Verbatim copy: raw stored/deflated bytes + all metadata from the source
        // entry. (Measured 2026-09-19: piping through a TransformStream instead
        // of materializing the Blob was ~15% slower and no lighter on memory.)
        const raw = await task.entry.getData(new BlobWriter(), { passThrough: true });
        await writer.add(task.rel, new BlobReader(raw), { passThrough: true, entry: task.entry });
      } else {
        const [older, newer] = await Promise.all([
          task.older.getData(new Uint8ArrayWriter()),
          task.newer.getData(new Uint8ArrayWriter()),
        ]);
        const png = await pool.composite({
          older: older.buffer,
          newer: newer.buffer,
        });
        await writer.add(task.rel, new Uint8ArrayReader(png), {
          level: 0,
          lastModDate: task.newer.lastModDate,
        });
      }
      done++;
      if (done % 500 === 0) log(`  ${String(done)}/${String(tasks.length)} entries written`);
    };
    const lanes = Array.from({ length: Math.min(inflight, tasks.length) }, async () => {
      while (next < tasks.length) {
        const task = tasks[next++];
        if (task) await runOne(task);
      }
    });
    await Promise.all(lanes);
    const tMerged = performance.now();
    pool.terminate();

    const closeResult: unknown = await writer.close();
    const tClosed = performance.now();
    const readback = await sink.finish(closeResult);
    log(
      `wrote ${String(tasks.length)} entries, ${(readback.bytes / 1e6).toFixed(1)} MB, total ${((tClosed - tStart) / 1000).toFixed(1)} s; readback ${String(readback.entries)} entries, zip64=${String(readback.zip64)}`,
    );

    return {
      ua: navigator.userAgent,
      hardwareConcurrency: hw,
      workers,
      inflight,
      sink: options.sink,
      inputs: { a: a.info, b: b.info },
      plan: counts,
      timesMs: {
        index: tIndexed - tStart,
        plan: tPlanned - tIndexed,
        merge: tMerged - tPlanned,
        close: tClosed - tMerged,
        total: tClosed - tStart,
      },
      compositeMs: { ...pool.stats },
      outputBytes: readback.bytes,
      outputEntries: tasks.length,
      readback,
      jsHeapPeakBytes: heapPeak,
    };
  } finally {
    clearInterval(heapTimer);
  }
}

// ---------------------------------------------------------------------------
// Page wiring + automation hook

function fileOf(id: string): File {
  const input = document.getElementById(id);
  const file = input instanceof HTMLInputElement ? input.files?.[0] : undefined;
  if (!file) throw new Error(`no file selected in #${id}`);
  return file;
}

async function runFromPage(options: RunOptions): Promise<SpikeResult> {
  const result = await run(fileOf('fileA'), fileOf('fileB'), options);
  log(JSON.stringify(result, null, 2));
  return result;
}

declare global {
  interface Window {
    spike: { run(options: RunOptions): Promise<SpikeResult> };
  }
}
window.spike = { run: runFromPage };

document.getElementById('run')?.addEventListener('click', () => {
  const select = document.getElementById('sink');
  const sink = select instanceof HTMLSelectElement ? (select.value as Sink) : 'discard';
  runFromPage({ sink }).catch((err: unknown) => {
    log(`ERROR ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  });
});
