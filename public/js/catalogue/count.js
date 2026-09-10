// SCR-205 — the stocktake. FT-209.
//
// Two views in one screen: the list of counts, and the sheet for one of them. A count
// is a session that spans a lunch break, so the sheet saves as it goes and the list is
// where somebody comes back to what they left open.
//
// **The sentence this screen exists to prevent somebody misunderstanding** is on it
// twice, because it is the thing a store will otherwise report as a bug: the variance
// is measured against what the system held when the count was *opened*, not against
// stock now, and posting adjusts by the difference. Anything sold while the counting
// was going on stays sold. A shopkeeper who expects the count to "set" the shelf figure
// will look at the ledger afterwards and think the system has lost a sale.
//
// **A blank is not a zero**, and the sheet is built so that cannot be typed by
// accident. An empty field is "nobody reached this shelf" and writes nothing; a shelf
// that is genuinely empty is counted as `0`, which writes the whole quantity off. The
// two are shown differently, the counter is told the difference, and the posting
// preview names how many were left blank — because posting a half-finished count is the
// most expensive mistake available here.
//
// Every rule is the server's: the frozen expected quantity, whether the session is
// stale (INV-113), whether this user may approve it (INV-112), and what posting would
// write (INV-111). The screen renders those answers and computes nothing that a
// refusal could later disagree with.

import * as api from '../shell/api.js';
import * as ui from '../shell/ui.js';
import { h, clear } from '../shell/ui.js';
import { money, quantity, manila } from '../shell/format.js';

export function createStockCount({ root, session: user, countId = null, onBack }) {
  let list = null;
  let view = null;            // GET /stock-counts/:id
  let categories = [];
  let filter = '';            // free text over the sheet
  let showOnly = 'ALL';       // ALL | UNCOUNTED | VARYING
  let refusal = null;
  let approver = null;
  let posting = false;
  let result = null;

  const pending = new Map();  // productId -> the value being typed, before it is saved

  async function mount() {
    if (countId) return openCount(countId);
    return loadList();
  }

  // ── The list ──────────────────────────────────────────────────────────────

  async function loadList() {
    ui.loading(root, { rows: 5 });
    try {
      const [counts, cats] = await Promise.all([
        api.get('/stock-counts?limit=25'),
        api.get('/categories').catch(() => ({ categories: [] })),
      ]);
      list = counts;
      categories = cats.categories || [];
      renderList();
    } catch (err) {
      if (err.isRefusal) ui.refused(root, err);
      else ui.error(root, { message: err.message, retry: loadList });
    }
  }

  function renderList() {
    clear(root).append(h('section', { class: 'catalogue stock-counts' }, [
      h('header', { class: 'admin-head' }, [
        onBack ? h('button', { class: 'report-back', text: '← Products', onclick: () => onBack() }) : null,
        h('h1', { text: 'Stock counts' }),
      ]),

      // INV-110, stated where somebody is about to start one rather than after.
      h('p', { class: 'rule-note', text:
        'Opening a count freezes what the system currently believes is on every shelf in scope. '
        + 'Everything the count reports afterwards is measured against that moment, so the shop '
        + 'can keep trading while you walk the aisles (INV-110).' }),

      h('form', {
        class: 'editor-form count-open',
        onsubmit: (event) => { event.preventDefault(); openNew(event.target); },
      }, [
        h('div', { class: 'editor-row' }, [
          h('div', { class: 'editor-field' }, [
            h('label', { text: 'What to count' }),
            h('select', { name: 'scope' }, [
              h('option', { value: 'ALL', text: 'Every product' }),
              ...categories.map((c) => h('option', { value: c.id, text: c.name })),
            ]),
            h('small', { class: 'muted', text: 'A category at a time is the ordinary count; '
              + 'the whole shop is the annual one.' }),
          ]),
          h('div', { class: 'editor-field' }, [
            h('label', { text: 'Note' }),
            h('input', { type: 'text', name: 'notes', placeholder: 'Optional' }),
          ]),
        ]),
        h('div', { class: 'editor-actions' }, [
          h('button', { type: 'submit', class: 'primary', text: 'Open a count' }),
        ]),
      ]),

      listTable(),
    ]));
  }

  function listTable() {
    if (!list || list.stock_counts.length === 0) {
      return h('p', { class: 'muted', text: 'No counts yet.' });
    }
    return h('div', { class: 'table-scroll' }, [
      h('table', { class: 'catalogue-list count-list' }, [
        h('thead', {}, [h('tr', {}, [
          h('th', { text: 'Count' }),
          h('th', { text: 'Frozen at' }),
          h('th', { text: 'Scope' }),
          h('th', { class: 'qty', text: 'Counted' }),
          h('th', { class: 'qty', text: 'Varying' }),
          h('th', { text: 'Status' }),
          h('th', { text: '' }),
        ])]),
        h('tbody', {}, list.stock_counts.map((row) => h('tr', {
          class: row.stale && row.status !== 'POSTED' ? 'is-stale' : null,
        }, [
          h('td', { text: row.count_no }),
          // INV-110's instant, labelled as the thing everything is relative to.
          h('td', { text: manila(row.frozen_at) }),
          h('td', { text: row.category ? row.category.name : 'Every product' }),
          h('td', { class: 'qty', text: `${row.counted_count} of ${row.line_count}` }),
          h('td', { class: 'qty', text: String(row.varying_count) }),
          h('td', {}, [
            h('span', { class: `status status-${row.status.toLowerCase()}`, text: statusLabel(row) }),
            // INV-113, on the row rather than as a refusal at the end: a count that has
            // gone stale needs an owner, and that is a person somebody has to fetch.
            row.stale && row.status !== 'POSTED'
              ? h('small', { class: 'warn', text: `${row.days_open} days old — needs an owner (INV-113)` })
              : null,
          ]),
          h('td', {}, [h('button', {
            class: 'row-action',
            text: row.status === 'POSTED' ? 'View' : 'Open',
            onclick: () => openCount(row.id),
          })]),
        ]))),
      ]),
    ]);
  }

  const statusLabel = (row) => ({
    OPEN: 'Counting', APPROVED: 'Approved', POSTED: 'Posted', CANCELLED: 'Abandoned',
  }[row.status] || row.status);

  async function openNew(form) {
    const scope = form.scope.value;
    try {
      const created = await api.post('/stock-counts', {
        scope: scope === 'ALL' ? 'ALL' : 'CATEGORY',
        categoryId: scope === 'ALL' ? null : scope,
        notes: form.notes.value.trim() || null,
      });
      ui.toast(`${created.session.count_no} opened — ${created.session.line_count} products frozen.`,
        { kind: 'success' });
      openCount(created.session.id);
    } catch (err) {
      ui.toast(err.isRefusal ? `${err.message} (${err.ruleId})` : err.message, { kind: 'error' });
    }
  }

  // ── The sheet ─────────────────────────────────────────────────────────────

  async function openCount(id) {
    ui.loading(root, { rows: 6 });
    try {
      view = await api.get(`/stock-counts/${id}?limit=5000`);
      pending.clear();
      result = null;
      render();
    } catch (err) {
      if (err.isRefusal) ui.refused(root, err);
      else ui.error(root, { message: err.message, retry: () => openCount(id) });
    }
  }

  const visibleLines = () => {
    const term = filter.trim().toLowerCase();
    return view.lines.filter((line) => {
      if (showOnly === 'UNCOUNTED' && line.is_counted) return false;
      if (showOnly === 'VARYING' && !(line.is_counted && line.variance_milli !== 0)) return false;
      if (!term) return true;
      return `${line.sku} ${line.product_name}`.toLowerCase().includes(term);
    });
  };

  function render() {
    if (result) return renderPosted();

    const s = view.session;
    clear(root).append(h('section', { class: 'catalogue stock-count' }, [
      h('header', { class: 'admin-head' }, [
        h('button', { class: 'report-back', text: '← Counts', onclick: () => { view = null; loadList(); } }),
        h('h1', { text: s.count_no }),
      ]),

      h('dl', { class: 'admin-meta' }, [
        metaField('Frozen at', manila(s.frozen_at)),
        metaField('Scope', s.category ? s.category.name : 'Every product'),
        metaField('Counted by', s.opened_by),
        metaField('Status', statusLabel(s)),
      ]),

      // INV-110, in the words a shopkeeper would otherwise report as a bug.
      h('p', { class: 'rule-note', text: s.variance_basis }),

      s.stale && s.status !== 'POSTED'
        ? h('p', { class: 'rule-note warn', role: 'alert', text:
          `This count was opened ${s.days_open} days ago and the window is ${s.stale_days} days. `
          + 'What it froze is a measurement of then, and everything sold since is not shrinkage — '
          + 'an owner has to authorise posting it (INV-113).' })
        : null,

      s.is_editable ? sheetControls() : null,
      sheetTable(),
      h('div', { id: 'count-footer' }, [footer()]),
    ]));
  }

  function sheetControls() {
    return h('div', { class: 'editor-row count-controls' }, [
      h('div', { class: 'editor-field' }, [
        h('label', { text: 'Find a product' }),
        h('input', {
          type: 'search', value: filter, placeholder: 'Name or SKU',
          oninput: (event) => { filter = event.target.value; renderRows(); },
        }),
      ]),
      h('div', { class: 'editor-field' }, [
        h('label', { text: 'Show' }),
        h('select', {
          onchange: (event) => { showOnly = event.target.value; renderRows(); },
        }, [
          h('option', { value: 'ALL', text: 'Everything in scope', selected: showOnly === 'ALL' }),
          // The filter a counter actually uses at the end of a long shift.
          h('option', { value: 'UNCOUNTED', text: 'Not counted yet', selected: showOnly === 'UNCOUNTED' }),
          h('option', { value: 'VARYING', text: 'Different from expected', selected: showOnly === 'VARYING' }),
        ]),
      ]),
    ]);
  }

  function sheetTable() {
    return h('div', { class: 'table-scroll' }, [
      h('table', { class: 'catalogue-list count-sheet' }, [
        h('thead', {}, [h('tr', {}, [
          h('th', { text: 'Product' }),
          // Labelled "expected at freeze", never just "expected": the whole difficulty
          // of this screen is that the number is not what is on the shelf right now.
          h('th', { class: 'qty', text: 'Expected at freeze' }),
          h('th', { class: 'qty', text: 'Counted' }),
          h('th', { class: 'qty', text: 'Variance' }),
          h('th', { class: 'money', text: 'Value' }),
        ])]),
        h('tbody', { id: 'count-rows' }, visibleLines().map((line) => lineRow(line))),
      ]),
    ]);
  }

  function lineRow(line) {
    const editable = view.session.is_editable;
    return h('tr', { class: rowClass(line), 'data-product': line.product_id }, [
      h('td', {}, [
        h('span', { text: line.product_name }),
        h('small', { class: 'muted', text: line.sku }),
      ]),
      h('td', { class: 'qty', text: line.expected_display }),
      h('td', { class: 'qty' }, editable
        ? [
          h('input', {
            type: 'text', inputmode: 'decimal', class: 'qty count-input',
            value: line.is_counted ? String(line.counted_milli / 1000) : '',
            // A blank is not a zero, and the placeholder is where that is said on
            // every single row rather than once at the top where it is read once.
            placeholder: 'not counted',
            'aria-label': `Counted quantity of ${line.product_name}`,
            oninput: (event) => { pending.set(line.product_id, event.target.value); },
            onblur: (event) => save(line, event.target.value),
          }),
          h('span', { class: 'unit', text: line.base_unit_code }),
        ]
        : [h('span', { text: line.is_counted ? line.counted_display : '—' })]),
      h('td', { class: 'qty variance', text: line.is_counted ? line.variance_display : '' }),
      h('td', { class: 'money', text: line.is_counted ? money(line.variance_value_centavos) : '' }),
    ]);
  }

  /**
   * Three states, three treatments — and the third is the one that matters.
   *
   * Counted-and-matching is quiet, counted-and-varying is marked, and **not counted at
   * all** is marked differently again. A sheet that rendered a blank row like a
   * matching row is a sheet on which somebody posts a half-finished count.
   */
  function rowClass(line) {
    if (!line.is_counted) return 'is-uncounted';
    if (line.variance_milli === 0) return 'is-matched';
    return line.variance_milli < 0 ? 'is-short' : 'is-over';
  }

  /**
   * Save one line as the counter leaves the field.
   *
   * An empty field clears the line back to uncounted rather than storing a zero. That
   * is not a nicety: without it there would be no way back from a mis-key, and "blank
   * means zero" would become the only interpretation available.
   */
  async function save(line, raw) {
    const text = String(raw).trim();
    const countedMilli = text === '' ? null : Math.round(Number.parseFloat(text) * 1000);

    if (text !== '' && !Number.isFinite(countedMilli)) {
      ui.toast(`${line.product_name}: that is not a quantity.`, { kind: 'error' });
      return;
    }
    if (countedMilli !== null && countedMilli < 0) {
      ui.toast('A counted quantity is zero or more. An empty shelf is 0; a shelf nobody '
        + 'reached is left blank.', { kind: 'error' });
      return;
    }
    if (line.is_counted === (countedMilli !== null)
        && line.counted_milli === countedMilli) return;

    try {
      const updated = await api.put(`/stock-counts/${view.session.id}/lines`, {
        lines: [{ productId: line.product_id, countedMilli }],
      });
      view.session = updated.session;
      const fresh = await api.get(`/stock-counts/${view.session.id}?limit=5000`);
      view.lines = fresh.lines;
      pending.delete(line.product_id);
      refreshRow(line.product_id);
      refreshFooter();
    } catch (err) {
      ui.toast(err.isRefusal ? `${err.message} (${err.ruleId})` : err.message, { kind: 'error' });
    }
  }

  /** Repaint one row's derived cells without rebuilding the field under the cursor. */
  function refreshRow(productId) {
    const line = view.lines.find((l) => l.product_id === productId);
    const row = root.querySelector(`#count-rows tr[data-product="${productId}"]`);
    if (!line || !row) return;

    row.className = rowClass(line);
    const cells = row.querySelectorAll('td');
    cells[3].textContent = line.is_counted ? line.variance_display : '';
    cells[4].textContent = line.is_counted ? money(line.variance_value_centavos) : '';
  }

  function renderRows() {
    const host = root.querySelector('#count-rows');
    if (host) clear(host).append(...visibleLines().map((line) => lineRow(line)));
  }

  function refreshFooter() {
    const host = root.querySelector('#count-footer');
    if (host) clear(host).append(footer());
  }

  // ── Approve, and post ─────────────────────────────────────────────────────

  function footer() {
    const s = view.session;

    return h('div', { class: 'count-footer' }, [
      h('div', { class: 'count-progress' }, [
        h('strong', { text: `${s.counted_count} of ${s.line_count} counted` }),
        // The figure nobody should discover after posting. Stated while there is still
        // time to go and count them.
        s.uncounted_count > 0
          ? h('span', { class: 'warn', text: `${s.uncounted_count} not counted — those write nothing` })
          : h('span', { class: 'muted', text: 'every product in scope has a figure' }),
        h('span', { class: 'muted', text: `${s.varying_count} differ from the frozen figure` }),
      ]),

      s.status === 'OPEN' ? approveBlock() : null,
      s.status === 'APPROVED' ? postBlock() : null,
      s.status === 'POSTED' ? postedSummary() : null,
    ]);
  }

  function approveBlock() {
    const s = view.session;
    const isCounter = s.opened_by === user.username;

    return h('div', { class: 'count-actions' }, [
      // INV-112, explained before it refuses. The counter needs to know they have to
      // fetch somebody, and needs to know it before they have finished counting.
      h('p', { class: 'rule-note', text: isCounter
        ? 'You took this count, so somebody else has to approve it before it can be posted. A '
          + 'stocktake is where shrinkage is written off, and one person doing both is the shape '
          + 'of the problem (INV-112).'
        : `${s.opened_by} took this count, so you may approve it.` }),
      h('div', { class: 'editor-actions' }, [
        h('button', { class: 'primary', text: 'Approve this count', onclick: approve }),
        h('button', { text: 'Abandon', onclick: abandon }),
      ]),
    ]);
  }

  function postBlock() {
    const s = view.session;
    return h('div', { class: 'count-actions' }, [
      h('p', { class: 'rule-note', text: s.approval_waived
        ? 'Approved with no second user available — this store has one active account, so '
          + 'INV-112’s second pair of eyes could not be obtained. The trail says so.'
        : `Approved by ${s.approved_by}.` }),
      h('p', { class: 'rule-note warn', role: 'alert', text:
        `Posting writes one movement for each of the ${s.varying_count} products that differ, and `
        + `nothing for the ${s.counted_count - s.varying_count} that matched or the `
        + `${s.uncounted_count} nobody counted (INV-111).` }),

      h('div', { id: 'count-authorisation' }, [refusal ? authorisation() : null]),

      h('div', { class: 'editor-actions' }, [
        h('button', {
          class: 'primary', text: 'Post the count',
          disabled: posting || (Boolean(refusal) && !approver),
          onclick: post,
        }),
        h('button', { text: 'Abandon', onclick: abandon }),
      ]),
    ]);
  }

  function postedSummary() {
    const s = view.session;
    return h('div', { class: 'count-actions' }, [
      h('p', { class: 'close-verdict balanced', text: `${s.count_no} posted.` }),
      h('p', { class: 'muted', text: `${s.varying_products} product(s) adjusted, worth `
        + `${money(s.variance_value_centavos)}. ${s.counted_products - s.varying_products} matched.` }),
      s.was_stale
        ? h('p', { class: 'muted', text: `Posted beyond the window, authorised by ${s.stale_approved_by}.` })
        : null,
      h('p', { class: 'muted', text: 'A posted count cannot be changed. Correct it with an '
        + 'adjustment citing this number (INV-102).' }),
    ]);
  }

  async function approve() {
    try {
      const approved = await api.post(`/stock-counts/${view.session.id}/approve`, {});
      view.session = approved.session;
      ui.toast(approved.approval.waived
        ? approved.approval.message
        : `Approved by ${approved.session.approved_by}.`, { kind: 'success' });
      render();
    } catch (err) {
      ui.toast(err.isRefusal ? `${err.message} (${err.ruleId})` : err.message, { kind: 'error' });
    }
  }

  async function post() {
    if (posting) return;
    posting = true;
    try {
      result = await api.post(`/stock-counts/${view.session.id}/post`, {
        approver: approver ? { username: approver.username } : null,
        reason: `Stock count ${view.session.count_no}`,
      });
      render();
    } catch (err) {
      // INV-113 comes back naming the rule and the role, and opens the panel. It is
      // not pre-judged here: the window is a setting and the age is the server's.
      if (err.isRefusal && err.ruleId === 'INV-113' && err.requiresRole) {
        refusal = err;
        render();
        queueMicrotask(() => root.querySelector('.authorisation input')?.focus());
        return;
      }
      ui.toast(err.isRefusal ? `${err.message} (${err.ruleId})` : err.message, { kind: 'error' });
    } finally {
      posting = false;
    }
  }

  /** AUD-603's shape: the owner authenticates as themselves, and both actors are kept. */
  function authorisation() {
    return ui.authorisationPanel({
      message: refusal.message,
      ruleId: refusal.ruleId,
      requiresRole: refusal.requiresRole,
      onApprove: async ({ username, password }) => {
        const auth = await api.post('/auth/login', { username, password });
        approver = auth.user;
        ui.toast(`${approver.username} authorised posting this count`, { kind: 'success' });
        render();
      },
      onCancel: () => { refusal = null; approver = null; render(); },
    });
  }

  async function abandon() {
    // ui.ask, not window.prompt — Electron throws on prompt, so this button did
    // nothing at all in the packaged app and a count could not be abandoned.
    const answers = await ui.ask({
      title: 'Abandon this count',
      message: 'The sheet is kept and the reason goes on the trail. Nothing is posted.',
      fields: [{ name: 'reason', label: 'Why is this count being abandoned?', maxLength: 200 }],
      submitLabel: 'Abandon count',
    });
    if (!answers || !answers.reason) return;
    try {
      await api.post(`/stock-counts/${view.session.id}/cancel`, { reason: answers.reason });
      ui.toast('The count was abandoned, with the reason on the trail.', { kind: 'success' });
      view = null;
      loadList();
    } catch (err) {
      ui.toast(err.isRefusal ? `${err.message} (${err.ruleId})` : err.message, { kind: 'error' });
    }
  }

  function renderPosted() {
    const p = result.posting;
    clear(root).append(h('section', { class: 'catalogue stock-count count-done' }, [
      h('header', { class: 'admin-head' }, [h('h1', { text: `${result.session.count_no} posted` })]),

      h('p', { class: 'close-verdict balanced',
        text: `${p.varying_products} product(s) adjusted, worth ${money(p.variance_value_centavos)}.` }),

      // INV-111's three outcomes, each said out loud. "Nothing happened to 320
      // products" is the half a reader has to be able to check.
      h('ul', { class: 'count-outcome' }, [
        h('li', { text: `${p.matched_products} counted and correct — no movement written.` }),
        h('li', { text: `${p.varying_products} differed — one movement each.` }),
        p.uncounted_products > 0
          ? h('li', { class: 'warn', text: `${p.uncounted_products} were never counted — nothing `
            + 'was written for them, and they are unverified.' })
          : null,
      ]),

      // The sentence again, at the moment it matters most.
      h('p', { class: 'rule-note', text: result.session.variance_basis }),

      h('div', { class: 'editor-actions' }, [
        h('button', { class: 'primary', text: 'Back to counts', onclick: () => { result = null; view = null; loadList(); } }),
      ]),
    ]));
  }

  const metaField = (label, value) => h('div', { class: 'meta-field' }, [
    h('dt', { text: label }), h('dd', { text: value }),
  ]);

  return { mount, unmount() {} };
}
