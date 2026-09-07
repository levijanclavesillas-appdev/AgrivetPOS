// Vanilla ES module, no build step (05_TECH_SPEC.md §2). Server-side validation is
// authoritative; anything here is a courtesy (SEC-6).

const target = document.querySelector('#health');

const row = (label, value) => `<div class="row"><dt>${label}</dt><dd>${value}</dd></div>`;

try {
  const res = await fetch('/api/v1/health');
  if (!res.ok) throw new Error(`API answered ${res.status}`);
  const h = await res.json();

  const tables = Object.entries(h.database.row_counts)
    .map(([name, n]) => `${name} ${n}`)
    .join(' · ');

  target.innerHTML = `
    <dl>
      ${row('Application', h.app_version)}
      ${row('Schema version', `${h.schema.version} of ${h.schema.binary_version}`)}
      ${row('Database', `${(h.database.size_bytes / 1024).toFixed(1)} KB`)}
      ${row('Pragmas', Object.entries(h.database.pragmas).map(([k, v]) => `${k}=${v}`).join(' · '))}
      ${row('Tables', tables || 'none')}
    </dl>`;
} catch (err) {
  // 04_UX_SPEC.md §5: an error state says what failed and what to do, never a stack trace.
  target.innerHTML = `<p class="error">The local API did not answer (${err.message}).
    Close the application and start it again; if it keeps happening the database may be
    in use by another copy.</p>`;
}
