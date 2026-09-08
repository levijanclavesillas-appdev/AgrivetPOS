// The renderer's entry point. Vanilla ES modules, no build step (05_TECH_SPEC.md §2):
// a store PC gets a folder that runs.

import { createApp } from './shell/app.js';

const root = document.querySelector('#app');

try {
  const app = createApp({ root });
  await app.mount();
} catch (err) {
  // 04_UX_SPEC.md §5: what failed and what to do, never a stack trace.
  root.innerHTML = '';
  const message = document.createElement('p');
  message.className = 'error';
  message.textContent = `The application did not start (${err.message}). `
    + 'Close it and start it again; if it keeps happening the database may be in use by another copy.';
  root.append(message);
}
