/**
 * The app shell: static copy only. The upload/pairing/progress/preview
 * components mount into this as they land.
 *
 * DOM is built with createElement + textContent, never innerHTML, so the
 * one day user-controlled strings (zip entry names) show up here they are
 * always rendered escaped.
 */
export function renderShell(root: HTMLElement): void {
  const heading = document.createElement('h1');
  heading.textContent = 'JourneyMapMerger';

  const lede = document.createElement('p');
  lede.className = 'lede';
  lede.textContent =
    'Merge two players’ JourneyMap maps into one archive. ' +
    'Your files stay in your browser and are never uploaded.';

  const status = document.createElement('p');
  status.className = 'status';
  status.textContent = 'Not ready yet.';

  root.replaceChildren(heading, lede, status);
}
