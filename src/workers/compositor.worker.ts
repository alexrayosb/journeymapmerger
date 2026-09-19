/**
 * Compositor worker: decode both tiles, draw the older then the newer onto
 * an OffscreenCanvas (source-over = newer wins per pixel, transparent
 * pixels let the older through), encode PNG. One job at a time per worker.
 *
 * Decode options keep pixel values untouched: no alpha premultiplication,
 * no colour-space conversion. JourneyMap pixels are fully opaque or fully
 * transparent, so source-over is exact for them.
 */
import type { CompositeRequest, CompositeResponse } from './messages.ts';

const DECODE: ImageBitmapOptions = { premultiplyAlpha: 'none', colorSpaceConversion: 'none' };

async function composite(request: CompositeRequest): Promise<ArrayBuffer> {
  const [older, newer] = await Promise.all([
    createImageBitmap(new Blob([request.older], { type: 'image/png' }), DECODE),
    createImageBitmap(new Blob([request.newer], { type: 'image/png' }), DECODE),
  ]);
  try {
    const canvas = new OffscreenCanvas(
      Math.max(older.width, newer.width),
      Math.max(older.height, newer.height),
    );
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) throw new Error('OffscreenCanvas 2d context unavailable');
    ctx.drawImage(older, 0, 0);
    ctx.drawImage(newer, 0, 0);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    return await blob.arrayBuffer();
  } finally {
    older.close();
    newer.close();
  }
}

self.onmessage = (event: MessageEvent<CompositeRequest>) => {
  const { id } = event.data;
  composite(event.data).then(
    (png) => {
      const response: CompositeResponse = { id, ok: true, png };
      self.postMessage(response, { transfer: [png] });
    },
    (error: unknown) => {
      const response: CompositeResponse = {
        id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
      self.postMessage(response);
    },
  );
};
