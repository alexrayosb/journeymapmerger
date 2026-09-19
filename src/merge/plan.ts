/**
 * The merge plan: what to do with every relative path. Pure, deterministic
 * (tasks sorted by path), and the place the never-lose-data rule is made
 * true by construction: every file in either index yields exactly one task.
 */
import { compareDims } from './detect.ts';
import type {
  EntryInfo,
  IndexedFile,
  MergePlan,
  PlanSummary,
  PlanTask,
  Priority,
  Side,
  WorldIndex,
} from './types.ts';

export interface PlanOptions {
  readonly priority: Priority;
  /** Folder name the output is written under; default A's folder, else "merged". */
  readonly outputRoot?: string;
}

export const DEFAULT_OUTPUT_ROOT = 'merged';

export function buildMergePlan<E extends EntryInfo>(
  a: WorldIndex<E>,
  b: WorldIndex<E>,
  options: PlanOptions,
): MergePlan<E> {
  const primary: Side = options.priority === 'b' ? 'b' : 'a';
  const rels = new Set<string>([...a.files.keys(), ...b.files.keys()]);
  const sorted = [...rels].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));

  const tasks: PlanTask<E>[] = [];
  const dims = new Set<string>();
  let tilesCopied = 0;
  let tilesComposited = 0;
  let waypoints = 0;
  let waypointsShared = 0;
  let others = 0;
  let estimatedOutputBytes = 0;

  const note = (file: IndexedFile<E>): void => {
    if (file.classified.kind === 'tile') dims.add(file.classified.tile.dim);
  };

  for (const rel of sorted) {
    const fa = a.files.get(rel);
    const fb = b.files.get(rel);
    if (fa && fb) {
      note(fa);
      note(fb);
      if (fa.classified.kind === 'tile' && fb.classified.kind === 'tile') {
        const aNewer =
          options.priority === 'a' ||
          (options.priority === 'auto' && fa.entry.mtime >= fb.entry.mtime);
        tasks.push({
          kind: 'composite',
          rel,
          tile: fa.classified.tile,
          older: aNewer ? { from: 'b', file: fb } : { from: 'a', file: fa },
          newer: aNewer ? { from: 'a', file: fa } : { from: 'b', file: fb },
        });
        tilesComposited++;
        estimatedOutputBytes += Math.max(fa.entry.size, fb.entry.size);
      } else {
        const file = primary === 'a' ? fa : fb;
        tasks.push({ kind: 'copy', rel, from: primary, file });
        if (file.classified.kind === 'waypoint') {
          waypoints++;
          waypointsShared++;
        } else if (file.classified.kind === 'tile') {
          tilesCopied++;
        } else {
          others++;
        }
        estimatedOutputBytes += file.entry.size;
      }
    } else {
      const from: Side = fa ? 'a' : 'b';
      const file = fa ?? fb;
      if (!file) continue; // unreachable: rel came from one of the maps
      note(file);
      tasks.push({ kind: 'copy', rel, from, file });
      if (file.classified.kind === 'tile') tilesCopied++;
      else if (file.classified.kind === 'waypoint') waypoints++;
      else others++;
      estimatedOutputBytes += file.entry.size;
    }
  }

  const summary: PlanSummary = {
    tilesCopied,
    tilesComposited,
    waypoints,
    waypointsShared,
    others,
    dims: [...dims].sort(compareDims),
    estimatedOutputBytes,
  };
  const outputRoot = options.outputRoot ?? (a.root.name !== '' ? a.root.name : DEFAULT_OUTPUT_ROOT);
  return { outputRoot, tasks, summary };
}
