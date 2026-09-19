/**
 * The compositor contract: two PNG tiles in (older, newer), one PNG out
 * with the newer drawn over the older. Implemented by the browser worker
 * pool (OffscreenCanvas) and, in tests, by sharp.
 */
export interface Compositor {
  composite(older: Uint8Array, newer: Uint8Array): Promise<Uint8Array>;
  dispose(): void;
}
