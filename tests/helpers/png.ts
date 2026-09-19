import sharp from 'sharp';

export type Rgba = readonly [number, number, number, number];
export const CLEAR: Rgba = [0, 0, 0, 0];

/** Build a PNG from a per-pixel paint function. */
export async function makePng(
  width: number,
  height: number,
  paint: (x: number, y: number) => Rgba,
): Promise<Uint8Array> {
  const raw = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = paint(x, y);
      raw.set([r, g, b, a], (y * width + x) * 4);
    }
  }
  const png = await sharp(raw, { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer();
  return new Uint8Array(png);
}

export interface Pixels {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
  at(x: number, y: number): Rgba;
}

export async function readPixels(png: Uint8Array): Promise<Pixels> {
  const { data, info } = await sharp(Buffer.from(png))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const bytes = new Uint8Array(data);
  return {
    width: info.width,
    height: info.height,
    data: bytes,
    at(x, y) {
      const i = (y * info.width + x) * 4;
      return [bytes[i] ?? 0, bytes[i + 1] ?? 0, bytes[i + 2] ?? 0, bytes[i + 3] ?? 0];
    },
  };
}
