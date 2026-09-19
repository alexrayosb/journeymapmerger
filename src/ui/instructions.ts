import { el } from './dom.ts';

/** Collapsed by default. Plain steps for finding and zipping the map folder. */
export function renderInstructions(): HTMLDetailsElement {
  const step = (title: string, text: string): HTMLParagraphElement =>
    el('p', {}, [el('strong', { textContent: `${title} ` }), text]);

  return el('details', { className: 'howto', testId: 'howto' }, [
    el('summary', { textContent: 'How to get your map zip' }),
    el('p', {
      textContent: 'Zip each map folder you want to merge, then pick the two zips below.',
    }),
    step(
      'Find the folder.',
      'Open the Minecraft folder of your GTNH instance. In Prism Launcher or MultiMC, right-click the instance and choose Folder, then open .minecraft. ' +
        'Inside, go to journeymap, then data, then mp. There is one folder per server, named the way you typed the server into your server list.',
    ),
    step(
      'Zip it.',
      'On Windows, right-click that server folder, choose Send to, then Compressed (zipped) folder. On Windows 11 the item is Compress to ZIP file. ' +
        'On macOS, right-click the folder and choose Compress. On Linux, right-click, choose Compress and pick zip.',
    ),
    step(
      'Get the second zip the same way.',
      'Zipping a folder above the map folder, such as the whole journeymap folder, also works. Zips of several gigabytes are expected.',
    ),
  ]);
}
