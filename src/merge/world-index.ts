/**
 * Build the relative-path index of one world root. Pure.
 */
import { classifyWorldPath } from './paths.ts';
import type { EntryInfo, IndexedFile, WorldIndex, WorldRoot } from './types.ts';

export function indexWorld<E extends EntryInfo>(
  entries: readonly E[],
  root: WorldRoot,
): WorldIndex<E> {
  const files = new Map<string, IndexedFile<E>>();
  let duplicates = 0;
  for (const entry of entries) {
    if (!entry.path.startsWith(root.prefix)) continue;
    const rel = entry.path.slice(root.prefix.length);
    if (rel === '') continue;
    if (files.has(rel)) duplicates++; // later entry wins, as extractors do
    files.set(rel, { rel, entry, classified: classifyWorldPath(rel) });
  }
  return { root, files, duplicates };
}
