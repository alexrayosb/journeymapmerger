import './style.css';
import { renderShell } from './ui/shell.ts';

const root = document.getElementById('app');
if (!root) {
  throw new Error('missing #app root');
}
renderShell(root);
