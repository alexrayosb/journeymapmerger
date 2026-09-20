import {
  BlobReader,
  Uint8ArrayReader,
  Uint8ArrayWriter,
  ZipReader,
  ZipWriter,
} from '@zip.js/zip.js';
import type { Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const FIXTURES = path.resolve('fixtures/small');

/**
 * The one third party the site talks to: Cloudflare Web Analytics, injected
 * by Cloudflare on the custom domain (owner's call). Script from the first
 * host, page-view reports to the second. Nothing else may be contacted.
 */
export const ANALYTICS_HOSTS = [
  'https://static.cloudflareinsights.com/',
  'https://cloudflareinsights.com/',
];

export const isAnalytics = (url: string): boolean => ANALYTICS_HOSTS.some((h) => url.startsWith(h));

/** Strings from the fixtures that must never appear in any request body. */
export const FIXTURE_SECRETS = [
  'GTNH~Server~1',
  'our~gtnh~world',
  '.png',
  'waypoints/',
  'journeymap/data',
];

export interface Manifest {
  expected: {
    uniqueTiles: number;
    compositeTiles: number;
    passThroughTiles: number;
    uniqueWaypoints: number;
  };
}

/** Generate the small synthetic fixtures if they are missing (about 2 s). */
export function ensureSmallFixtures(): Manifest {
  const manifest = path.join(FIXTURES, 'manifest.json');
  if (!existsSync(manifest))
    execFileSync('node', ['tools/make-fixtures.ts', 'small'], { stdio: 'inherit' });
  return JSON.parse(readFileSync(manifest, 'utf8')) as Manifest;
}

export function hasInfoZip(): boolean {
  try {
    execFileSync('unzip', ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export const tmpDir = (): string => mkdtempSync(path.join(os.tmpdir(), 'jm-e2e-'));

/** A zip file on disk with the given entries (zip.js, stored). */
export async function writeZip(file: string, entries: Record<string, string>): Promise<string> {
  const zip = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false });
  for (const [name, content] of Object.entries(entries)) {
    await zip.add(name, new Uint8ArrayReader(new TextEncoder().encode(content)), { level: 0 });
  }
  writeFileSync(file, await zip.close());
  return file;
}

export async function countEntries(file: string): Promise<number> {
  const reader = new ZipReader(new BlobReader(new Blob([readFileSync(file)])), {
    useWebWorkers: false,
  });
  const entries = await reader.getEntries();
  await reader.close();
  return entries.filter((e) => !e.directory).length;
}

/** Pick both fixture zips and wait until each side reports its map folder. */
export async function loadBothMaps(page: Page, zipA: string, zipB: string): Promise<void> {
  await page.getByTestId('file-a').setInputFiles(zipA);
  await page.getByTestId('file-b').setInputFiles(zipB);
  await page
    .getByTestId('info-a')
    .filter({ hasText: /^Map folder/ })
    .waitFor();
  await page
    .getByTestId('info-b')
    .filter({ hasText: /^Map folder/ })
    .waitFor();
}
