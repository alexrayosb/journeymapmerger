/**
 * Shared types for the merge engine. Pure: no DOM, no zip.js.
 *
 * The zip layer supplies entries that satisfy `EntryInfo` (and may carry
 * extra fields, such as a zip.js handle); the pure modules only ever read
 * `path`, `size` and `mtime`, and pass the objects through unchanged.
 */

export interface EntryInfo {
  /** Normalized archive path: '/' separators, no leading slash, no '.'/'..' segments. */
  readonly path: string;
  /** Uncompressed size in bytes. */
  readonly size: number;
  /** Last modification time in milliseconds since the epoch. */
  readonly mtime: number;
}

/** One region tile inside a dimension layer. */
export interface TileRef {
  /** Dimension folder name, e.g. "DIM0", "DIM-1", "DIM7". */
  readonly dim: string;
  /** "day" | "night" | "topo" | a cave slice "0".."15". */
  readonly layer: string;
  readonly rx: number;
  readonly rz: number;
}

export type Classified =
  | { readonly kind: 'tile'; readonly tile: TileRef }
  | { readonly kind: 'waypoint'; readonly id: string }
  | { readonly kind: 'other' };

/** A candidate world folder inside an archive. */
export interface WorldRoot {
  /** Path prefix including the trailing '/', or '' when the world sits at the zip root. */
  readonly prefix: string;
  /** Folder name shown to the user (last segment of the prefix), '' at the zip root. */
  readonly name: string;
  readonly dims: readonly string[];
  readonly tiles: number;
  readonly waypoints: number;
  readonly others: number;
}

export interface IndexedFile<E extends EntryInfo = EntryInfo> {
  /** Path relative to the world root. */
  readonly rel: string;
  readonly entry: E;
  readonly classified: Classified;
}

export interface WorldIndex<E extends EntryInfo = EntryInfo> {
  readonly root: WorldRoot;
  readonly files: ReadonlyMap<string, IndexedFile<E>>;
  /** Entries dropped because a later entry had the same path. */
  readonly duplicates: number;
}

export type Side = 'a' | 'b';

/** Who wins where both inputs have the same tile: mtime, or a forced side. */
export type Priority = 'auto' | 'a' | 'b';

export type PlanTask<E extends EntryInfo = EntryInfo> =
  | {
      readonly kind: 'copy';
      readonly rel: string;
      readonly from: Side;
      readonly file: IndexedFile<E>;
    }
  | {
      readonly kind: 'composite';
      readonly rel: string;
      readonly tile: TileRef;
      readonly older: { readonly from: Side; readonly file: IndexedFile<E> };
      readonly newer: { readonly from: Side; readonly file: IndexedFile<E> };
    };

export interface PlanSummary {
  readonly tilesCopied: number;
  readonly tilesComposited: number;
  readonly waypoints: number;
  /** Waypoint files present in both inputs (one copy written). */
  readonly waypointsShared: number;
  readonly others: number;
  readonly dims: readonly string[];
  /** Rough output size: copies at full size, composites at the larger input's size. */
  readonly estimatedOutputBytes: number;
}

export interface MergePlan<E extends EntryInfo = EntryInfo> {
  /** Output folder name every entry is written under (never empty). */
  readonly outputRoot: string;
  readonly tasks: readonly PlanTask<E>[];
  readonly summary: PlanSummary;
}
