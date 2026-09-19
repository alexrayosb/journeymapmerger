/**
 * Spike compositor worker: draw the older tile, then the newer tile over it
 * (source-over = newer-wins per pixel, transparent pixels let the older
 * through), re-encode as PNG. One job at a time per worker.
 */
/** PNG bytes; the ArrayBuffers are transferred, not copied. */
export interface CompositeJob {
  older: ArrayBuffer;
  newer: ArrayBuffer;
}

export interface CompositeResult {
  png: ArrayBuffer;
  decodeMs: number;
  drawMs: number;
  encodeMs: number;
}

const decodeOptions: ImageBitmapOptions = {
  premultiplyAlpha: 'none',
  colorSpaceConversion: 'none',
};

async function composite(job: CompositeJob): Promise<CompositeResult> {
  const t0 = performance.now();
  const [older, newer] = await Promise.all([
    createImageBitmap(new Blob([job.older], { type: 'image/png' }), decodeOptions),
    createImageBitmap(new Blob([job.newer], { type: 'image/png' }), decodeOptions),
  ]);
  const t1 = performance.now();
  const canvas = new OffscreenCanvas(
    Math.max(older.width, newer.width),
    Math.max(older.height, newer.height),
  );
  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) throw new Error('no 2d context in worker');
  ctx.drawImage(older, 0, 0);
  ctx.drawImage(newer, 0, 0);
  older.close();
  newer.close();
  const t2 = performance.now();
  const png = await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer();
  const t3 = performance.now();
  return { png, decodeMs: t1 - t0, drawMs: t2 - t1, encodeMs: t3 - t2 };
}

self.onmessage = (event: MessageEvent<CompositeJob>) => {
  composite(event.data).then(
    (result) => {
      self.postMessage(result, { transfer: [result.png] });
    },
    (error: unknown) => {
      self.postMessage({ error: error instanceof Error ? error.message : String(error) });
    },
  );
};
