import sharp from 'sharp';
import type { Compositor } from '../../src/merge/compositor.ts';

/** Test-side compositor: sharp's "over" blend, newer on top. */
export const sharpCompositor: Compositor = {
  async composite(older, newer) {
    const out = await sharp(Buffer.from(older))
      .composite([{ input: Buffer.from(newer), blend: 'over' }])
      .png()
      .toBuffer();
    return new Uint8Array(out);
  },
  dispose() {
    /* nothing to release */
  },
};
