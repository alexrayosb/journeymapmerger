/**
 * A fixed pool of compositor workers behind the Compositor interface.
 * Jobs wait for a free worker; buffers are transferred both ways.
 */
import type { Compositor } from '../merge/compositor.ts';
import type { CompositeRequest, CompositeResponse } from './messages.ts';

export const DEFAULT_POOL_SIZE = Math.min(navigator.hardwareConcurrency || 4, 8);

export class CompositorPool implements Compositor {
  private readonly idle: Worker[] = [];
  private readonly all: Worker[] = [];
  private readonly waiting: ((w: Worker) => void)[] = [];
  private nextId = 1;
  private disposed = false;

  constructor(size: number = DEFAULT_POOL_SIZE) {
    for (let i = 0; i < Math.max(1, size); i++) {
      const worker = new Worker(new URL('./compositor.worker.ts', import.meta.url), {
        type: 'module',
      });
      this.all.push(worker);
      this.idle.push(worker);
    }
  }

  get size(): number {
    return this.all.length;
  }

  async composite(older: Uint8Array, newer: Uint8Array): Promise<Uint8Array> {
    if (this.disposed) throw new Error('compositor pool disposed');
    const worker = await this.acquire();
    try {
      const request: CompositeRequest = {
        id: this.nextId++,
        older: toArrayBuffer(older),
        newer: toArrayBuffer(newer),
      };
      const response = await new Promise<CompositeResponse>((resolve, reject) => {
        worker.onmessage = (e: MessageEvent<CompositeResponse>) => {
          if (e.data.id === request.id) resolve(e.data);
        };
        worker.onerror = (e) => {
          reject(new Error(e.message || 'compositor worker crashed'));
        };
        worker.postMessage(request, [request.older, request.newer]);
      });
      if (!response.ok) throw new Error(`composite failed: ${response.error}`);
      return new Uint8Array(response.png);
    } finally {
      this.release(worker);
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const w of this.all) w.terminate();
    this.all.length = 0;
    this.idle.length = 0;
  }

  private acquire(): Promise<Worker> {
    const w = this.idle.pop();
    if (w) return Promise.resolve(w);
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  private release(w: Worker): void {
    if (this.disposed) return;
    const next = this.waiting.shift();
    if (next) next(w);
    else this.idle.push(w);
  }
}

/** A standalone ArrayBuffer holding exactly these bytes (copies only when the view is a slice). */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength &&
    bytes.buffer instanceof ArrayBuffer
  ) {
    return bytes.buffer;
  }
  return bytes.slice().buffer;
}
