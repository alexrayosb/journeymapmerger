import './style.css';
import { mountMergeForm } from './ui/merge-form.ts';
import { mountPreviewPanel } from './ui/preview/preview-panel.ts';
import { renderShell } from './ui/shell.ts';

const root = document.getElementById('app');
if (!root) {
  throw new Error('missing #app root');
}
const mounts = renderShell(root);
mountMergeForm(mounts.merge);
mountPreviewPanel(mounts.preview);
