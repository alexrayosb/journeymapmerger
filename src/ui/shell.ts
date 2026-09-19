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

  root.replaceChildren(heading, lede, merge, preview);
  return { merge, preview };
}
