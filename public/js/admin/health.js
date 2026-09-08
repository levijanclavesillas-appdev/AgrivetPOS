// SCR-705 — the health panel.
//
// OPS-006's six figures and nothing else: database size, row counts, last successful
// backup, last export, last integrity check, and the schema version. A health panel
// that grows into a dashboard stops being read, and these six answer the only question
// it is for — is this installation still safe to trade on.
//
// It is the screen somebody opens *because* something is wrong, so a figure that
// cannot be read is shown as absent rather than taking the page down with it.

import * as api from '../shell/api.js';
import * as ui from '../shell/ui.js';
import { h, clear } from '../shell/ui.js';
import { manila } from '../shell/format.js';

export function createHealth({ root, session }) {
  async function load() {
    ui.loading(root, { rows: 5 });
    try {
      render(await api.get('/health/panel'));
    } catch (err) {
      if (err.isRefusal) ui.refused(root, err);
      else ui.error(root, { message: err.message, retry: load });
    }
  }

  function render(data) {
    clear(root).append(h('section', { class: 'admin health' }, [
      h('header', { class: 'admin-head' }, [
        h('h1', { text: 'Health' }),
        h('button', { text: 'Check the database now', onclick: check }),
      ]),
      problems(data),
      h('dl', { class: 'admin-meta health-figures' }, [
        // 1
        field('Schema version', data.schema.up_to_date
          ? `${data.schema.version}`
          : `${data.schema.version} — this build expects ${data.schema.binary_version}`),
        // 2
        field('Database size', data.database.size_display),
        // 4
        field('Last verified backup', data.backup.last_successful_at
          ? `${data.backup.last_successful_at_manila} — ${data.backup.last_successful_file}`
          : 'Never'),
        field('Backup folder', data.backup.folder || 'Not set'),
        // 5
        field('Last export', data.last_export_at ? manila(data.last_export_at) : 'Never'),
        // 6
        field('Last integrity check', data.last_integrity_check_at
          ? `${manila(data.last_integrity_check_at)} — ${data.last_integrity_check_ok ? 'sound' : 'FAILED'}`
          : 'Never'),
        field('Application version', data.app_version),
      ]),

      // 3 — the row counts, last because they are the longest and the least urgent.
      h('h2', { text: 'Rows' }),
      h('table', { class: 'row-counts' }, [
        h('tbody', {}, Object.entries(data.database.row_counts)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([table, count]) => h('tr', {}, [
            h('td', { text: table }),
            h('td', { class: 'money', text: String(count) }),
          ]))),
      ]),

      h('h2', { text: 'Storage settings' }),
      h('dl', { class: 'admin-meta' }, Object.entries(data.database.pragmas).map(
        ([name, value]) => field(name, String(value))
      )),
    ]));
  }

  /** The two conditions that make the rest of the panel urgent (OPS-007, OPS-009). */
  function problems(data) {
    const rows = [];
    if (data.backup.overdue) {
      rows.push([`No verified backup for ${data.backup.hours_since} hours. `
        + `The store's data is only as safe as its last backup.`, 'OPS-007']);
    }
    if (data.clock.anomaly) {
      rows.push([`This machine's clock is ${data.clock.behind_by_hours} hours behind the last `
        + 'recorded transaction. Selling is unaffected — receipt numbers do not come from the '
        + 'clock — but dates on new records will be wrong until it is fixed.', 'OPS-009']);
    }
    if (!data.schema.up_to_date) {
      rows.push(['The database is at an older schema than this build expects. '
        + 'Restart the application to run the pending migrations.', 'OPS-006']);
    }
    if (rows.length === 0) return null;

    return h('ul', { class: 'alerts' }, rows.map(([message, rule]) => h('li', {
      class: 'alert alert-critical', role: 'alert',
    }, [
      h('span', { class: 'alert-message', text: message }),
      h('span', { class: 'alert-rule', text: rule }),
    ])));
  }

  const field = (label, value) => h('div', { class: 'meta-field' }, [
    h('dt', { text: label }), h('dd', { text: value }),
  ]);

  async function check() {
    ui.toast('Checking the database…');
    try {
      const result = await api.post('/health/integrity-check', {});
      ui.toast(result.ok ? 'The database is sound.' : `Problems found: ${result.integrity}`,
        { kind: result.ok ? 'success' : 'error' });
    } catch (err) {
      ui.toast(err.message, { kind: 'error' });
    }
    load();
  }

  return { mount: load, unmount() {} };
}
