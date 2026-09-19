/**
 * Pipeline driver: executes a merge plan against two open archives into an
 * archive writer, with bounded concurrency, progress, and cancellation.
 * Browser-agnostic: the compositor is injected (worker pool in the app,
 * sharp in tests).
 */
import type { Compositor } from '../merge/compositor.ts';
import type { MergePlan, PlanSummary, PlanTask, Side } from '../merge/types.ts';
import type { Archive, ArchiveEntry } from '../zip/reader.ts';
import type { ArchiveWriter } from '../zip/writer.ts';

export interface MergeProgress {
  readonly done: number;
  readonly total: number;
  readonly copied: number;
  readonly composited: number;
}

export interface ExecuteOptions {
  readonly compositor: Compositor;
  /** Tasks in flight at once; default compositor-friendly 10. */
  readonly concurrency?: number;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: MergeProgress) => void;
}

export interface MergeResult {
  readonly written: number;
  readonly copied: number;
  readonly composited: number;
  /** Tiles that could not be composited (undecodable input); the newer was copied verbatim. */
  readonly compositeFailures: readonly string[];
  readonly outputRoot: string;
  readonly summary: PlanSummary;
}

export async function executeMergePlan(
  plan: MergePlan<ArchiveEntry>,
  archives: Readonly<Record<Side, Archive>>,
  writer: ArchiveWriter,
  options: ExecuteOptions,
): Promise<MergeResult> {
  const { compositor, signal, onProgress } = options;
  const concurrency = Math.max(1, options.concurrency ?? 10);
  const tasks = plan.tasks;
  let next = 0;
  let done = 0;
  let copied = 0;
  let composited = 0;
  const compositeFailures: string[] = [];

  const throwIfAborted = (): void => {
    if (signal?.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new DOMException('Merge cancelled.', 'AbortError');
    }
  };

  const runOne = async (task: PlanTask<ArchiveEntry>): Promise<void> => {
    const outPath = `${plan.outputRoot}/${task.rel}`;
    if (task.kind === 'copy') {
      const archive = archives[task.from];
      const raw = await archive.readRaw(task.file.entry);
      throwIfAborted();
      await writer.copyEntry(outPath, task.file.entry, raw);
      copied++;
    } else {
      const [older, newer] = await Promise.all([
        archives[task.older.from].readBytes(task.older.file.entry),
        archives[task.newer.from].readBytes(task.newer.file.entry),
      ]);
      throwIfAborted();
      let png: Uint8Array | undefined;
      try {
        png = await compositor.composite(older, newer);
      } catch {
        // Undecodable tile on one side. Never drop the path: fall back to a
        // verbatim copy of the newer tile and report it.
        compositeFailures.push(task.rel);
      }
      throwIfAborted();
      if (png) {
        await writer.addBytes(outPath, png, new Date(task.newer.file.entry.mtime));
        composited++;
      } else {
        const archive = archives[task.newer.from];
        const raw = await archive.readRaw(task.newer.file.entry);
        await writer.copyEntry(outPath, task.newer.file.entry, raw);
        copied++;
      }
    }
    done++;
    onProgress?.({ done, total: tasks.length, copied, composited });
  };

  const lanes = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    while (next < tasks.length) {
      throwIfAborted();
      const task = tasks[next++];
      if (task) await runOne(task);
    }
  });
  await Promise.all(lanes);

  return {
    written: done,
    copied,
    composited,
    compositeFailures,
    outputRoot: plan.outputRoot,
    summary: plan.summary,
  };
}
