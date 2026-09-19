import { expect, test } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { FIXTURES, ensureSmallFixtures, loadBothMaps, tmpDir, writeZip } from './helpers.ts';

test.beforeAll(() => {
  ensureSmallFixtures();
});

test('a file that is not a zip gets a plain message and no hang', async ({ page }) => {
  const garbage = path.join(tmpDir(), 'garbage.zip');
  writeFileSync(garbage, randomBytes(64 * 1024));
  await page.goto('/');
  await page.getByTestId('file-a').setInputFiles(garbage);
  await expect(page.getByTestId('info-a')).toHaveText(
    'garbage.zip is not a zip archive, or it is damaged.',
  );
  await expect(page.getByTestId('merge')).toBeDisabled();
});

test('a zip without JourneyMap data says so', async ({ page }) => {
  const zip = await writeZip(path.join(tmpDir(), 'photos.zip'), {
    'README.txt': 'hi',
    'photos/cat.png': 'x',
  });
  await page.goto('/');
  await page.getByTestId('file-b').setInputFiles(zip);
  await expect(page.getByTestId('info-b')).toContainText('No JourneyMap map data found');
  await expect(page.getByTestId('merge')).toBeDisabled();
});

test('a zip with several map folders offers a choice', async ({ page }) => {
  const zip = await writeZip(path.join(tmpDir(), 'two-worlds.zip'), {
    'journeymap/data/mp/server~one/DIM0/day/0,0.png': 'a',
    'journeymap/data/mp/server~one/DIM0/day/1,0.png': 'a',
    'journeymap/data/mp/server~two/DIM0/day/0,0.png': 'b',
  });
  await page.goto('/');
  await page.getByTestId('file-a').setInputFiles(zip);
  await expect(page.getByTestId('info-a')).toContainText('Several map folders found');
  const select = page.getByTestId('root-a');
  await expect(select).toBeVisible();
  await expect(select.locator('option')).toHaveCount(2);
  await expect(select.locator('option').first()).toContainText('server~one');
  await select.selectOption('1');
});

test('browsers without a streaming save get a size warning that can be continued', async ({
  page,
}) => {
  await page.goto('/?save=download&limit=1000');
  await loadBothMaps(page, path.join(FIXTURES, 'A.zip'), path.join(FIXTURES, 'B.zip'));
  await page.getByTestId('merge').click();
  const warning = page.getByTestId('warning');
  await expect(warning).toBeVisible();
  await expect(warning).toContainText('builds the whole file in memory');
  const downloadPromise = page.waitForEvent('download');
  await page.getByTestId('continue').click();
  await downloadPromise;
  await expect(page.getByTestId('summary')).toBeVisible();
});
