/**
 * One map input: a file picker, what was found in the zip, and a folder
 * choice when the zip holds several map folders. Used for Map A, Map B and
 * the preview.
 */
import { detectWorldRoots } from '../merge/detect.ts';
import type { WorldRoot } from '../merge/types.ts';
import { ArchiveError, openArchive, type Archive } from '../zip/reader.ts';
import { el } from './dom.ts';
import { formatInt } from './format.ts';

export interface MapPickerState {
  file: File | null;
  archive: Archive | null;
  roots: WorldRoot[];
  chosen: WorldRoot | null;
}

export interface MapPicker {
  readonly element: HTMLFieldSetElement;
  readonly state: MapPickerState;
  onChange(listener: () => void): void;
  setDisabled(disabled: boolean): void;
}

const rootName = (root: WorldRoot): string => (root.name === '' ? 'zip root' : root.name);

const describe = (root: WorldRoot): string =>
  `${formatInt(root.tiles)} tiles, ${formatInt(root.waypoints)} waypoints, ${String(root.dims.length)} ${root.dims.length === 1 ? 'dimension' : 'dimensions'}`;

export function createMapPicker(key: string, title: string, hint: string): MapPicker {
  const state: MapPickerState = { file: null, archive: null, roots: [], chosen: null };
  const listeners: (() => void)[] = [];
  const notify = (): void => {
    for (const fn of listeners) fn();
  };

  const input = el('input', {
    type: 'file',
    accept: '.zip,application/zip',
    id: `file-${key}`,
    testId: `file-${key}`,
  });
  const info = el('p', { className: 'side-info', testId: `info-${key}` });
  const rootSelect = el('select', { id: `root-${key}`, hidden: true, testId: `root-${key}` });

  rootSelect.addEventListener('change', () => {
    state.chosen = state.roots[Number(rootSelect.value)] ?? null;
    notify();
  });

  input.addEventListener('change', () => {
    void (async () => {
      state.file = input.files?.[0] ?? null;
      state.chosen = null;
      state.roots = [];
      rootSelect.hidden = true;
      rootSelect.replaceChildren();
      if (state.archive) {
        await state.archive.close();
        state.archive = null;
      }
      notify();
      if (!state.file) {
        info.textContent = '';
        return;
      }
      info.textContent = 'Reading the zip.';
      try {
        state.archive = await openArchive(state.file, state.file.name);
      } catch (err) {
        info.textContent = err instanceof ArchiveError ? err.message : 'Could not read this file.';
        return;
      }
      state.roots = detectWorldRoots(state.archive.entries);
      if (state.roots.length === 0) {
        info.textContent =
          'No JourneyMap map data found in this zip. Zip the folder inside journeymap/data/mp/ and try again.';
        return;
      }
      state.chosen = state.roots[0] ?? null;
      if (state.roots.length === 1 && state.chosen) {
        info.textContent = `Map folder ${rootName(state.chosen)}. ${describe(state.chosen)}.`;
      } else {
        info.textContent = 'Several map folders found. Pick the one to merge.';
        rootSelect.replaceChildren(
          ...state.roots.map((root, i) =>
            el('option', { value: String(i), textContent: `${rootName(root)}. ${describe(root)}` }),
          ),
        );
        rootSelect.hidden = false;
      }
      notify();
    })();
  });

  const element = el('fieldset', { className: 'side', testId: `picker-${key}` }, [
    el('legend', { textContent: title }),
    el('p', { className: 'hint', textContent: hint }),
    el('label', { htmlFor: `file-${key}`, textContent: 'Zip file ' }),
    input,
    info,
    rootSelect,
  ]);

  return {
    element,
    state,
    onChange: (listener) => {
      listeners.push(listener);
    },
    setDisabled: (disabled) => {
      input.disabled = disabled;
      rootSelect.disabled = disabled;
    },
  };
}
