/**
 * The app shell: heading and one-line explanation, plus the mount points
 * for the merge form and the preview panel.
 *
 * DOM is built with createElement + textContent, never innerHTML, so the
 * user-controlled strings that reach the page (zip entry names) are always
 * rendered escaped.
 */
export function renderShell(root: HTMLElement): { merge: HTMLElement; preview: HTMLElement } {
  const heading = document.createElement('h1');
  heading.textContent = 'JourneyMapMerger';

  const lede = document.createElement('p');
  lede.className = 'lede';
  lede.textContent =
    'Merge two JourneyMap maps into one archive. ' +
    'Your files stay in your browser and are never uploaded.';

  const merge = document.createElement('section');
  merge.id = 'merge';
  const mergeTitle = document.createElement('h2');
  mergeTitle.textContent = 'Merge two maps';
  merge.append(mergeTitle);

  const preview = document.createElement('section');
  preview.id = 'preview';
  const previewTitle = document.createElement('h2');
  previewTitle.textContent = 'Preview a map';
  preview.append(previewTitle);

  const footer = document.createElement('footer');
  const source = document.createElement('a');
  source.href = 'https://github.com/alexrayosb/journeymapmerger';
  source.textContent = 'Source on GitHub';
  source.rel = 'noopener';
  footer.append(
    'Open source under the MIT license. Not affiliated with the JourneyMap or GTNH teams. ',
    source,
    '. Cloudflare Web Analytics counts visits. It uses no cookies and never sees your files.',
  );

  root.replaceChildren(heading, lede, merge, preview, footer);
  return { merge, preview };
}

/** Everything the merge and preview need. Old browsers get a plain message instead of a broken form. */
export function missingCapabilities(): string[] {
  const missing: string[] = [];
  if (typeof Worker === 'undefined') missing.push('web workers');
  if (typeof OffscreenCanvas === 'undefined') missing.push('OffscreenCanvas');
  if (typeof createImageBitmap === 'undefined') missing.push('createImageBitmap');
  if (typeof WritableStream === 'undefined' || typeof TransformStream === 'undefined') {
    missing.push('streams');
  }
  if (typeof DecompressionStream === 'undefined') missing.push('DecompressionStream');
  return missing;
}

export function renderUnsupported(root: HTMLElement, missing: readonly string[]): void {
  const heading = document.createElement('h1');
  heading.textContent = 'JourneyMapMerger';
  const text = document.createElement('p');
  text.className = 'status';
  text.textContent =
    'This browser cannot run the merge. Use a current Chrome, Edge, Firefox, or Safari. ' +
    `Missing here ${missing.join(', ')}.`;
  root.replaceChildren(heading, text);
}
