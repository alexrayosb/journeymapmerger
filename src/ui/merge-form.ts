/**
 * The merge form: two map pickers, who wins on overlap, merge with
 * progress and cancel, a size warning for browsers that build the file in
 * memory, and a result with keep-a-backup install steps. Thin shell over
 * the pipeline; every string plain and terse.
 *
 * Test hooks in the query string (harmless for users):
 *   ?save=download   skip the save dialog, use the in-memory download path
 *   ?limit=<bytes>   override the size above which the in-memory path warns
 */
import { buildMergePlan } from '../merge/plan.ts';
import type { MergePlan, Priority } from '../merge/types.ts';
import { indexWorld } from '../merge/world-index.ts';
import { CompositorPool } from '../workers/pool.ts';
import { executeMergePlan, type MergeResult } from '../workers/pipeline.ts';
import type { ArchiveEntry } from '../zip/reader.ts';
import { canStreamToDisk, pickSaveTarget, type SaveTarget } from '../zip/save.ts';
import { ArchiveWriter } from '../zip/writer.ts';
import { el } from './dom.ts';
import { formatBytes, formatInt } from './format.ts';
import { renderInstructions } from './instructions.ts';
import { createMapPicker } from './map-picker.ts';

const DEFAULT_IN_MEMORY_WARN_BYTES = 1e9;

export function mountMergeForm(container: HTMLElement): void {
  const params = new URLSearchParams(location.search);
  const forceDownload = params.get('save') === 'download';
  const limitParam = Number(params.get('limit'));
  const warnAbove =
    Number.isFinite(limitParam) && limitParam > 0 ? limitParam : DEFAULT_IN_MEMORY_WARN_BYTES;

  const sideA = createMapPicker('a', 'Map A', 'The merged folder gets this map folder’s name.');
  const sideB = createMapPicker('b', 'Map B', 'The other map.');

  const priority = el('select', { id: 'priority', testId: 'priority' }, [
    el('option', { value: 'auto', textContent: 'The newer tile wins, by file date' }),
    el('option', { value: 'a', textContent: 'Map A wins' }),
    el('option', { value: 'b', textContent: 'Map B wins' }),
  ]);

  const mergeButton = el('button', { type: 'button', textContent: 'Merge', testId: 'merge' });
  const cancelButton = el('button', {
    type: 'button',
    textContent: 'Cancel',
    hidden: true,
    testId: 'cancel',
  });
  const progress = el('progress', { hidden: true, testId: 'progress' });
  const status = el('p', { className: 'status', testId: 'status' });
  status.setAttribute('role', 'status');

  const warningText = el('p');
  const continueButton = el('button', {
    type: 'button',
    textContent: 'Continue',
    testId: 'continue',
  });
  const backButton = el('button', { type: 'button', textContent: 'Back' });
  const warning = el('div', { className: 'warning', hidden: true, testId: 'warning' }, [
    warningText,
    el('p', {}, [continueButton, ' ', backButton]),
  ]);

  const summary = el('section', { className: 'summary', hidden: true, testId: 'summary' });

  let running = false;
  let controller: AbortController | null = null;

  const setStatus = (text: string): void => {
    status.textContent = text;
  };

  const ready = (): boolean =>
    Boolean(sideA.state.archive && sideA.state.chosen && sideB.state.archive && sideB.state.chosen);

  const refresh = (): void => {
    mergeButton.disabled = running || !ready();
    sideA.setDisabled(running);
    sideB.setDisabled(running);
    priority.disabled = running;
  };
  sideA.onChange(refresh);
  sideB.onChange(refresh);

  const hideWarning = (): void => {
    warning.hidden = true;
  };

  const buildPlan = (): MergePlan<ArchiveEntry> | null => {
    const { archive: a, chosen: rootA } = sideA.state;
    const { archive: b, chosen: rootB } = sideB.state;
    if (!a || !b || !rootA || !rootB) return null;
    return buildMergePlan(indexWorld(a.entries, rootA), indexWorld(b.entries, rootB), {
      priority: priority.value as Priority,
    });
  };

  const showSummary = (
    plan: MergePlan<ArchiveEntry>,
    result: MergeResult,
    fileName: string,
  ): void => {
    const { summary: s } = plan;
    const tiles = s.tilesCopied + s.tilesComposited;
    const root = plan.outputRoot;
    const lines: (Node | string)[] = [
      el('h2', { textContent: 'Done' }),
      el('p', {
        textContent:
          `Saved ${fileName}. ${formatInt(tiles)} tiles, ${formatInt(result.composited)} of them combined from both maps. ` +
          `${formatInt(s.waypoints)} waypoints. ${s.dims.length === 1 ? 'Dimension' : 'Dimensions'} ${s.dims.join(', ')}.`,
      }),
    ];
    if (result.compositeFailures.length > 0) {
      lines.push(
        el('p', {
          className: 'hint',
          textContent: `${formatInt(result.compositeFailures.length)} tiles could not be combined and were copied from the newer map.`,
        }),
      );
    }
    lines.push(
      el('h3', { textContent: 'Use it in the game' }),
      el('ol', {}, [
        el('li', { textContent: 'Quit Minecraft.' }),
        el('li', {
          textContent: `Open journeymap/data/mp/ and rename your current folder to keep it as a backup, for example ${root}-backup.`,
        }),
        el('li', {
          textContent: `Extract the zip into journeymap/data/mp/. The merged folder is named ${root}. If your own folder had a different name, rename the merged folder to match it.`,
        }),
        el('li', {
          textContent:
            'Start the game. If anything looks wrong, delete the merged folder and give the backup its old name back.',
        }),
      ]),
    );
    summary.replaceChildren(...lines);
    summary.hidden = false;
  };

  const runMerge = async (
    plan: MergePlan<ArchiveEntry>,
    target: SaveTarget,
    fileName: string,
  ): Promise<void> => {
    const { archive: a } = sideA.state;
    const { archive: b } = sideB.state;
    if (!a || !b) return;
    running = true;
    controller = new AbortController();
    refresh();
    summary.hidden = true;
    progress.max = plan.tasks.length;
    progress.value = 0;
    progress.hidden = false;
    cancelButton.hidden = false;
    setStatus(
      `Merging ${formatInt(plan.tasks.length)} entries, about ${formatBytes(plan.summary.estimatedOutputBytes)}.`,
    );

    const writer = new ArchiveWriter(target.writerTarget);
    const pool = new CompositorPool();
    let lastPaint = 0;
    try {
      const result = await executeMergePlan(plan, { a, b }, writer, {
        compositor: pool,
        signal: controller.signal,
        onProgress: (p) => {
          const now = performance.now();
          if (now - lastPaint > 100 || p.done === p.total) {
            lastPaint = now;
            progress.value = p.done;
            setStatus(`Merging ${formatInt(p.done)} of ${formatInt(p.total)} entries.`);
          }
        },
      });
      setStatus('Finishing the file.');
      const closed = await writer.close();
      await target.finish(closed);
      setStatus('');
      showSummary(plan, result, fileName);
    } catch (err) {
      await target.abort();
      if (err instanceof DOMException && err.name === 'AbortError') {
        setStatus('Cancelled. No file was saved.');
      } else {
        setStatus(
          `Merge failed. ${err instanceof Error ? err.message : String(err)} No file was saved.`,
        );
      }
    } finally {
      pool.dispose();
      running = false;
      controller = null;
      progress.hidden = true;
      cancelButton.hidden = true;
      refresh();
    }
  };

  const start = async (confirmedLarge: boolean): Promise<void> => {
    const plan = buildPlan();
    if (!plan || running) return;
    hideWarning();
    const fileName = `${plan.outputRoot}-merged.zip`;
    const inMemory = forceDownload || !canStreamToDisk();
    if (inMemory && !confirmedLarge && plan.summary.estimatedOutputBytes > warnAbove) {
      warningText.textContent =
        `This merge is about ${formatBytes(plan.summary.estimatedOutputBytes)}. ` +
        'Your browser builds the whole file in memory before saving it, which can fail above about 1 GB. ' +
        'Chrome and Edge save straight to disk instead. Use a normal window, not a private one. Continue anyway?';
      warning.hidden = false;
      return;
    }
    // The save dialog needs the click’s user activation: this is the first await.
    const target = await pickSaveTarget(fileName, { forceDownload });
    if (!target) {
      setStatus('Cancelled.');
      return;
    }
    await runMerge(plan, target, fileName);
  };

  mergeButton.addEventListener('click', () => {
    void start(false);
  });
  continueButton.addEventListener('click', () => {
    void start(true);
  });
  backButton.addEventListener('click', hideWarning);
  cancelButton.addEventListener('click', () => {
    controller?.abort();
  });

  const form = el('form', { className: 'merge-form' }, [
    renderInstructions(),
    sideA.element,
    sideB.element,
    el('p', {}, [
      el('label', { htmlFor: 'priority', textContent: 'Where both maps explored the same area ' }),
      priority,
    ]),
    el('p', { className: 'actions' }, [mergeButton, ' ', cancelButton]),
    warning,
    progress,
    status,
    summary,
  ]);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
  });
  container.append(form);
  refresh();
}
