/**
 * Minimal merge form: two file pickers, map-folder choice per side, who
 * wins on overlap, a merge button, progress and result text. Thin shell
 * over the pipeline; all strings plain and terse.
 */
import { detectWorldRoots } from '../merge/detect.ts';
import { buildMergePlan } from '../merge/plan.ts';
import type { Priority, WorldRoot } from '../merge/types.ts';
import { indexWorld } from '../merge/world-index.ts';
import { CompositorPool } from '../workers/pool.ts';
import { executeMergePlan } from '../workers/pipeline.ts';
import { ArchiveError, openArchive, type Archive } from '../zip/reader.ts';
import { pickSaveTarget } from '../zip/save.ts';
import { ArchiveWriter } from '../zip/writer.ts';

interface SideState {
  file: File | null;
  archive: Archive | null;
  roots: WorldRoot[];
  chosen: WorldRoot | null;
}

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { className?: string } = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children);
  return node;
};

const formatBytes = (n: number): string =>
  n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1e6)).toString()} MB`;

const rootLabel = (root: WorldRoot): string => {
  const name = root.name === '' ? 'zip root' : root.name;
  return `${name} (${String(root.tiles)} tiles, ${String(root.waypoints)} waypoints)`;
};

export function mountMergeForm(container: HTMLElement): void {
  const sides: Record<'a' | 'b', SideState> = {
    a: { file: null, archive: null, roots: [], chosen: null },
    b: { file: null, archive: null, roots: [], chosen: null },
  };
  const forceDownload = new URLSearchParams(location.search).get('save') === 'download';

  const status = el('p', { className: 'status' });
  const mergeButton = el('button', { type: 'button', textContent: 'Merge' });
  mergeButton.disabled = true;

  const priority = el('select', { id: 'priority' }, [
    el('option', { value: 'auto', textContent: 'Newer tile wins (by file date)' }),
    el('option', { value: 'a', textContent: 'Map A wins where both explored' }),
    el('option', { value: 'b', textContent: 'Map B wins where both explored' }),
  ]);

  const setStatus = (text: string): void => {
    status.textContent = text;
  };

  const refreshButton = (): void => {
    mergeButton.disabled = !(sides.a.chosen && sides.b.chosen);
  };

  const sideBlock = (side: 'a' | 'b'): HTMLElement => {
    const state = sides[side];
    const input = el('input', { type: 'file', accept: '.zip,application/zip', id: `file-${side}` });
    const info = el('p', { className: 'side-info' });
    const rootSelect = el('select', { id: `root-${side}`, hidden: true });

    rootSelect.addEventListener('change', () => {
      state.chosen = state.roots[Number(rootSelect.value)] ?? null;
      refreshButton();
    });

    input.addEventListener('change', () => {
      void (async () => {
        state.file = input.files?.[0] ?? null;
        state.chosen = null;
        state.roots = [];
        rootSelect.hidden = true;
        rootSelect.replaceChildren();
        refreshButton();
        if (state.archive) {
          await state.archive.close();
          state.archive = null;
        }
        if (!state.file) {
          info.textContent = '';
          return;
        }
        info.textContent = 'Reading…';
        try {
          state.archive = await openArchive(state.file, state.file.name);
        } catch (err) {
          info.textContent =
            err instanceof ArchiveError ? err.message : 'Could not read this file.';
          return;
        }
        state.roots = detectWorldRoots(state.archive.entries);
        if (state.roots.length === 0) {
          info.textContent = 'No JourneyMap map data found in this zip.';
          return;
        }
        state.chosen = state.roots[0] ?? null;
        if (state.roots.length === 1 && state.chosen) {
          info.textContent = `Map folder ${rootLabel(state.chosen)}`;
        } else {
          info.textContent = 'Several map folders found. Pick one.';
          rootSelect.replaceChildren(
            ...state.roots.map((root, i) =>
              el('option', { value: String(i), textContent: rootLabel(root) }),
            ),
          );
          rootSelect.hidden = false;
        }
        refreshButton();
      })();
    });

    return el('fieldset', {}, [
      el('legend', { textContent: `Map ${side.toUpperCase()}` }),
      el('label', { htmlFor: `file-${side}`, textContent: 'Zip file ' }),
      input,
      info,
      rootSelect,
    ]);
  };

  mergeButton.addEventListener('click', () => {
    void (async () => {
      const { a, b } = sides;
      if (!a.archive || !b.archive || !a.chosen || !b.chosen) return;
      const plan = buildMergePlan(
        indexWorld(a.archive.entries, a.chosen),
        indexWorld(b.archive.entries, b.chosen),
        {
          priority: priority.value as Priority,
        },
      );
      const suggestedName = `${plan.outputRoot}-merged.zip`;

      // First await in the handler: the save dialog needs the click's user activation.
      const target = await pickSaveTarget(suggestedName, { forceDownload });
      if (!target) {
        setStatus('Cancelled.');
        return;
      }

      mergeButton.disabled = true;
      const { summary } = plan;
      setStatus(
        `Merging ${String(plan.tasks.length)} entries, about ${formatBytes(summary.estimatedOutputBytes)}.`,
      );
      const writer = new ArchiveWriter(target.writerTarget);
      const pool = new CompositorPool();
      try {
        const result = await executeMergePlan(plan, { a: a.archive, b: b.archive }, writer, {
          compositor: pool,
          onProgress: (p) => {
            if (p.done % 50 === 0 || p.done === p.total) {
              setStatus(`Written ${String(p.done)} of ${String(p.total)} entries.`);
            }
          },
        });
        const closed = await writer.close();
        await target.finish(closed);
        const tiles = summary.tilesCopied + summary.tilesComposited;
        const failed = result.compositeFailures.length;
        setStatus(
          `Done. ${String(tiles)} tiles (${String(result.composited)} combined), ` +
            `${String(summary.waypoints)} waypoints, saved as ${suggestedName}.` +
            (failed > 0
              ? ` ${String(failed)} tiles could not be combined and were copied from the newer map.`
              : ''),
        );
      } catch (err) {
        await target.abort();
        setStatus(`Merge failed. ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        pool.dispose();
        refreshButton();
      }
    })();
  });

  container.append(
    el('form', { className: 'merge-form' }, [
      sideBlock('a'),
      sideBlock('b'),
      el('p', {}, [
        el('label', {
          htmlFor: 'priority',
          textContent: 'Where both maps explored the same area ',
        }),
        priority,
      ]),
      el('p', {}, [mergeButton]),
      status,
    ]),
  );
  container.querySelector('form')?.addEventListener('submit', (e) => {
    e.preventDefault();
  });
}
