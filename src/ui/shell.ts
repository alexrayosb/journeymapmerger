/**
 * The app shell: heading and one-line explanation, plus the mount point
 * for the merge form.
 *
 * DOM is built with createElement + textContent, never innerHTML, so the
 * user-controlled strings that reach the page (zip entry names) are always
 * rendered escaped.
 */
export function renderShell(root: HTMLElement): HTMLElement {
  const heading = document.createElement('h1');
  heading.textContent = 'JourneyMapMerger';

  const lede = document.createElement('p');
  lede.className = 'lede';
  lede.textContent =
    'Merge two JourneyMap maps into one archive. ' +
    'Your files stay in your browser and are never uploaded.';

  const mount = document.createElement('section');
  mount.id = 'merge';

  root.replaceChildren(heading, lede, mount);
  return mount;
}
