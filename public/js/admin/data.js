// SCR-706 — export and import. FT-705, FT-706.
//
// Two halves of one screen, and they are shaped very differently on purpose.
//
// **Export is one button.** There is nothing to configure — `OPS-101` says what an
// archive contains — so the screen's job is to hand over a file and say what is in it.
//
// **Import is a conversation, and `OPS-102` is why.** The operator chooses a file, the
// server validates the whole of it *writing nothing*, and the screen shows what would
// happen: how many rows, how many collide, what the one choice does to the overlap,
// and every problem found. Only then is there a button to run it. A single "import"
// button that validated and wrote in one call would put `OPS-102`'s "present a summary
// for confirmation" inside a spinner.
//
// The choice between skip, replace and abort is made **once, for the run** (`OPS-104`),
// and the screen re-validates whenever it changes — because what the choice does to the
// overlap is part of the summary, not a footnote to it.

import * as api from '../shell/api.js';
import * as ui from '../shell/ui.js';
import { h, clear } from '../shell/ui.js';
import { manila } from '../shell/format.js';

export function createData({ root, session }) {
  let file = null;            // { name, bytes, base64 }
  let checked = null;         // the validation report
  let mode = 'SKIP';
  let busy = false;
  let result = null;

  function mount() { render(); }

  function render() {
    clear(root).append(h('section', { class: 'data-transfer' }, [
      exportBlock(),
      h('hr'),
      result ? resultBlock() : importBlock(),
    ]));
  }

  // ── Export ────────────────────────────────────────────────────────────────

  function exportBlock() {
    return h('div', { class: 'export-block' }, [
      h('h2', { text: 'Export' }),
      h('p', { class: 'muted', text:
        'One archive holding every entity as its own readable JSON file, plus a manifest '
        + 'with the row counts and a checksum (OPS-101).' }),
      // SEC-1's consequence, said where somebody is about to make the file rather than
      // where they later try to use it.
      h('p', { class: 'muted', text:
        'Passwords and PINs are never exported. A store restored from this archive has its '
        + 'people but none of their credentials, and somebody must set a password for each '
        + 'before anybody can sign in.' }),
      h('div', { class: 'editor-actions' }, [
        h('button', {
          class: 'primary', text: 'Export everything', disabled: busy,
          onclick: () => runExport(),
        }),
      ]),
    ]);
  }

  async function runExport() {
    busy = true;
    render();
    try {
      // The same path the audit export already uses, so the browser saves a `.zip` the
      // way it saves any other file — and the name comes from the server's own
      // `content-disposition` rather than being rebuilt here.
      const saved = api.saveAs(await api.download('/data/export', { method: 'POST' }));
      ui.toast(`Exported as ${saved}. Keep it somewhere other than this machine.`, { kind: 'success' });
    } catch (err) {
      ui.toast(err.isRefusal ? `${err.message} (${err.ruleId})` : err.message, { kind: 'error' });
    } finally {
      busy = false;
      render();
    }
  }

  // ── Import ────────────────────────────────────────────────────────────────

  function importBlock() {
    return h('div', { class: 'import-block' }, [
      h('h2', { text: 'Import' }),
      h('p', { class: 'rule-note warn', role: 'alert', text:
        'An import writes another store’s data into this one. A full backup is taken first '
        + 'and the whole import runs as one transaction — it either lands completely or not '
        + 'at all (OPS-103).' }),

      h('div', { class: 'editor-field' }, [
        h('label', { text: 'Archive' }),
        h('input', {
          type: 'file', accept: '.zip,application/zip',
          onchange: (event) => chooseFile(event.target.files[0]),
        }),
        file ? h('small', { class: 'muted', text: `${file.name} — ${file.bytes} bytes` }) : null,
      ]),

      h('div', { class: 'editor-field' }, [
        h('label', { text: 'If a row is already here' }),
        h('select', {
          // OPS-104: one decision for the run. Changing it re-validates, because what
          // it does to the overlap is part of the summary the operator confirms.
          onchange: (event) => { mode = event.target.value; if (file) validate(); },
        }, [
          h('option', { value: 'SKIP', text: 'Keep what is here, skip the archive’s', selected: mode === 'SKIP' }),
          h('option', { value: 'REPLACE', text: 'Replace it with the archive’s', selected: mode === 'REPLACE' }),
          h('option', { value: 'ABORT', text: 'Do not import at all', selected: mode === 'ABORT' }),
        ]),
        h('small', { class: 'muted', text: 'This choice applies to the whole import, not row '
          + 'by row (OPS-104).' }),
      ]),

      checked ? summaryBlock() : null,
    ]);
  }

  async function chooseFile(chosen) {
    if (!chosen) { file = null; checked = null; render(); return; }
    const bytes = new Uint8Array(await chosen.arrayBuffer());
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    file = { name: chosen.name, bytes: bytes.length, base64: btoa(binary) };
    await validate();
  }

  /** `OPS-102` — the whole check, writing nothing. */
  async function validate() {
    busy = true;
    render();
    try {
      checked = await api.post('/data/import/validate', {
        archive: file.base64, collisionMode: mode,
      });
    } catch (err) {
      checked = null;
      ui.toast(err.isRefusal ? `${err.message} (${err.ruleId})` : err.message, { kind: 'error' });
    } finally {
      busy = false;
      render();
    }
  }

  /**
   * The summary `OPS-102` asks the operator to confirm.
   *
   * Problems first and in the error colour, because an archive that cannot be imported
   * is the answer — the row counts underneath it are context, not a decision.
   */
  function summaryBlock() {
    return h('div', { class: 'import-summary' }, [
      h('h3', { text: checked.ok ? 'Ready to import' : 'This archive cannot be imported' }),

      checked.manifest
        ? h('dl', { class: 'admin-meta' }, [
          metaField('From', checked.manifest.store_name || 'an unnamed store'),
          metaField('Exported', manila(checked.manifest.exported_at)),
          metaField('Schema', String(checked.manifest.schema_version)),
          metaField('Rows', String(checked.summary.total_rows)),
        ])
        : null,

      checked.problems.length > 0
        ? h('ul', { class: 'import-problems' }, checked.problems.map((p) => h('li', {
          text: `${p.message} (${p.rule_id})`,
        })))
        : null,

      checked.warnings.length > 0
        ? h('ul', { class: 'import-warnings' }, checked.warnings.map((w) => h('li', {
          text: `${w.message} (${w.rule_id})`,
        })))
        : null,

      // OPS-104's effect, in a sentence rather than as a number the operator has to
      // interpret against the mode they chose.
      h('p', { class: checked.summary.collisions > 0 ? 'rule-note warn' : 'muted',
        text: checked.summary.collision_effect }),

      h('div', { class: 'table-scroll' }, [
        h('table', { class: 'catalogue-list' }, [
          h('thead', {}, [h('tr', {}, [
            h('th', { text: 'Entity' }),
            h('th', { class: 'qty', text: 'In the archive' }),
            h('th', { class: 'qty', text: 'Here already' }),
            h('th', { class: 'qty', text: 'Colliding' }),
          ])]),
          h('tbody', {}, checked.summary.entities
            .filter((e) => e.rows > 0 || e.existing > 0)
            .map((e) => h('tr', { class: e.collisions > 0 ? 'is-colliding' : null }, [
              h('td', { text: e.table }),
              h('td', { class: 'qty', text: String(e.rows) }),
              h('td', { class: 'qty', text: String(e.existing) }),
              h('td', { class: 'qty', text: e.collisions > 0 ? String(e.collisions) : '' }),
            ]))),
        ]),
      ]),

      h('div', { class: 'editor-actions' }, [
        h('button', {
          class: 'danger', text: 'Import this archive',
          // Nothing runs until the validation pass says it may. The button is not
          // merely discouraged — OPS-102's confirmation is the thing it waits for.
          disabled: busy || !checked.ok,
          onclick: () => runImport(),
        }),
        h('button', { text: 'Choose another file', onclick: () => { file = null; checked = null; render(); } }),
      ]),
    ]);
  }

  async function runImport() {
    busy = true;
    render();
    try {
      result = await api.post('/data/import', {
        archive: file.base64, collisionMode: mode, reason: null,
      });
      ui.toast('Imported.', { kind: 'success' });
    } catch (err) {
      ui.toast(err.isRefusal ? `${err.message} (${err.ruleId})` : err.message, { kind: 'error' });
    } finally {
      busy = false;
      render();
    }
  }

  function resultBlock() {
    return h('div', { class: 'import-done' }, [
      h('h2', { text: 'Imported' }),
      h('p', { class: 'close-verdict balanced',
        text: `${result.rows_inserted} row(s) written, ${result.rows_skipped} skipped, `
          + `${result.rows_replaced} replaced.` }),

      // Named first and kept on screen: it is the thing the operator needs if this
      // turns out to have been wrong.
      h('p', { class: 'rule-note', text:
        `A full backup was taken before anything was written: ${result.pre_import_backup.file_name}. `
        + 'Restore it from the Backups tab if this import was a mistake (OPS-103).' }),

      result.warnings.length > 0
        ? h('ul', { class: 'import-warnings' }, result.warnings.map((w) => h('li', {
          text: `${w.message} (${w.rule_id})`,
        })))
        : null,

      h('div', { class: 'editor-actions' }, [
        h('button', {
          class: 'primary', text: 'Done',
          onclick: () => { result = null; file = null; checked = null; render(); },
        }),
      ]),
    ]);
  }

  const metaField = (label, value) => h('div', { class: 'meta-field' }, [
    h('dt', { text: label }), h('dd', { text: value }),
  ]);

  return { mount, unmount() {} };
}
