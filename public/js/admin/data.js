// SCR-706 — export, import, and the opening-data load. FT-705, FT-706, FT-707.
//
// Three blocks on one screen, and they are shaped very differently on purpose.
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
//
// **The opening load is the import's shape again, and deliberately so** (`OPS-105`).
// An operator learns one screen: choose files, see what would be rejected and why, fix
// the spreadsheet, look again, and only then a button that writes. What differs is that
// the answer is *per row* — a rejected row is named with the line number the operator
// scrolls to in their own spreadsheet, because "3 rows are invalid" against a 500-row
// catalogue is not something anybody can act on.

import * as api from '../shell/api.js';
import * as ui from '../shell/ui.js';
import { h, clear } from '../shell/ui.js';
import { manila } from '../shell/format.js';

/** The three files `OPS-105` names, in the order a cutover fills them in. */
const OPENING_KINDS = [
  { key: 'products', label: 'Products', note: 'SKU, name, category, base unit and retail price.' },
  { key: 'stock', label: 'Opening stock', note: 'How much is on hand, and what it cost (OPS-106).' },
  { key: 'balances', label: 'Opening credit balances', note: 'What each customer owed when the notebook was closed (OPS-107).' },
];

export function createData({ root, session }) {
  let file = null;            // { name, bytes, base64 }
  let checked = null;         // the validation report
  let mode = 'SKIP';
  let busy = false;
  let result = null;

  // The opening load's own state, kept apart from the archive import's: the two halves
  // of the screen are separate conversations and neither should reset the other.
  const opening = {
    files: {},                // { products: { name, text }, … }
    checked: null,            // the row-by-row report
    cutoverAt: '',
    result: null,
  };

  function mount() { render(); }

  function render() {
    clear(root).append(h('section', { class: 'data-transfer' }, [
      exportBlock(),
      h('hr'),
      result ? resultBlock() : importBlock(),
      h('hr'),
      opening.result ? openingResultBlock() : openingBlock(),
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

  // ── Opening data (OPS-105 – OPS-107) ──────────────────────────────────────

  function openingBlock() {
    const chosen = OPENING_KINDS.filter((kind) => opening.files[kind.key]);

    return h('div', { class: 'opening-block' }, [
      h('h2', { text: 'Load opening data' }),
      h('p', { class: 'muted', text:
        'A store’s existing products, stock and credit balances, from three CSV files — so '
        + 'the first day starts from what the notebook already says. Send whichever files you '
        + 'have; they do not all have to arrive at once.' }),
      h('p', { class: 'rule-note warn', role: 'alert', text:
        'Every row is checked before anything is written, a full backup is taken first, and '
        + 'the whole load runs as one transaction — it either lands completely or not at all '
        + '(OPS-103, OPS-105).' }),

      // The templates. Named as the store would name the columns, and generated from
      // the validator's own list — so a template that fails its own validation is not
      // a state this screen can show somebody.
      h('div', { class: 'editor-field' }, [
        h('label', { text: 'Start from a template' }),
        h('div', { class: 'editor-actions' }, OPENING_KINDS.map((kind) => h('button', {
          text: kind.label, disabled: busy, onclick: () => downloadTemplate(kind.key),
        }))),
        h('small', { class: 'muted', text: 'Fill these in with a spreadsheet and send them back below.' }),
      ]),

      ...OPENING_KINDS.map((kind) => h('div', { class: 'editor-field' }, [
        h('label', { text: kind.label }),
        h('input', {
          type: 'file', accept: '.csv,text/csv',
          onchange: (event) => chooseOpeningFile(kind.key, event.target.files[0]),
        }),
        h('small', { class: 'muted', text: kind.note }),
        opening.files[kind.key]
          ? h('small', { class: 'muted', text: `${opening.files[kind.key].name} chosen` })
          : null,
      ])),

      h('div', { class: 'editor-field' }, [
        h('label', { text: 'Cutover date' }),
        h('input', {
          type: 'date', value: opening.cutoverAt,
          // OPS-107: the balances are dated at cutover — the day the notebook was
          // closed, which the owner chooses and which is usually not today. Changing
          // it re-checks nothing, because it changes no row's validity, only the date
          // the accepted rows are written at.
          onchange: (event) => { opening.cutoverAt = event.target.value; },
        }),
        h('small', { class: 'muted', text: 'The day the notebook was closed. Opening balances and '
          + 'stock are dated here, so a statement reads from the beginning (OPS-107).' }),
      ]),

      h('div', { class: 'editor-actions' }, [
        h('button', {
          class: 'primary', text: 'Check the files',
          disabled: busy || chosen.length === 0,
          onclick: () => validateOpening(),
        }),
      ]),

      opening.checked ? openingSummaryBlock() : null,
    ]);
  }

  async function downloadTemplate(kind) {
    busy = true;
    render();
    try {
      const saved = api.saveAs(await api.download(`/data/opening/template/${kind}`));
      ui.toast(`Saved ${saved}. Fill it in and send it back.`, { kind: 'success' });
    } catch (err) {
      ui.toast(err.isRefusal ? `${err.message} (${err.ruleId})` : err.message, { kind: 'error' });
    } finally {
      busy = false;
      render();
    }
  }

  /**
   * A chosen CSV, as text.
   *
   * Read here rather than posted as a file, because the server parses RFC 4180 itself
   * and a multipart upload would add a second way for these three files to arrive.
   * Choosing a file clears the last report: it described a different spreadsheet.
   */
  async function chooseOpeningFile(kind, chosen) {
    if (!chosen) delete opening.files[kind];
    else opening.files[kind] = { name: chosen.name, text: await chosen.text() };
    opening.checked = null;
    render();
  }

  const openingPayload = () => Object.fromEntries(
    OPENING_KINDS.map((kind) => [kind.key, opening.files[kind.key] ? opening.files[kind.key].text : null])
  );

  /** `OPS-105` — every row of every file checked, writing nothing. */
  async function validateOpening() {
    busy = true;
    render();
    try {
      opening.checked = await api.post('/data/opening/validate', openingPayload());
    } catch (err) {
      opening.checked = null;
      ui.toast(err.isRefusal ? `${err.message} (${err.ruleId})` : err.message, { kind: 'error' });
    } finally {
      busy = false;
      render();
    }
  }

  /**
   * What would happen, row by row.
   *
   * Problems first, each with its line number, because an owner with a rejected file is
   * going back to a spreadsheet and the line number is the only part of this screen
   * they can act on. The counts underneath are how much of the work is already right.
   */
  function openingSummaryBlock() {
    const report = opening.checked;

    return h('div', { class: 'opening-summary' }, [
      h('h3', { text: report.ok ? 'Ready to load' : 'These files cannot be loaded yet' }),

      report.problems.length > 0
        ? h('ul', { class: 'import-problems' }, report.problems.map((p) => h('li', {
          // The row number the operator scrolls to, first — OPS-105 asks for the
          // reason *with* the line, and a reason without one is not actionable.
          text: p.line ? `Row ${p.line}: ${p.message} (${p.rule_id})` : `${p.message} (${p.rule_id})`,
        })))
        : null,

      report.warnings.length > 0
        ? h('ul', { class: 'import-warnings' }, report.warnings.map((w) => h('li', {
          text: w.line ? `Row ${w.line}: ${w.message} (${w.rule_id})` : `${w.message} (${w.rule_id})`,
        })))
        : null,

      h('div', { class: 'table-scroll' }, [
        h('table', { class: 'catalogue-list' }, [
          h('thead', {}, [h('tr', {}, [
            h('th', { text: 'File' }),
            h('th', { class: 'qty', text: 'Rows' }),
            h('th', { class: 'qty', text: 'Will load' }),
            h('th', { class: 'qty', text: 'Rejected' }),
          ])]),
          h('tbody', {}, OPENING_KINDS
            .filter((kind) => report.summary[kind.key])
            .map((kind) => {
              const line = report.summary[kind.key];
              return h('tr', { class: line.rejected > 0 ? 'is-colliding' : null }, [
                h('td', { text: line.label }),
                h('td', { class: 'qty', text: String(line.rows) }),
                h('td', { class: 'qty', text: String(line.accepted) }),
                h('td', { class: 'qty', text: line.rejected > 0 ? String(line.rejected) : '' }),
              ]);
            })),
        ]),
      ]),

      h('div', { class: 'editor-actions' }, [
        h('button', {
          class: 'danger', text: 'Load this data',
          // Requirement 7 in one expression: the load is unreachable until a check
          // that wrote nothing says every row is loadable. Rehearsing costs nothing
          // and can be done as many times as the spreadsheet needs.
          disabled: busy || !report.ok,
          onclick: () => runOpening(),
        }),
        h('button', {
          text: 'Choose other files',
          onclick: () => { opening.files = {}; opening.checked = null; render(); },
        }),
      ]),
    ]);
  }

  async function runOpening() {
    busy = true;
    render();
    try {
      opening.result = await api.post('/data/opening', {
        ...openingPayload(),
        cutoverAt: opening.cutoverAt || null,
        reason: null,
      });
      ui.toast('Opening data loaded.', { kind: 'success' });
    } catch (err) {
      ui.toast(err.isRefusal ? `${err.message} (${err.ruleId})` : err.message, { kind: 'error' });
    } finally {
      busy = false;
      render();
    }
  }

  function openingResultBlock() {
    const done = opening.result;
    const reconciled = done.reconciliation.inventory_balances && done.reconciliation.credit_balances;

    return h('div', { class: 'opening-done' }, [
      h('h2', { text: 'Opening data loaded' }),
      h('p', { class: 'close-verdict balanced',
        text: `${done.loaded.products} product(s), ${done.loaded.stock} opening stock row(s), `
          + `${done.loaded.customers} customer(s) created and ${done.loaded.balances} opening `
          + 'balance(s).' }),

      // Requirement 8, as the sentence it was written as: somebody signing off a
      // cutover is not looking for `true`.
      h('p', { class: reconciled ? 'close-verdict balanced' : 'rule-note warn', role: reconciled ? null : 'alert',
        text: done.reconciliation.statement }),

      h('p', { class: 'rule-note', text:
        `A full backup was taken before anything was written: ${done.pre_load_backup.file_name}. `
        + 'Restore it from the Backups tab if this load was a mistake (OPS-103).' }),

      done.warnings.length > 0
        ? h('ul', { class: 'import-warnings' }, done.warnings.map((w) => h('li', {
          text: w.line ? `Row ${w.line}: ${w.message} (${w.rule_id})` : `${w.message} (${w.rule_id})`,
        })))
        : null,

      h('div', { class: 'editor-actions' }, [
        h('button', {
          class: 'primary', text: 'Done',
          onclick: () => { opening.result = null; opening.files = {}; opening.checked = null; render(); },
        }),
      ]),
    ]);
  }

  const metaField = (label, value) => h('div', { class: 'meta-field' }, [
    h('dt', { text: label }), h('dd', { text: value }),
  ]);

  return { mount, unmount() {} };
}
