import { expect, test } from '@playwright/test';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  FIXTURES,
  countEntries,
  ensureSmallFixtures,
  hasInfoZip,
  loadBothMaps,
  tmpDir,
  type Manifest,
} from './helpers.ts';

let manifest: Manifest;
const zipA = path.join(FIXTURES, 'A.zip');
const zipB = path.join(FIXTURES, 'B.zip');

test.beforeAll(() => {
  manifest = ensureSmallFixtures();
});

test('merges two maps, downloads the archive, and never talks to another host', async ({
  page,
  baseURL,
}) => {
  const origin = new URL(baseURL ?? 'http://localhost:4173').origin;
  const requests: { url: string; method: string; body: string | null }[] = [];
  page.on('request', (r) =>
    requests.push({ url: r.url(), method: r.method(), body: r.postData() }),
  );

  await page.goto('/?save=download');
  await loadBothMaps(page, zipA, zipB);
  await expect(page.getByTestId('info-a')).toContainText('GTNH~Server~1');
  await expect(page.getByTestId('merge')).toBeEnabled();

  const downloadPromise = page.waitForEvent('download');
  await page.getByTestId('merge').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('GTNH~Server~1-merged.zip');
  const saved = path.join(tmpDir(), 'merged.zip');
  await download.saveAs(saved);

  const summary = page.getByTestId('summary');
  await expect(summary).toBeVisible();
  const { expected } = manifest;
  await expect(summary).toContainText(`${expected.uniqueTiles.toLocaleString('en-US')} tiles`);
  await expect(summary).toContainText(
    `${expected.compositeTiles.toLocaleString('en-US')} of them combined`,
  );
  await expect(summary).toContainText(`${String(expected.uniqueWaypoints)} waypoints`);
  await expect(summary).toContainText('rename your current folder');
  await expect(page.getByTestId('progress')).toBeHidden();
  await expect(page.getByTestId('cancel')).toBeHidden();

  expect(await countEntries(saved)).toBe(expected.uniqueTiles + expected.uniqueWaypoints + 1);

  const offOrigin = requests.filter((r) => !r.url.startsWith(origin));
  const withBody = requests.filter((r) => r.method !== 'GET' || r.body);
  expect(offOrigin).toEqual([]);
  expect(withBody).toEqual([]);

  test.skip(!hasInfoZip(), 'reference comparison needs Info-ZIP');
  const reference = path.join(FIXTURES, 'reference-auto.zip');
  if (!existsSync(reference)) {
    execFileSync('node', ['tools/reference-merge.ts', zipA, zipB, reference], { stdio: 'inherit' });
  }
  const cmp = spawnSync('node', ['tools/compare-archives.ts', saved, reference], {
    encoding: 'utf8',
  });
  expect(cmp.stdout).toContain('0 mismatches');
  expect(cmp.status).toBe(0);
});

test('a forced priority still produces a complete archive', async ({ page }) => {
  await page.goto('/?save=download');
  await loadBothMaps(page, zipA, zipB);
  await page.getByTestId('priority').selectOption('a');
  const downloadPromise = page.waitForEvent('download');
  await page.getByTestId('merge').click();
  const download = await downloadPromise;
  const saved = path.join(tmpDir(), 'merged-a.zip');
  await download.saveAs(saved);
  await expect(page.getByTestId('summary')).toBeVisible();
  expect(await countEntries(saved)).toBe(
    manifest.expected.uniqueTiles + manifest.expected.uniqueWaypoints + 1,
  );
});
