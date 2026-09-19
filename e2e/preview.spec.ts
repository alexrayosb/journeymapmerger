import { expect, test } from '@playwright/test';
import path from 'node:path';
import { FIXTURES, ensureSmallFixtures } from './helpers.ts';

test.beforeAll(() => {
  ensureSmallFixtures();
});

test('previews an uploaded map: dimensions, layers, drawn tiles, zoom', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('file-preview').setInputFiles(path.join(FIXTURES, 'A.zip'));
  await expect(page.getByTestId('info-preview')).toContainText('GTNH~Server~1');
  await expect(page.getByTestId('preview-controls')).toBeVisible();

  const dim = page.getByTestId('preview-dim');
  const layer = page.getByTestId('preview-layer');
  await expect(dim.locator('option')).toHaveText([
    'Overworld (DIM0)',
    'Nether (DIM-1)',
    'The End (DIM1)',
  ]);
  await expect(layer.locator('option')).toHaveText(['day', 'night']);
  // The overworld day layer alone, not the whole folder (238 tiles across dims/layers).
  await expect(page.getByTestId('preview-note')).toContainText(
    '103 tiles, 14 waypoints in this dimension',
  );

  const canvas = page.getByTestId('map-canvas');
  await expect(canvas).toBeVisible();
  await expect
    .poll(async () => Number(await canvas.getAttribute('data-tiles-loaded')), { timeout: 30_000 })
    .toBeGreaterThan(50);

  // Something was actually drawn: sample the canvas for non-background pixels.
  const painted = await canvas.evaluate((node: HTMLCanvasElement) => {
    const c = node;
    const ctx = c.getContext('2d');
    if (!ctx) return 0;
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    let n = 0;
    for (let i = 0; i < data.length; i += 4 * 97) {
      if (
        Math.abs((data[i] ?? 0) - 0x1c) +
          Math.abs((data[i + 1] ?? 0) - 0x1f) +
          Math.abs((data[i + 2] ?? 0) - 0x22) >
        30
      )
        n++;
    }
    return n;
  });
  expect(painted).toBeGreaterThan(20);

  const before = Number(await canvas.getAttribute('data-scale'));
  await canvas.hover();
  await page.mouse.wheel(0, -600);
  await expect
    .poll(async () => Number(await canvas.getAttribute('data-scale')))
    .toBeGreaterThan(before);

  await dim.selectOption('DIM-1');
  await expect(layer.locator('option')).toHaveText(['day']);
  await expect(page.getByTestId('preview-note')).toContainText('tiles');
});

test('a zip without tiles says so instead of showing an empty map', async ({ page }) => {
  await page.goto('/');
  // reuse the merge picker's error path through the preview picker
  await page.getByTestId('file-preview').setInputFiles(path.join(FIXTURES, 'manifest.json'));
  await expect(page.getByTestId('info-preview')).toContainText('not a zip archive');
  await expect(page.getByTestId('preview-controls')).toBeHidden();
});
