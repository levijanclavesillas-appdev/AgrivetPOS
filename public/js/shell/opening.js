// The opening load, as one panel — FT-707, OPS-105 – OPS-107, and TASK-047.
//
// Mounted in two places: `SCR-706`, where an owner loads a store's data at any time, and
// the last step of `SCR-001`, where a store that has just been installed brings in what
// it already has. One panel rather than two, so the check, the report and the refusal
// read the same wherever the owner meets them — `data.js`'s own reasoning for making the
// opening load the import's shape again, carried one screen further.
//
// **The workbook is the way in; the CSV files are the way round.** The store downloads
// one `.xlsx` with a tab per list, fills it in, and sends it back as it is. Saving each
// tab as CSV is where a date becomes 31/03/2027 and a barcode loses its leading zero, so
// the separate files are offered under a disclosure for whoever already has them.
//
// **The conversation is the import's**: choose, check (writing nothing), read what would
// be refused and why, fix the spreadsheet, check again, and only then a button that
// writes. The report names **the tab and the row** — with eight tabs, "row 7" is eight
// rows.
//
// No toasts: the wizard has no toast host, and a message that belongs to this panel
// reads better beside it than in a corner of the screen.

import * as api from './api.js';
import { h, clear } from './ui.js';

/** `openingDataService.KINDS`, in its order — which is the load order. */
const KINDS = [
  { key: 'categories', sheet: 'Categories', note: 'How the shelves are grouped, and each one’s discount ceiling.' },
  { key: 'units', sheet: 'Units', note: 'What things are counted and sold in — TAB, BOX, ML.' },
  { key: 'brands', sheet: 'Brands', note: 'Optional.' },
  { key: 'suppliers', sheet: 'Suppliers', note: 'Who the stock came from. A batch names one (INV-202).' },
  { key: 'products', sheet: 'Products', note: 'SKU, name, category, base unit and retail price.' },
  { key: 'packs', sheet: 'Packs', note: 'A product sold in more than one size — 1 BOX = 100 TAB.' },
  { key: 'stock', sheet: 'Opening stock', note: 'How much is on hand, and what it cost (OPS-106).' },
  { key: 'balances', sheet: 'Credit balances', note: 'What each customer owed when the notebook was closed (OPS-107).' },
];

/** "Products, row 7: …" — the tab and the row first, because they are what the owner acts on. */
const where = (entry) => [entry.sheet, entry.line ? `row ${entry.line}` : null].filter(Boolean).join(', ');
const said = (entry) => (where(entry)
  ? `${where(entry)}: ${entry.message} (${entry.rule_id})`
  : `${entry.message} (${entry.rule_id})`);

/** A chosen file, as base64 — the upload is JSON (`05_TECH_SPEC.md` §4), not multipart. */
async function base64Of(chosen) {
  const bytes = new Uint8Array(await chosen.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * @param root     the element the panel owns
 * @param heading  the panel's title, or null where the page around it already has one
 * @param onLoaded called with the result once a load has landed
 */
export function createOpeningLoad({ root, heading = 'Load opening data', onLoaded = null }) {
  let busy = false;
  let doing = null;           // 'saving' | 'checking' | 'loading' — what `busy` is busy with
  let status = null;          // { kind: 'error' | 'success', text } — this panel's own message
  const opening = {
    workbook: null,           // { name, base64 }
    files: {},                // { products: { name, text }, … } — the CSV way round
    checked: null,            // the row-by-row report
    cutoverAt: '',
    result: null,
  };

  function render() {
    clear(root).append(h('section', { class: 'opening-load' }, [
      opening.result ? openingResultBlock() : openingBlock(),
    ]));
  }

  const say = (kind, text) => { status = text ? { kind, text } : null; };
  const failed = (err) => say('error', err.isRefusal && err.ruleId ? `${err.message} (${err.ruleId})` : err.message);

  // ── Choosing ────────────────────────────────────────────────────────────

  function openingBlock() {
    const chosen = Boolean(opening.workbook) || Object.keys(opening.files).length > 0;

    return h('div', { class: 'opening-block' }, [
      // Where the page around the panel has its own title, it has its own introduction too.
      heading ? h('h2', { text: heading }) : null,
      heading ? h('p', { class: 'muted', text:
        'Bring in what the store already has — its products, the stock on the shelf and what '
        + 'customers owe — from one Excel workbook, so the first day starts from what the '
        + 'notebook already says.' }) : null,

      h('ol', { class: 'opening-steps' }, [
        h('li', {}, [
          h('strong', { text: 'Start from the template' }),
          h('span', { class: 'muted', text:
            'One tab each for categories, units, brands, suppliers, products, packs, opening stock '
            + 'and credit balances. The Read me tab explains every column.' }),
          h('div', { class: 'opening-actions' }, [
            h('button', { type: 'button', icon: 'file-spreadsheet', text: 'Download the Excel template', disabled: busy, onclick: downloadWorkbook }),
          ]),
        ]),
        h('li', {}, [
          h('strong', { text: 'Choose the filled-in workbook' }),
          h('span', { class: 'muted', text: 'Save it as it is — Excel Workbook (.xlsx). There is no need to save each tab as CSV.' }),
          h('label', { class: 'opening-file' }, [
            h('input', {
              type: 'file', accept: '.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
              'aria-label': 'Filled-in workbook', disabled: busy,
              onchange: (event) => chooseWorkbook(event.target.files[0]),
            }),
          ]),
          opening.workbook ? h('small', { class: 'muted', text: `${opening.workbook.name} chosen` }) : null,
        ]),
        h('li', {}, [
          h('label', { class: 'opening-date' }, [
            h('strong', { text: 'Cutover date' }),
            h('input', {
              type: 'date', value: opening.cutoverAt,
              // OPS-107: the balances are dated at cutover — the day the notebook was
              // closed, which the owner chooses and which is usually not today. Changing
              // it re-checks nothing: it changes no row's validity, only the date the
              // accepted rows are written at.
              onchange: (event) => { opening.cutoverAt = event.target.value; },
            }),
            h('small', { class: 'muted', text: 'The day the notebook was closed. Opening balances and '
              + 'stock are dated here, so a statement reads from the beginning (OPS-107). Blank is today.' }),
          ]),
        ]),
      ]),

      csvBlock(),

      h('p', { class: 'warn', text:
        'Checking writes nothing, and can be done as many times as it takes. '
        + 'Loading takes a full backup first, then writes the whole workbook as one step — it '
        + 'either lands completely or not at all (OPS-103, OPS-105).' }),

      h('div', { class: 'opening-actions' }, [
        h('button', {
          type: 'button', class: 'primary', icon: 'list-checks', text: doing === 'checking' ? 'Checking…' : 'Check',
          disabled: busy || !chosen, 'aria-busy': busy ? 'true' : null,
          onclick: () => validateOpening(),
        }),
      ]),

      statusLine(),
      opening.checked ? openingSummaryBlock() : null,
    ]);
  }

  /** The three files the load took before the workbook — and now all eight. */
  function csvBlock() {
    return h('details', { class: 'opening-csv', open: Object.keys(opening.files).length > 0 ? true : null }, [
      h('summary', { text: 'Send CSV files instead' }),
      h('p', { class: 'muted', text:
        'For a store that already has its lists as CSV. Each file has the columns of its tab; send '
        + 'whichever you have. Choosing a CSV file sets the workbook aside, and choosing a workbook '
        + 'sets these aside.' }),
      h('div', { class: 'opening-csv-grid' }, KINDS.map((kind) => h('div', { class: 'opening-csv-kind' }, [
        h('strong', { text: kind.sheet }),
        h('small', { class: 'muted', text: kind.note }),
        h('input', {
          type: 'file', accept: '.csv,text/csv', 'aria-label': `${kind.sheet} CSV`, disabled: busy,
          onchange: (event) => chooseOpeningFile(kind.key, event.target.files[0]),
        }),
        opening.files[kind.key] ? h('small', { class: 'muted', text: `${opening.files[kind.key].name} chosen` }) : null,
        h('button', { type: 'button', class: 'row-action', icon: 'download', text: 'Template', disabled: busy, onclick: () => downloadTemplate(kind.key) }),
      ]))),
    ]);
  }

  function statusLine() {
    if (!status) return null;
    return h('p', {
      class: `opening-status ${status.kind}`,
      role: status.kind === 'error' ? 'alert' : 'status',
      text: status.text,
    });
  }

  async function save(path) {
    busy = true;
    doing = 'saving';
    render();
    try {
      const saved = api.saveAs(await api.download(path));
      say('success', `Saved ${saved}. Fill it in and choose it above.`);
    } catch (err) {
      failed(err);
    } finally {
      busy = false;
      doing = null;
      render();
    }
  }

  const downloadWorkbook = () => save('/data/opening/workbook');
  const downloadTemplate = (kind) => save(`/data/opening/template/${kind}`);

  /** Choosing a file drops the last report: it described a different spreadsheet. */
  async function chooseWorkbook(chosen) {
    opening.workbook = chosen ? { name: chosen.name, base64: await base64Of(chosen) } : null;
    if (chosen) opening.files = {};
    opening.checked = null;
    say(null);
    render();
  }

  /**
   * A chosen CSV, as text. Read here rather than posted as a file, because the server
   * parses RFC 4180 itself and a multipart upload would add a second way in.
   */
  async function chooseOpeningFile(kind, chosen) {
    if (!chosen) delete opening.files[kind];
    else opening.files[kind] = { name: chosen.name, text: await chosen.text() };
    opening.workbook = null;
    opening.checked = null;
    say(null);
    render();
  }

  const openingPayload = () => (opening.workbook
    ? { workbook: opening.workbook.base64 }
    : Object.fromEntries(KINDS.map((kind) => [kind.key, opening.files[kind.key] ? opening.files[kind.key].text : null])));

  // ── Checking ────────────────────────────────────────────────────────────

  /** `OPS-105` — every row of every tab checked, writing nothing. */
  async function validateOpening() {
    busy = true;
    doing = 'checking';
    say(null);
    render();
    try {
      opening.checked = await api.post('/data/opening/validate', openingPayload());
    } catch (err) {
      opening.checked = null;
      failed(err);
    } finally {
      busy = false;
      doing = null;
      render();
    }
  }

  /**
   * What would happen, row by row.
   *
   * Problems first, each with its tab and row, because an owner with a refused workbook is
   * going back to a spreadsheet and those are the only parts of this report they can act
   * on. The counts underneath are how much of the work is already right.
   */
  function openingSummaryBlock() {
    const report = opening.checked;
    const lines = Object.values(report.summary);

    return h('div', { class: 'opening-summary' }, [
      h('h3', { text: report.ok
        ? 'Ready to load'
        : `${plural(report.problems.length, 'row')} to fix before this can load` }),

      report.problems.length > 0
        ? h('ul', { class: 'opening-problems' }, report.problems.map((p) => h('li', { text: said(p) })))
        : null,

      report.warnings.length > 0
        ? h('details', { class: 'opening-warnings', open: report.ok ? true : null }, [
          h('summary', { text: `${plural(report.warnings.length, 'note')} — these load, and are worth reading` }),
          h('ul', {}, report.warnings.map((w) => h('li', { text: said(w) }))),
        ])
        : null,

      lines.length > 0
        ? h('div', { class: 'table-scroll' }, [
          h('table', { class: 'opening-table' }, [
            h('thead', {}, [h('tr', {}, [
              h('th', { text: 'Tab' }),
              h('th', { class: 'money', text: 'Rows' }),
              h('th', { class: 'money', text: 'Will load' }),
              h('th', { class: 'money', text: 'Rejected' }),
            ])]),
            h('tbody', {}, lines.map((line) => h('tr', { class: line.rejected > 0 ? 'is-rejected' : null }, [
              h('td', { text: line.label }),
              h('td', { class: 'money', text: String(line.rows) }),
              h('td', { class: 'money', text: String(line.accepted) }),
              h('td', { class: 'money', text: line.rejected > 0 ? String(line.rejected) : '' }),
            ]))),
          ]),
        ])
        : null,

      h('div', { class: 'opening-actions' }, [
        h('button', {
          type: 'button', class: 'danger', icon: 'upload', text: doing === 'loading' ? 'Loading…' : 'Load this data',
          // Requirement 7 in one expression: the load is unreachable until a check that
          // wrote nothing says every row is loadable.
          disabled: busy || !report.ok,
          'aria-busy': busy ? 'true' : null,
          onclick: () => runOpening(),
        }),
      ]),
    ]);
  }

  // ── Loading ─────────────────────────────────────────────────────────────

  async function runOpening() {
    busy = true;
    doing = 'loading';
    say(null);
    render();
    try {
      opening.result = await api.post('/data/opening', {
        ...openingPayload(),
        cutoverAt: opening.cutoverAt || null,
        reason: null,
      });
      if (onLoaded) onLoaded(opening.result);
    } catch (err) {
      failed(err);
    } finally {
      busy = false;
      doing = null;
      render();
    }
  }

  function openingResultBlock() {
    const done = opening.result;
    const reconciled = done.reconciliation.inventory_balances && done.reconciliation.credit_balances;
    const n = done.loaded;
    const landed = [
      [n.categories, 'category', 'categories'], [n.units, 'unit'], [n.brands, 'brand'],
      [n.suppliers, 'supplier'], [n.products, 'product'], [n.packs, 'pack'],
      [n.stock, 'opening stock row'], [n.customers, 'customer'], [n.balances, 'opening balance'],
    ].filter(([count]) => count > 0).map(([count, one, many]) => plural(count, one, many));

    return h('div', { class: 'opening-done' }, [
      heading ? h('h2', { text: 'Opening data loaded' }) : null,
      h('p', { class: 'opening-status success', text: landed.length > 0 ? `Loaded ${landed.join(', ')}.` : 'Nothing new to load.' }),

      // Requirement 8, as the sentence it was written as: somebody signing off a cutover
      // is not looking for `true`.
      h('p', { class: reconciled ? 'opening-status success' : 'warn', role: reconciled ? null : 'alert',
        text: done.reconciliation.statement }),

      h('p', { class: 'muted', text:
        `A full backup was taken before anything was written: ${done.pre_load_backup.file_name}. `
        + 'Restore it from Admin → Backups if this load was a mistake (OPS-103).' }),

      done.warnings.length > 0
        ? h('details', { class: 'opening-warnings' }, [
          h('summary', { text: plural(done.warnings.length, 'note') }),
          h('ul', {}, done.warnings.map((w) => h('li', { text: said(w) }))),
        ])
        : null,

      h('div', { class: 'opening-actions' }, [
        h('button', { type: 'button', icon: 'plus', text: 'Load more', onclick: reset }),
      ]),
    ]);
  }

  function reset() {
    opening.result = null;
    opening.workbook = null;
    opening.files = {};
    opening.checked = null;
    say(null);
    render();
  }

  return { mount: render, reset };
}
