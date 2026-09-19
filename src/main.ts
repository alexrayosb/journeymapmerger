import './style.css';
import { mountMergeForm } from './ui/merge-form.ts';
import { renderShell } from './ui/shell.ts';

const root = document.getElementById('app');
if (!root) {
  throw new Error('missing #app root');
}
mountMergeForm(renderShell(root));
