/**
 * Decoded tile bitmaps for the viewer. Full-size bitmaps live in a small
 * LRU (1 MB each); 64 px thumbnails are kept for every tile ever decoded so
 * zoomed-out views of thousands of tiles stay cheap. Loads are bounded and
 * re-prioritized on every frame: only tiles the viewer still wants load.
 */
export const THUMB_SIZE = 64;
const FULL_CAPACITY = 192;
const MAX_INFLIGHT = 12;

export interface TileSource {
  /** PNG bytes of a tile, by key. */
  load(key: string): Promise<Uint8Array>;
}

export class TileCache {
  private readonly full = new Map<string, ImageBitmap>(); // insertion order = LRU
  private readonly thumbs = new Map<string, ImageBitmap>();
  private readonly failed = new Set<string>();
  private readonly inflight = new Set<string>();
  private wanted: string[] = [];
  private generation = 0;
  private disposed = false;

  private readonly source: TileSource;
  private readonly onReady: () => void;

  constructor(source: TileSource, onReady: () => void) {
    this.source = source;
    this.onReady = onReady;
  }

  /** Number of tiles decoded so far (for tests and progress text). */
  get loaded(): number {
    return this.thumbs.size;
  }

  /** A bitmap to draw now, preferring the requested size; undefined when not loaded yet. */
  get(key: string, preferThumb: boolean): ImageBitmap | undefined {
    const full = this.full.get(key);
    if (full && !preferThumb) {
      this.full.delete(key);
      this.full.set(key, full); // touch
      return full;
    }
    return this.thumbs.get(key) ?? full;
  }

  has(key: string, needFull: boolean): boolean {
    return needFull ? this.full.has(key) : this.thumbs.has(key) || this.full.has(key);
  }

  /** Replace the load queue with these keys (most urgent first) and pump. */
  want(keys: string[]): void {
    this.wanted = keys.filter((k) => !this.failed.has(k) && !this.inflight.has(k));
    this.pump();
  }

  /** Forget everything; a new archive or layer is coming. */
  reset(): void {
    this.generation++;
    for (const b of this.full.values()) b.close();
    for (const b of this.thumbs.values()) b.close();
    this.full.clear();
    this.thumbs.clear();
    this.failed.clear();
    this.wanted = [];
  }

  dispose(): void {
    this.disposed = true;
    this.reset();
  }

  /** True once disposed or after a reset that happened while a load was in flight. */
  private isStale(generation: number): boolean {
    return this.disposed || generation !== this.generation;
  }

  private pump(): void {
    while (this.inflight.size < MAX_INFLIGHT && this.wanted.length > 0) {
      const key = this.wanted.shift();
      if (key === undefined) break;
      void this.loadOne(key, this.generation);
    }
  }

  private async loadOne(key: string, generation: number): Promise<void> {
    this.inflight.add(key);
    try {
      const bytes = await this.source.load(key);
      const full = await createImageBitmap(new Blob([asBlobPart(bytes)], { type: 'image/png' }));
      if (this.isStale(generation)) {
        full.close();
        return;
      }
      const thumb = await createImageBitmap(full, {
        resizeWidth: THUMB_SIZE,
        resizeHeight: THUMB_SIZE,
        resizeQuality: 'medium',
      });
      if (this.isStale(generation)) {
        full.close();
        thumb.close();
        return;
      }
      this.thumbs.set(key, thumb);
      this.full.set(key, full);
      if (this.full.size > FULL_CAPACITY) {
        for (const oldest of this.full.keys()) {
          this.full.get(oldest)?.close();
          this.full.delete(oldest);
          break;
        }
      }
      this.onReady();
    } catch {
      if (generation === this.generation) this.failed.add(key);
    } finally {
      this.inflight.delete(key);
      if (!this.disposed) this.pump();
    }
  }
}

/** A view over a plain ArrayBuffer, which is what Blob accepts (copies only for SharedArrayBuffer-backed views). */
function asBlobPart(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return bytes.buffer instanceof ArrayBuffer ? (bytes as Uint8Array<ArrayBuffer>) : bytes.slice();
}
